/**
 * Webhook receiver bootstrap — fork(PLAN-014), host-agnostic.
 *
 * {@link initWebhooks} builds the fork-owned, HTTP-agnostic receiver
 * ({@link createWebhookReceiver}) wired to workspace resolution + hook loading,
 * emitting through the injected `onWebhookEvent` seam (the dispatcher, via the
 * trigger-server core's `HostBridge`). Returns the {@link WebhooksHandle} the
 * core router uses for the pre-auth `/hooks/...` route.
 *
 * Both hosts compose on this identical bootstrap — the standalone Bun host and
 * the embedded Electron host each pass their own `onWebhookEvent` (a dispatcher
 * bound to disk-only or desktop executors respectively). Nothing here assumes a
 * Bun or Electron runtime: it reads workspaces + `automations.json` through the
 * shared config layer only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { getWorkspaceByNameOrId, getWorkspaces } from '../../config/storage.ts';
import { resolveAutomationsConfigPath } from '../resolve-config-path.ts';
import { validateAutomationsConfig } from '../validation.ts';
import type { AutomationMatcher } from '../types.ts';
import { createWebhookReceiver, type WebhookReceiver, type WebhookRequest, type WebhookResult, type ResolvedWorkspace } from './receiver.ts';
import type { WebhookDispatch } from './dispatcher.ts';

/** Read the WebhookReceived matchers for a workspace root (fresh each call). */
export function readWebhookMatchers(rootPath: string): AutomationMatcher[] {
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

export function resolveWorkspaceById(workspaceId: string): ResolvedWorkspace | null {
  const ws = getWorkspaceByNameOrId(workspaceId);
  return ws ? { workspaceId: ws.id, rootPath: ws.rootPath } : null;
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
