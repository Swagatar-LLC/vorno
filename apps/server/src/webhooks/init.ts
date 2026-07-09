/**
 * Standalone webhook bootstrap — fork(PLAN-014)
 *
 * Thin standalone (Bun host) wrapper over the host-agnostic composition that now
 * lives in `@craft-agent/shared/automations` (`webhook-ingest/dispatcher.ts` +
 * `webhook-ingest/host.ts`). The embedded Electron host composes the SAME two
 * pieces, differing only in the injected executors (PLAN-014 §5).
 *
 *  1. {@link createWebhookDispatcher} — binds the shared dispatcher to the
 *     standalone DISK-ONLY executors (`executeWebhookPrompt` /
 *     `executeWebhookSessionAction`). Its `dispatch` is bound to the core
 *     `HostBridge.onWebhookEvent` seam by `index.ts`.
 *  2. {@link initWebhooks} — re-exported verbatim from shared; the receiver is
 *     runtime-neutral and reads workspaces + `automations.json` through the
 *     shared config layer.
 *
 * index.ts touches this with exactly one `createWebhookDispatcher()` + one
 * `initWebhooks()` call, binding them through the core HostBridge — unchanged.
 */

import {
  createWebhookDispatcher as createSharedWebhookDispatcher,
  initWebhooks,
  type WebhookDispatch,
  type WebhookDispatcherHandle,
  type WebhooksHandle,
} from '@craft-agent/shared/automations';
import { executeWebhookPrompt, executeWebhookSessionAction } from './executors.ts';

export { initWebhooks };
export type { WebhookDispatch, WebhookDispatcherHandle, WebhooksHandle };

/**
 * Build the standalone webhook dispatcher — the shared per-workspace
 * AutomationSystem registry bound to the DISK-ONLY standalone executors. Its
 * `dispatch` is what `index.ts` binds to `HostBridge.onWebhookEvent` and what the
 * receiver emits through.
 */
export function createWebhookDispatcher(): WebhookDispatcherHandle {
  return createSharedWebhookDispatcher({
    executePrompt: (ws, prompt) => executeWebhookPrompt(ws.rootPath, prompt),
    executeSessionAction: (ws, action) => executeWebhookSessionAction(ws.rootPath, action),
  });
}
