/**
 * Session-action pre-checks shared by every host that executes a `set-status` action.
 *
 * fork(PLAN-030). There are two hosts (the desktop webhook executor in
 * `apps/electron/src/main/trigger-server/webhook-executors.ts`, and SessionManager's own
 * app-event executor) and both must produce the *same* history outcome strings for the
 * same rejection. Two copies of this decision is exactly the validation/runtime drift
 * ADR-0021 §1 makes a point of avoiding, so it lives in one place.
 *
 * This is the **recording** gate, not the enforcing one. Enforcement lives at the single
 * choke point `SessionManager.setSessionStatus` (PLAN-031, ADR-0021 §2), which every
 * writer shares and which refuses a close the caller's declared origin doesn't permit.
 * The check here runs first only so the refusal can be named in history — a rejection
 * that reaches the choke point produces a log line, not a history record, and history is
 * where operators look.
 */

import { isValidStatusId, getStatusCategory } from '../statuses/storage.ts';

/** Why a `set-status` action will not be applied. `null` means "apply it". */
export type StatusActionRejection =
  | { reason: 'invalid-status'; outcome: string; note: string }
  | { reason: 'closed-status'; outcome: string; note: string };

/**
 * Decide whether a `set-status` action may be applied to a workspace.
 *
 * `allowClosed` is registration-time only — there is no runtime, prompt, or tool-mediated
 * path that sets it (ADR-0021 §2). An automation that did not declare it at registration
 * cannot close a session no matter which event carried it.
 */
export function checkStatusAction(
  workspaceRootPath: string,
  status: string,
  allowClosed: boolean | undefined,
): StatusActionRejection | null {
  if (!isValidStatusId(workspaceRootPath, status)) {
    return {
      reason: 'invalid-status',
      outcome: `rejected:invalid-status:${status}`,
      note: 'invalid-status',
    };
  }

  if (getStatusCategory(workspaceRootPath, status) === 'closed' && allowClosed !== true) {
    return {
      reason: 'closed-status',
      outcome: `rejected:closed-status:${status}`,
      note: 'closed-status-rejected',
    };
  }

  return null;
}
