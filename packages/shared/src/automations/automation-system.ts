/**
 * AutomationSystem - Unified Facade for the Automations System
 *
 * Single entry point that:
 * - Creates EventBus instance (per workspace)
 * - Creates and registers all handlers
 * - Loads automations.json configuration
 * - Manages scheduler service
 * - Provides diffing for session metadata changes
 * - Provides dispose() for cleanup
 *
 * Benefits:
 * - No global state - each AutomationSystem instance is self-contained
 * - Easy to create for testing
 * - SessionManager uses ~30 lines instead of ~300
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';
import { compactAutomationHistorySync, appendAutomationHistoryEntry } from './history-store.ts';
import { detectMissedFires } from './missed-fire.ts';
import { runOnFailureActions } from './on-failure.ts';
import { AUTOMATIONS_HISTORY_FILE } from './constants.ts';
import { createLogger } from '../utils/debug.ts';
import { WorkspaceEventBus, type EventPayloadMap } from './event-bus.ts';
import { PromptHandler, EventLogHandler, WebhookHandler, type AutomationsConfigProvider } from './handlers/index.ts';
import { SessionActionHandler } from './handlers/session-action-handler.ts';
import { type AutomationsConfig, type AutomationEvent, type AutomationMatcher, type PendingPrompt, type PendingSessionAction, type WebhookActionResult, type AppEvent, type AgentEvent, type SdkAutomationCallbackMatcher, type SdkAutomationInput } from './types.ts';
import { validateAutomationsConfig, collectConfigDiagnostics, type ConfigDiagnostic } from './validation.ts';
import { KNOWN_ACTION_TYPES, VALID_EVENTS } from './schemas.ts';
import { createConfigDiagnosticHistoryEntry } from './webhook-utils.ts';
import { matcherMatchesSdk } from './utils.ts';
import { SchedulerService, type SchedulerTickPayload } from '../scheduler/scheduler-service.ts';

const log = createLogger('automation-system');

/**
 * fork(PLAN-017): workspaces whose missed-fire detection has already run this
 * process. Guards against re-scanning on every config reload (each reload
 * restarts nothing, but a defensive guard keeps detection one-shot per process
 * per workspace regardless of how startScheduler is reached).
 */
const missedFireDetectedWorkspaces = new Set<string>();

/**
 * fork(PLAN-030): one-line operator-facing description of a dead rule.
 * Names the offending value *and* the valid vocabulary — the missing vocabulary
 * is what produced the invented action types in the first place.
 */
function describeDiagnostic(id: string, event: string, reason: ConfigDiagnostic['reason'], detail: string): string {
  switch (reason) {
    case 'unknown-action-type':
      return `Automation "${id}" (${event}) will never run: unknown action type(s) ${detail}. `
        + `Valid types are: ${KNOWN_ACTION_TYPES.join(', ')}.`;
    case 'invalid-action-shape':
      return `Automation "${id}" (${event}) will never run: ${detail}.`;
    case 'unknown-event':
      return `Automation block "${event}" is discarded at load: not a known event. `
        + `Valid events are: ${VALID_EVENTS.join(', ')}.`;
  }
}

/** Test-only: reset the per-process missed-fire guard. */
export function __resetMissedFireGuardForTests(): void {
  missedFireDetectedWorkspaces.clear();
}

// Re-export SessionMetadataSnapshot from types (single source of truth)
export type { SessionMetadataSnapshot } from './types.ts';
import type { SessionMetadataSnapshot } from './types.ts';

// ============================================================================
// AutomationSystem Options
// ============================================================================

