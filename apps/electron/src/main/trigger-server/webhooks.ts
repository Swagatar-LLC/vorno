/**
 * Embedded webhook composition — fork(PLAN-014)
 *
 * Composes the SAME two host-agnostic pieces the standalone Bun host uses
 * (`@craft-agent/shared/automations`) — differing ONLY in the injected executors
 * (PLAN-014 §5(2)):
 *
 *  1. {@link createWebhookDispatcher} bound to the DESKTOP executors
 *     ({@link createDesktopWebhookExecutors}) — verified deliveries run the same
 *     matcher / condition / label / permission-mode pipeline as cron automations,
 *     but land as LIVE sessions in the running app via `SessionManager`.
 *  2. {@link initWebhooks} — the runtime-neutral receiver, emitting through the
 *     dispatcher. Its `handle` is passed into `createTriggerServer` by the
 *     supervisor so the pre-auth `POST /hooks/...` route is served by the
 *     EMBEDDED trigger server (closing LEARNING-018).
 */

import {
  createWebhookDispatcher,
  initWebhooks,
  type WebhookDispatch,
  type WebhooksHandle,
} from '@craft-agent/shared/automations'
import { createDesktopWebhookExecutors, type WebhookSessionManager } from './webhook-executors'

export interface EmbeddedWebhooks {
  /** The receiver handle — pass to `createTriggerServer({ webhooks })`. */
  handle: WebhooksHandle
  /** Bound dispatch — assign to `HostBridge.onWebhookEvent`. */
  dispatch: WebhookDispatch
  /** Tear down the receiver + per-workspace AutomationSystems. */
  dispose(): Promise<void>
}

/**
 * Build the embedded webhook stack around the live desktop `SessionManager`.
 * Constructed ONCE at app bootstrap; the same `handle` is threaded into every
 * `createTriggerServer` construction (start/stop cycles reuse it), and `dispose`
 * is called on app teardown.
 */
export function createEmbeddedWebhooks(sm: WebhookSessionManager): EmbeddedWebhooks {
  const dispatcher = createWebhookDispatcher(createDesktopWebhookExecutors(sm))
  const handle = initWebhooks(dispatcher.dispatch)
  return {
    handle,
    dispatch: dispatcher.dispatch,
    dispose: async () => {
      await handle.dispose()
      await dispatcher.dispose()
    },
  }
}
