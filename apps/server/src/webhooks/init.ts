/**
 * Webhook receiver bootstrap — fork(PLAN-014)
 *
 * Two host-side pieces that compose with the trigger-server core (ADR-0007):
 *
 *  1. {@link createWebhookDispatcher} — the standalone host's automation layer.
 *     Lazily constructs one `AutomationSystem` per target workspace (scheduler
 *     OFF) and binds `onPromptsReady` / `onSessionActions` to the standalone
 *     executors. Its `dispatch` is bound to the core `HostBridge.onWebhookEvent`
 *     seam by `index.ts` — so verified deliveries run through the SAME matcher /
 *     condition / label / permission-mode pipeline as cron-spawned automations,
 *     with no Electron host and no SessionManager dependency (PLAN-014 §5.1).
 *
 *  2. {@link initWebhooks} — the fork-owned, HTTP-agnostic receiver
 *     (`createWebhookReceiver`, packages/shared) wired to workspace resolution +
 *     hook loading, emitting through the injected `onWebhookEvent` (i.e. the
 *     dispatcher, via the HostBridge). Returns the handle the core router uses
 *     for the pre-auth `/hooks/...` route.
 *
 * index.ts touches this with exactly one `createWebhookDispatcher()` + one
 * `initWebhooks()` call, binding them through the core HostBridge.
 */

import { existsSync, readFileSync } from 'node:fs';
import { getWorkspaceByNameOrId, getWorkspaces } from '@craft-agent/shared/config';
import {
  AutomationSystem,
  createWebhookReceiver,
  resolveAutomationsConfigPath,
  validateAutomationsConfig,
  type AutomationMatcher,
  type ResolvedWorkspace,
  type WebhookReceiver,
  type WebhookRequest,
  type WebhookResult,
  type WebhookReceivedPayload,
} from '@craft-agent/shared/automations';
import { executeWebhookPrompt, executeWebhookSessionAction, type ExecResult } from './executors.ts';

/** The dispatch seam bound to `HostBridge.onWebhookEvent`. */
export type WebhookDispatch = (workspaceId: string, payload: WebhookReceivedPayload) => Promise<void>;

/** Read the WebhookReceived matchers for a workspace root (fresh each call). */
function readWebhookMatchers(rootPath: string): AutomationMatcher[] {
  const path = resolveAutomationsConfigPath(rootPath);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const validation = validateAutomationsConfig(raw);
    if (!validation.valid || !validation.config) return [];
    return validation.config.automations.WebhookReceived ?? [];
  } catch {
    return [];
  }
}

function resolveWorkspaceById(workspaceId: string): ResolvedWorkspace | null {
  const ws = getWorkspaceByNameOrId(workspaceId);
  return ws ? { workspaceId: ws.id, rootPath: ws.rootPath } : null;
}

/**
 * Routes verified webhook events into per-workspace AutomationSystems and awaits
 * the resulting executor work so the receiver can mark the durable queue entry
 * complete (or leave it for retry). Processing is serialized so the per-call
 * executor collector correlates unambiguously.
 */
class WebhookDispatcher {
  private readonly systems = new Map<string, AutomationSystem>();
  private mutex: Promise<void> = Promise.resolve();
  private activeCollector: Promise<ExecResult>[] | null = null;

  private getSystem(ws: ResolvedWorkspace): AutomationSystem {
    let system = this.systems.get(ws.workspaceId);
    if (!system) {
      system = new AutomationSystem({
        workspaceId: ws.workspaceId,
        workspaceRootPath: ws.rootPath,
        enableScheduler: false,
        onPromptsReady: (prompts) => {
          const collector = this.activeCollector;
          if (collector) for (const prompt of prompts) collector.push(executeWebhookPrompt(ws.rootPath, prompt));
        },
        onSessionActions: (actions) => {
          const collector = this.activeCollector;
          if (collector) for (const action of actions) collector.push(executeWebhookSessionAction(ws.rootPath, action));
        },
      });
      this.systems.set(ws.workspaceId, system);
    }
    return system;
  }

  dispatch = async (workspaceId: string, payload: WebhookReceivedPayload): Promise<void> => {
    const ws = resolveWorkspaceById(workspaceId);
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
 * Build the standalone webhook dispatcher (per-workspace AutomationSystem
 * registry). Its `dispatch` is what `index.ts` binds to
 * `HostBridge.onWebhookEvent` and what the receiver emits through.
 */
export function createWebhookDispatcher(): WebhookDispatcherHandle {
  const dispatcher = new WebhookDispatcher();
  return {
    dispatch: dispatcher.dispatch,
    dispose: () => dispatcher.dispose(),
  };
}

export interface WebhooksHandle {
  /** Handle a parsed hook request (called by the route adapter). */
  handle(req: WebhookRequest): Promise<WebhookResult>;
  /** Tear down the receiver. */
  dispose(): Promise<void>;
}

/**
 * Construct the webhook receiver around the injected `onWebhookEvent` seam (the
 * dispatcher, via `HostBridge.onWebhookEvent`), drain any deliveries left pending
 * by a prior crash, and start the periodic retry timer. Returns the handle the
 * core router uses for the pre-auth `/hooks/...` route.
 */
export function initWebhooks(onWebhookEvent: WebhookDispatch): WebhooksHandle {
  const receiver: WebhookReceiver = createWebhookReceiver({
    resolveWorkspace: resolveWorkspaceById,
    loadHooks: readWebhookMatchers,
    onWebhookEvent,
  });

  // Startup drain (restart durability) + periodic retry of failed deliveries.
  try {
    const workspaces: ResolvedWorkspace[] = getWorkspaces().map((w) => ({ workspaceId: w.id, rootPath: w.rootPath }));
    void receiver.drainPending(workspaces);
  } catch {
    // No workspaces / config yet — nothing to drain.
  }
  receiver.startRetryTimer();

  return {
    handle: (req) => receiver.handle(req),
    dispose: async () => {
      receiver.dispose();
    },
  };
}