export interface AutomationSystemOptions {
  /** Workspace root path (where automations.json lives) */
  workspaceRootPath: string;
  /** Workspace ID for logging and events */
  workspaceId: string;
  /** Working directory for command execution */
  workingDir?: string;
  /** Active source slugs for permission rules */
  activeSourceSlugs?: string[];
  /** Whether to start the scheduler service (default: false) */
  enableScheduler?: boolean;
  /** Called when prompts are ready to be executed */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
  /**
   * fork(PLAN-014): called when session-mutation actions (set-status /
   * set-labels / send-message) are ready. The handler computes; the host
   * executes (resolves label→session, validates, writes to disk).
   */
  onSessionActions?: (actions: PendingSessionAction[]) => void;
  /** Called when webhook results are available */
  onWebhookResults?: (results: WebhookActionResult[]) => void;
  /** Called when an error occurs during automation execution */
  onError?: (event: AutomationEvent, error: Error) => void;
  /** Called when events are lost after retries */
  onEventLost?: (events: string[], error: Error) => void;
}

// ============================================================================
// AutomationSystem Implementation
// ============================================================================

export class AutomationSystem implements AutomationsConfigProvider {
  readonly eventBus: WorkspaceEventBus;

  private readonly options: AutomationSystemOptions;
  private config: AutomationsConfig | null = null;
  private promptHandler: PromptHandler | null = null;
  private webhookHandler: WebhookHandler | null = null;
  private sessionActionHandler: SessionActionHandler | null = null; // fork(PLAN-014)
  private eventLogHandler: EventLogHandler | null = null;
  private scheduler: SchedulerService | null = null;
  private disposed = false;
  /** fork(PLAN-030): last reported dead-rule set, to keep reload reports idempotent. */
  private lastDiagnosticsSignature: string | null = null;

  // Session metadata tracking (moved from SessionManager)
  private readonly lastKnownMetadata: Map<string, SessionMetadataSnapshot> = new Map();

