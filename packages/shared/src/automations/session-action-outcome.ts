/**
 * The session-action history outcome vocabulary — one producer, three hosts.
 *
 * fork(PLAN-030) Phase 2a. Three executors write session-action history records
 * (`SessionManager`'s app-event executor, the desktop webhook executor in
 * `apps/electron/src/main/trigger-server/webhook-executors.ts`, and the standalone one in
 * `apps/server/src/webhooks/executors.ts`) and until now each spelled the outcome strings
 * out inline. `checkStatusAction` was introduced precisely so two hosts could not drift on
 * what they record for the same rejection — but it only covered the two `rejected:*`
 * strings, leaving `set-status:<id>`, `set-labels`, `send-message`, `deferred:*` and
 * `error:*` as six more copies of the same literal per host.
 *
 * Drift here is silent in the worst way: the record is still written, still `ok: false`,
 * still in the file — it just no longer matches what the reader greps for, so a refusal
 * on one host reads as an unclassifiable entry on the other. Since operators diagnose
 * "why didn't my rule work?" from these strings, they are an interface. This module is
 * that interface's single definition.
 *
 * `skipped:<reason>` is the Phase 2a addition: an action refused by a Phase 0/1 guard
 * *before* execution, as distinct from `rejected:*` (reached the executor, refused there)
 * and `deferred:*` (admitted, not applicable here/now).
 */

import type { SessionActionSkipReason } from './causation.ts';

export const sessionActionOutcome = {
  setStatus: (status: string) => `set-status:${status}`,
  setLabels: 'set-labels',
  sendMessage: 'send-message',
  invalidStatus: (status: string) => `rejected:invalid-status:${status}`,
  closedStatus: (status: string) => `rejected:closed-status:${status}`,
  targetNotFound: 'deferred:target-not-found',
  hostUnreachable: 'deferred:host-unreachable',
  error: (message: string) => `error:${message}`,
  skipped: (reason: SessionActionSkipReason) => `skipped:${reason}`,
} as const;
