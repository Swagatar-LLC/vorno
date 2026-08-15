/**
 * Session-action pre-checks shared by every host that executes a `set-status` or
 * `apply-context` action.
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
import { sessionActionOutcome } from './session-action-outcome.ts';
import { getContextProfile } from '../context-profiles/storage.ts';
import type { ContextProfile } from '../context-profiles/types.ts';
import { PERMISSION_MODE_ORDER, type PermissionMode } from '../agent/mode-types.ts';

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
      outcome: sessionActionOutcome.invalidStatus(status),
      note: 'invalid-status',
    };
  }

  if (getStatusCategory(workspaceRootPath, status) === 'closed' && allowClosed !== true) {
    return {
      reason: 'closed-status',
      outcome: sessionActionOutcome.closedStatus(status),
      note: 'closed-status-rejected',
    };
  }

  return null;
}

/**
 * How permissive each mode is. Derived from `PERMISSION_MODE_ORDER`
 * (`['safe', 'ask', 'allow-all']`), which is already ordered least → most permissive for
 * SHIFT+TAB cycling — reading the rank off it means a fourth mode cannot be added to the
 * product without also landing in this comparison.
 */
function permissiveness(mode: PermissionMode): number {
  return PERMISSION_MODE_ORDER.indexOf(mode);
}

/** Why an `apply-context` action will not be applied. `null` means "apply it". */
export type ContextActionRejection =
  | { reason: 'unknown-profile'; outcome: string; note: string }
  | { reason: 'permission-escalation'; outcome: string; note: string };

/** Either the profile to apply, or the reason it was refused. Never both. */
export type ContextActionDecision =
  | { rejection: ContextActionRejection; profile?: undefined }
  | { rejection: null; profile: ContextProfile };

/**
 * Decide whether an `apply-context` action may be applied to a session.
 *
 * Two refusals, and the second is the load-bearing one. A profile carries a permission
 * mode, so an automation that could freely raise it would let a label be a silent
 * privilege escalation: add `deploy` to a session and it lands in Execute.
 *
 * **Lowering is always allowed; raising requires `allowEscalation` on the profile.** The
 * asymmetry is the same one `allowClosed` encodes — the privileged direction needs a
 * declaration in reviewed config, and the safe direction needs nothing. A rule that
 * *restricts* an agent should never be the thing that fails closed.
 *
 * What this does **not** guard, because it structurally cannot become one: closing a
 * task. `apply-context` never touches status, and permission mode is not an input to
 * either closure gate — the PLAN-031 choke point refuses on the caller's declared
 * *origin* (`agent` never closes) and the MCP `set_session_status` handler refuses every
 * closed category unconditionally. Escalating a session to `allow-all` therefore buys an
 * agent nothing on the closure path; it is guarded here because unreviewed escalation is
 * bad on its own terms, not because it is a route to `done`.
 */
export function checkContextAction(
  workspaceRootPath: string,
  profileId: string,
  currentMode: PermissionMode | undefined,
): ContextActionDecision {
  const profile = getContextProfile(workspaceRootPath, profileId);
  if (!profile) {
    return {
      rejection: {
        reason: 'unknown-profile',
        outcome: sessionActionOutcome.unknownProfile(profileId),
        note: 'unknown-profile',
      },
    };
  }

  const target = profile.permissionMode;
  if (target !== undefined && profile.allowEscalation !== true) {
    // An unset session mode is `ask`, matching `setSessionPermissionMode`'s own default —
    // otherwise a fresh session would read as maximally restrictive and every profile
    // would look like an escalation.
    const from = currentMode ?? 'ask';
    if (permissiveness(target) > permissiveness(from)) {
      return {
        rejection: {
          reason: 'permission-escalation',
          outcome: sessionActionOutcome.permissionEscalation(target),
          note: 'permission-escalation-rejected',
        },
      };
    }
  }

  return { rejection: null, profile };
}