  constructor(options: AutomationSystemOptions) {
    this.options = options;
    this.eventBus = new WorkspaceEventBus(options.workspaceId);

    // Load configuration
    this.loadConfig();

    // Create handlers
    this.createHandlers();

    // Start scheduler if enabled
    if (options.enableScheduler) {
      this.startScheduler();
    }

    log.debug(`[AutomationSystem] Created for workspace: ${options.workspaceId}`);
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Read, parse, and validate automations.json. Shared pipeline for loadConfig/reloadConfig.
   * Returns the raw parsed JSON alongside validation results (avoids re-reading for backfillIds).
   */
  private readAndValidateConfig(configPath: string): { raw: unknown; validation: import('./types.ts').AutomationsValidationResult } {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const validation = validateAutomationsConfig(raw);
    return { raw, validation };
  }

  /**
   * Load automations configuration from automations.json.
   */
  private loadConfig(): void {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);

    if (!existsSync(configPath)) {
      log.debug(`[AutomationSystem] No automations config found at ${configPath}`);
      this.config = { automations: {} };
      return;
    }

    try {
      const { raw, validation } = this.readAndValidateConfig(configPath);

      if (!validation.valid) {
        console.warn('[AutomationSystem] Invalid automations config:', validation.errors);
        this.config = { automations: {} };
        return;
      }

      this.config = validation.config;
      this.backfillIds(configPath, raw);
      this.rotateHistory();
      this.reportDeadMatchers(raw);
      const actionCount = this.getActionCount();
      log.debug(`[AutomationSystem] Loaded ${actionCount} actions from ${configPath}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';
      console.warn('[AutomationSystem] Failed to load automations config:', error);
      this.config = { automations: {} };
    }
  }

  /**
   * fork(PLAN-030): record rules that loaded but can never run.
   *
   * A matcher whose action type has no handler passes the schema (the
   * ActionDefinitionSchema catch-all cannot reject it) and then does nothing,
   * forever, with no history entry — indistinguishable from a rule that simply
   * hasn't been triggered yet. Same for an action whose type is real but whose
   * required fields are missing, and for a whole block filed under a typo'd
   * event name. Log each one and write a diagnostic so the failure is visible in
   * the surface operators actually check.
   *
   * Runs on load *and* on every reload. Reload is the path the config watcher
   * uses, which makes it the moment the diagnostic matters most: someone
   * hand-editing automations.json is actively looking for feedback, and a
   * report that only fires on a full app restart arrives far too late to be
   * connected to the edit that caused it.
   *
   * De-duplicated on the set of diagnostics, so a watcher that fires several
   * times for one save (or a reload that changes something unrelated) doesn't
   * append a new record each time. Startup always reports, since the signature
   * starts empty in a fresh process.
   *
   * Fail-soft: a diagnostic must never take down config loading.
   */
  private reportDeadMatchers(raw: unknown): void {
    let diagnostics: ConfigDiagnostic[];
    try {
      diagnostics = collectConfigDiagnostics(raw);
    } catch {
      return;
    }

    const signature = JSON.stringify(diagnostics);
    if (signature === this.lastDiagnosticsSignature) return;
    this.lastDiagnosticsSignature = signature;

    for (const { id, event, reason, detail } of diagnostics) {
      console.warn(`[AutomationSystem] ${describeDiagnostic(id, event, reason, detail)}`);
      void appendAutomationHistoryEntry(
        this.options.workspaceRootPath,
        createConfigDiagnosticHistoryEntry({ matcherId: id, event, reason, detail }),
      ).catch(() => {
        // History is best-effort — never fail a load on a logging error.
      });
    }
  }

  /**
   * Reload automations configuration.
   * Call this when automations.json changes.
   */
  reloadConfig(): { success: boolean; automationCount: number; errors: string[] } {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);

    if (!existsSync(configPath)) {
      this.config = { automations: {} };
      return { success: true, automationCount: 0, errors: [] };
    }

    try {
      const { raw, validation } = this.readAndValidateConfig(configPath);

      if (!validation.valid) {
        return { success: false, automationCount: 0, errors: validation.errors };
      }

      this.config = validation.config;
      this.backfillIds(configPath, raw);
      // fork(PLAN-030): the watcher-driven path — see reportDeadMatchers. A
      // rule that goes dead by hand-edit must be reported now, not on the next
      // full app restart.
      this.reportDeadMatchers(raw);
      const actionCount = this.getActionCount();
      log.debug(`[AutomationSystem] Reloaded ${actionCount} actions`);
      return { success: true, automationCount: actionCount, errors: [] };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';
      return { success: false, automationCount: 0, errors: [`Failed to parse JSON: ${error}`] };
    }
  }

  /**
   * Backfill missing IDs on matchers in the raw config.
   * Operates on the already-parsed raw JSON to avoid re-reading from disk.
   * Only writes if IDs were actually missing — no-op on subsequent loads.
   */
  private backfillIds(configPath: string, raw: unknown): void {
    try {
      const obj = raw as Record<string, unknown>;
      const eventMap = (obj.automations ?? obj.tasks ?? obj.hooks) as Record<string, unknown[]> | undefined;
      if (!eventMap) return;

      let changed = false;
      for (const matchers of Object.values(eventMap)) {
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers as Record<string, unknown>[]) {
          if (!m.id) { m.id = generateShortId(); changed = true; }
        }
      }

      if (changed) {
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
        log.debug('[AutomationSystem] Backfilled missing matcher IDs');
      }
    } catch {
      // Non-critical — IDs will be backfilled on next mutation via IPC
    }
  }

  /**
   * Compact automations-history.jsonl on startup: two-tier retention.
   * 1) Keep only the last N entries per automation ID.
   * 2) If total still exceeds the global cap, drop oldest globally.
   * Runs synchronously during init — single-threaded, no race with concurrent appends.
   */
  private rotateHistory(): void {
    try {
      compactAutomationHistorySync(this.options.workspaceRootPath);
    } catch {
      // Non-critical — compaction failure doesn't affect functionality
    }
  }

  /**
   * Get total number of actions.
   */
  private getActionCount(): number {
    if (!this.config) return 0;
    return Object.values(this.config.automations).reduce(
      (sum, matchers) => sum + (matchers?.reduce((s, m) => s + m.actions.length, 0) ?? 0),
      0
    );
  }

  // ============================================================================
  // AutomationsConfigProvider Implementation
  // ============================================================================

  getConfig(): AutomationsConfig | null {
    return this.config;
  }

  getMatchersForEvent(event: AutomationEvent): AutomationMatcher[] {
    return this.config?.automations[event] ?? [];
  }

  // ============================================================================
  // Handlers
  // ============================================================================

  /**
   * Create and register all handlers.
   */
  private createHandlers(): void {
    // Prompt handler
    this.promptHandler = new PromptHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onPromptsReady: this.options.onPromptsReady,
        onError: this.options.onError,
      },
      this
    );
    this.promptHandler.subscribe(this.eventBus);

    // Webhook handler
    this.webhookHandler = new WebhookHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onWebhookResults: this.options.onWebhookResults,
        onError: this.options.onError,
      },
      this
    );
    this.webhookHandler.subscribe(this.eventBus);

    // fork(PLAN-014): session-action handler (set-status / set-labels / send-message)
    this.sessionActionHandler = new SessionActionHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onSessionActions: this.options.onSessionActions,
        onError: this.options.onError,
      },
      this
    );
    this.sessionActionHandler.subscribe(this.eventBus);

    // Event log handler
    this.eventLogHandler = new EventLogHandler({
      workspaceRootPath: this.options.workspaceRootPath,
      workspaceId: this.options.workspaceId,
      onEventLost: this.options.onEventLost,
    });
    this.eventLogHandler.subscribe(this.eventBus);

    log.debug(`[AutomationSystem] Handlers created and subscribed`);
  }

  // ============================================================================
  // Scheduler
  // ============================================================================

  /**
   * Start the scheduler service.
   */
  private startScheduler(): void {
    if (this.scheduler) return;

    this.scheduler = new SchedulerService(async (payload: SchedulerTickPayload) => {
      await this.eventBus.emit('SchedulerTick', {
        workspaceId: this.options.workspaceId,
        timestamp: Date.now(),
        localTime: payload.localTime,
        utcTime: payload.timestamp,
      });
    });

    this.scheduler.start();
    log.debug(`[AutomationSystem] Scheduler started`);

    // fork(PLAN-017): detect missed cron fires once per process per workspace.
    // Fire-and-forget: never block scheduler startup; failures are logged.
    void this.runMissedFireDetection();
  }

  /**
   * fork(PLAN-017): read history, detect missed cron fires, append missed
   * records, and fire onFailure for each. Runs at most once per process per
   * workspace. Fully guarded — never throws into the startup path.
   */
  private async runMissedFireDetection(): Promise<void> {
    const workspaceRootPath = this.options.workspaceRootPath;
    if (missedFireDetectedWorkspaces.has(workspaceRootPath)) return;
    missedFireDetectedWorkspaces.add(workspaceRootPath);

    try {
      const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE);
      let historyLines: string[] = [];
      if (existsSync(historyPath)) {
        historyLines = readFileSync(historyPath, 'utf-8').split('\n');
      }

      const missed = detectMissedFires({
        config: this.config,
        historyLines,
        now: Date.now(),
      });
      if (missed.length === 0) return;

      log.debug(`[AutomationSystem] Detected ${missed.length} missed cron fire(s)`);

      for (const entry of missed) {
        try {
          await appendAutomationHistoryEntry(workspaceRootPath, entry);
        } catch (e) {
          log.debug(`[AutomationSystem] Failed to append missed record: ${e}`);
          continue;
        }
        // Fire onFailure for the matcher whose fire was missed.
        const matcherId = entry.id as string | undefined;
        const expectedTs = entry.expectedTs as number | undefined;
        if (matcherId) {
          this.fireOnFailureForMatcher(matcherId, { failureKind: 'missed', expectedTs });
        }
      }
    } catch (e) {
      log.debug(`[AutomationSystem] Missed-fire detection failed: ${e}`);
    }
  }

  /**
   * fork(PLAN-017): resolve a SchedulerTick matcher by id and run its onFailure
   * actions (prompt via the onPromptsReady callback with no matcherId — the
   * host's `!pending.matcherId` skip is the recursion guard; webhook via the
   * shared executor). No history records are written for onFailure runs.
   */
  private fireOnFailureForMatcher(
    matcherId: string,
    context: { failureKind: 'dispatch' | 'outcome' | 'missed'; expectedTs?: number; sessionId?: string; errorCount?: number; error?: string },
  ): void {
    const matcher = this.config?.automations.SchedulerTick?.find((m) => m.id === matcherId);
    if (!matcher?.onFailure || matcher.onFailure.length === 0) return;

    void runOnFailureActions({
      onFailure: matcher.onFailure,
      automationName: matcher.name,
      workspaceRootPath: this.options.workspaceRootPath,
      onPromptsReady: this.options.onPromptsReady,
      context: { automationId: matcherId, ...context },
    });
  }

  /**
   * Stop the scheduler service.
   */
  stopScheduler(): void {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      log.debug(`[AutomationSystem] Scheduler stopped`);
    }
  }

  // ============================================================================
  // Session Metadata Diffing
  // ============================================================================

  /**
   * Update session metadata and emit events for changes.
   *
   * This replaces the diffing logic that was in SessionManager.
   * Call this whenever session metadata changes.
   *
   * In practice there is exactly one caller: SessionManager's ConfigWatcher
   * `onSessionMetadataChange` callback, which hands us a header it just read off
   * disk. The mutators (`setSessionStatus`, `setSessionLabels`) do not call this —
   * they persist and let the watcher notice. That round trip is deliberate (it
   * makes externally-authored edits produce identical events), but it means the
   * emitted event carries no memory of *what caused* the change. See PLAN-030
   * Phase 1 before planning anything that needs that.
   *
   * @param sessionId - The session ID
   * @param next - The new metadata snapshot
   * @returns The events that were emitted
   */
  async updateSessionMetadata(
    sessionId: string,
    next: SessionMetadataSnapshot
  ): Promise<AppEvent[]> {
    const prev = this.lastKnownMetadata.get(sessionId) ?? {};
    const emittedEvents: AppEvent[] = [];
    const timestamp = Date.now();

    // Common fields for all events
    const sessionName = next.sessionName;
    const labels = next.labels ?? [];

    // Permission mode change
    if (prev.permissionMode !== next.permissionMode) {
      await this.eventBus.emit('PermissionModeChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        oldMode: prev.permissionMode ?? '',
        newMode: next.permissionMode ?? '',
      });
      emittedEvents.push('PermissionModeChange');
    }

    // Labels (array diff)
    const prevLabels = new Set(prev.labels ?? []);
    const nextLabels = new Set(next.labels ?? []);

    for (const label of nextLabels) {
      if (!prevLabels.has(label)) {
        await this.eventBus.emit('LabelAdd', {
          sessionId,
          sessionName,
          workspaceId: this.options.workspaceId,
          timestamp,
          labels: [...nextLabels],
          label,
        });
        emittedEvents.push('LabelAdd');
      }
    }

    for (const label of prevLabels) {
      if (!nextLabels.has(label)) {
        await this.eventBus.emit('LabelRemove', {
          sessionId,
          sessionName,
          workspaceId: this.options.workspaceId,
          timestamp,
          labels: [...nextLabels],
          label,
        });
        emittedEvents.push('LabelRemove');
      }
    }

    // Flag change
    const wasFlagged = prev.isFlagged ?? false;
    const isFlagged = next.isFlagged ?? false;
    if (wasFlagged !== isFlagged) {
      await this.eventBus.emit('FlagChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        isFlagged,
      });
      emittedEvents.push('FlagChange');
    }

    // Session status change
    if (prev.sessionStatus !== next.sessionStatus) {
      await this.eventBus.emit('SessionStatusChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        oldState: prev.sessionStatus ?? '',
        newState: next.sessionStatus ?? '',
      });
      emittedEvents.push('SessionStatusChange');
    }

    // Update stored metadata
    this.lastKnownMetadata.set(sessionId, { ...next });

    if (emittedEvents.length > 0) {
      log.debug(`[AutomationSystem] Emitted ${emittedEvents.length} events for session ${sessionId}: ${emittedEvents.join(', ')}`);
    }

    return emittedEvents;
  }

  /**
   * Remove session metadata tracking.
   * Call this when a session is deleted.
   */
  removeSessionMetadata(sessionId: string): void {
    this.lastKnownMetadata.delete(sessionId);
    log.debug(`[AutomationSystem] Removed metadata for session ${sessionId}`);
  }

  /**
   * Get stored metadata for a session.
   */
  getSessionMetadata(sessionId: string): SessionMetadataSnapshot | undefined {
    return this.lastKnownMetadata.get(sessionId);
  }

  /**
   * Set initial metadata for a session (without emitting events).
   * Call this when loading existing sessions.
   */
  setInitialSessionMetadata(sessionId: string, metadata: SessionMetadataSnapshot): void {
    this.lastKnownMetadata.set(sessionId, { ...metadata });
  }

  // ============================================================================
  // Direct Event Emission
  // ============================================================================

  /**
   * Emit a LabelConfigChange event.
   * Call this when labels/config.json changes.
   */
  async emitLabelConfigChange(): Promise<void> {
    await this.eventBus.emit('LabelConfigChange', {
      workspaceId: this.options.workspaceId,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit an event directly (for edge cases).
   */
  async emit<T extends AutomationEvent>(event: T, payload: EventPayloadMap[T]): Promise<void> {
    await this.eventBus.emit(event, payload);
  }

  // ============================================================================
  // Agent Event Execution (Backend-Agnostic)
  // ============================================================================

  /**
   * Execute agent event automations directly (without going through the Claude SDK).
   * This is the backend-agnostic entry point for non-Claude backends (Codex, Copilot, Pi)
   * to fire agent events from automations.json.
   *
   * For each matching automation matcher, builds env vars and evaluates matching.
   * Command execution has been removed — all automation actions now go through prompt-based
   * execution (creating agent sessions via PromptHandler).
   * Catches all errors — automations must never break the agent flow.
   *
   * @param signal - Optional AbortSignal for cancelling automation execution on abort
   * @returns Number of matched matchers (for diagnostics/testing)
   */
  async executeAgentEvent(event: AgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<number> {
    if (!this.config) return 0;

    const matchers = this.config.automations[event];
    if (!matchers?.length) return 0;

    let matchedCount = 0;

    for (const matcher of matchers) {
      if (!matcherMatchesSdk(matcher, event, input)) continue;

      matchedCount++;

      // Note: Command execution has been removed. Prompt-based execution for
      // non-Claude backends is not yet implemented. This method currently only
      // validates matching (including condition gating) — actual execution is a no-op.
      log.debug(`[AutomationSystem] Matched ${event} automation (prompt-based execution pending)`);
    }

    return matchedCount;
  }

  // ============================================================================
  // SDK Automation Integration
  // ============================================================================

  /**
   * Build SDK hook callbacks from automations.json definitions.
   *
   * Command execution has been removed — all automation actions now go through prompt-based
   * execution (creating agent sessions via PromptHandler). Agent event automations are not
   * currently supported via prompts, so this returns empty.
   */
  buildSdkHooks(): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> {
    return {};
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Check if the system has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Dispose the automation system, cleaning up all resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    log.debug(`[AutomationSystem] Disposing for workspace: ${this.options.workspaceId}`);

    // Stop scheduler
    this.stopScheduler();

    // Dispose handlers
    this.promptHandler?.dispose();
    this.webhookHandler?.dispose();
    this.sessionActionHandler?.dispose(); // fork(PLAN-014)
    await this.eventLogHandler?.dispose();

    // Dispose event bus
    this.eventBus.dispose();

    // Clear metadata
    this.lastKnownMetadata.clear();

    this.disposed = true;
    log.debug(`[AutomationSystem] Disposed`);
  }
}
