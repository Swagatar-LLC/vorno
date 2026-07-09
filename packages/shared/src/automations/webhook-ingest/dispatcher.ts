/**
 * Webhook dispatcher — fork(PLAN-014), host-agnostic.
 *
 * Routes verified `WebhookReceived` deliveries into a per-workspace
 * {@link AutomationSystem} (scheduler OFF) so they run through the SAME matcher /
 * condition / label / permission-mode pipeline as cron-spawned automations, then
 * awaits the resulting executor work so the receiver can mark its durable queue
 * entry complete (or leave it for retry).
 *
 * The COMPOSITION lives here; the two hosts differ only in the injected
 * {@link WebhookDispatcherExecutors}:
 *  - Standalone (apps/server): disk-only executors (`createSession` /
 *    `setSessionStatus` / … against the shared on-disk session store).
 *  - Embedded (Electron main): desktop executors bound to the live
 *    `SessionManager` (`executePromptAutomation` → sessions appear LIVE in the
 *    running app, `setSessionStatus`/`setSessionLabels`/`sendMessage` reflect in
 *    the UI). PLAN-014 §5(2): the seam is frozen; only the bindings differ.
 *
 * Processing is serialized (a mutex) so the per-call executor collector
 * correlates unambiguously with a single `emit()`.
 */

import { getWorkspaceByNameOrId } from '../../config/storage.ts';
import { AutomationSystem } from '../automation-system.ts';
import type { PendingPrompt, PendingSessionAction } from '../types.ts';
import type { WebhookReceivedPayload } from '../event-bus.ts';
import type { ResolvedWorkspace } from './receiver.ts';

/**
 * Result contract shared by both hosts' executors. Drives durable retry:
 *   - ok:false → transient failure (fs / IPC error) → receiver keeps the entry
 *                and retries.
 *   - ok:true  → terminal outcome (success OR a logged validation rejection /
 *                deferred no-op) → the delivery is tombstoned, never retried.
 */
export interface ExecResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  /** Terminal non-success note (e.g. rejected / deferred) — not retried. */
  note?: string;
}

/** Execute a computed prompt automation for a webhook delivery. */
export type WebhookPromptExecutor = (ws: ResolvedWorkspace, prompt: PendingPrompt) => Promise<ExecResult>;
/** Execute a computed session action for a webhook delivery. */
export type WebhookSessionActionExecutor = (ws: ResolvedWorkspace, action: PendingSessionAction) => Promise<ExecResult>;

/** The host-specific execution bindings the dispatcher composes over. */
export interface WebhookDispatcherExecutors {
  executePrompt: WebhookPromptExecutor;
  executeSessionAction: WebhookSessionActionExecutor;
}

/** Optional dependency overrides (injection seam for tests). */
export interface WebhookDispatcherDeps {
  /** id/slug → workspace root, or null. Defaults to `getWorkspaceByNameOrId`. */
  resolveWorkspace?: (workspaceId: string) => ResolvedWorkspace | null;
}

/** The dispatch seam bound to `HostBridge.onWebhookEvent`. */
export type WebhookDispatch = (workspaceId: string, payload: WebhookReceivedPayload) => Promise<void>;

function defaultResolveWorkspace(workspaceId: string): ResolvedWorkspace | null {
  const ws = getWorkspaceByNameOrId(workspaceId);
  return ws ? { workspaceId: ws.id, rootPath: ws.rootPath } : null;
}

/**
 * Routes verified webhook events into per-workspace AutomationSystems and awaits
 * the resulting executor work. Serialized so the per-call executor collector
 * correlates unambiguously with a single `emit()`.
 */
class WebhookDispatcher {
  private readonly systems = new Map<string, AutomationSystem>();
  private mutex: Promise<void> = Promise.resolve();
  private activeCollector: Promise<ExecResult>[] | null = null;

  private readonly resolveWorkspace: (workspaceId: string) => ResolvedWorkspace | null;

  constructor(private readonly executors: WebhookDispatcherExecutors, deps: WebhookDispatcherDeps = {}) {
    this.resolveWorkspace = deps.resolveWorkspace ?? defaultResolveWorkspace;
  }

  private getSystem(ws: ResolvedWorkspace): AutomationSystem {
    let system = this.systems.get(ws.workspaceId);
    if (!system) {
      system = new AutomationSystem({
        workspaceId: ws.workspaceId,
        workspaceRootPath: ws.rootPath,
        enableScheduler: false,
        onPromptsReady: (prompts) => {
          const collector = this.activeCollector;
          if (collector) for (const prompt of prompts) collector.push(this.executors.executePrompt(ws, prompt));
        },
        onSessionActions: (actions) => {
          const collector = this.activeCollector;
          if (collector) for (const action of actions) collector.push(this.executors.executeSessionAction(ws, action));
        },
      });
      this.systems.set(ws.workspaceId, system);
    }
    return system;
  }

  dispatch = async (workspaceId: string, payload: WebhookReceivedPayload): Promise<void> => {
    const ws = this.resolveWorkspace(workspaceId);
    if (!ws) throw new Error(`workspace ${workspaceId} not found`);

    const run = this.mutex.then(async () => {
      const collected: Promise<ExecResult>[] = [];
      this.activeCollector = collected;
      try {
        const system = this.getSystem(ws);
        // Pick up token mints / matcher edits made since construction.
        system.reloadConfig();
        await system.emit('WebhookReceived', payload);
        const results = await Promise.all(collected);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          throw new Error(`executor failure: ${failed.map((f) => f.error ?? 'unknown').join('; ')}`);
        }
      } finally {
        this.activeCollector = null;
      }
    });
    // Keep the mutex chain alive regardless of this run's outcome.
    this.mutex = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  async dispose(): Promise<void> {
    for (const system of this.systems.values()) {
      try {
        await system.dispose();
      } catch {
        // best-effort teardown
      }
    }
    this.systems.clear();
  }
}

export interface WebhookDispatcherHandle {
  /** Bound dispatch — assign to `HostBridge.onWebhookEvent`. */
  dispatch: WebhookDispatch;
  dispose(): Promise<void>;
}

/**
 * Build a webhook dispatcher (per-workspace AutomationSystem registry) over the
 * given host executors. Its `dispatch` is what a host binds to
 * `HostBridge.onWebhookEvent` and what the receiver emits through.
 */
export function createWebhookDispatcher(
  executors: WebhookDispatcherExecutors,
  deps: WebhookDispatcherDeps = {},
): WebhookDispatcherHandle {
  const dispatcher = new WebhookDispatcher(executors, deps);
  return {
    dispatch: dispatcher.dispatch,
    dispose: () => dispatcher.dispose(),
  };
}
