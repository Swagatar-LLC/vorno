/**
 * The refusal decision for a Page session callback (SUV-0064, ADR-0033 §4).
 *
 * Pure and synchronous **by contract, not by accident**. `SessionManager`
 * evaluates this as `sendMessage`'s `deliveryGuard`, at the one point where
 * session state has been settled by every await the send performs and nothing
 * yields before the message is committed. An `async` guard, or one that read
 * anything it had to wait for, would reintroduce exactly the window it exists
 * to close: a turn starting between the check and the commit, and a page's text
 * steered into it.
 *
 * Extracted the way `archive-guards.ts` is, for the same reason — the decision
 * is the interesting part and it should be readable and testable without
 * standing up a SessionManager.
 */

import { getStatusCategory } from '@craft-agent/shared/statuses/storage';
import type { PageSessionRefusalCode } from '@craft-agent/shared/pages';

/**
 * Why a callback will not be delivered. `null` means deliver it.
 *
 * Re-exported from the one definition in `@craft-agent/shared/pages` rather
 * than restated: the broker audits these values and the executor returns them,
 * so a second union here would be free to drift from the one they read.
 */
export type { PageSessionRefusalCode as PageCallbackRefusalCode };

/** The session facts this decision reads, and nothing more. */
export interface PageCallbackTargetState {
  workspace: { id: string; rootPath: string };
  isProcessing: boolean;
  isArchived?: boolean;
  sessionStatus?: string;
}

/** The lifecycle half of the state, which grant-time also has to read. */
export interface SessionLifecycleState {
  isArchived?: boolean;
  sessionStatus?: string;
}

/**
 * Whether this session is finished work — archived, or in a `closed`-category
 * status.
 *
 * Split out because **two** decisions need it and they are not the same
 * decision. Delivery asks it (below) to refuse a callback aimed at a session
 * that has since finished. Grant issuance asks it to refuse *approving* such a
 * callback at all: a user who approves while a dialog is open on a session that
 * got archived behind it has been handed a capability that can never fire, and
 * a capability that can never fire is worse than a refusal, because it looks
 * like it works.
 *
 * **`isProcessing` is deliberately NOT part of this.** Busy is a moment, not a
 * state: a session mid-turn now is an ordinary target in a minute, so refusing
 * to *grant* on it would make approval depend on timing the user cannot see and
 * did not choose. Finished is durable — nothing in the product un-archives or
 * re-opens a session on its own. So busy refuses at *delivery* only, which is
 * exactly where it is recoverable ("try again in a moment"), and finished
 * refuses at *both*.
 */
export function isSessionFinished(
  workspaceRootPath: string,
  state: SessionLifecycleState,
): boolean {
  if (state.isArchived === true) return true;
  return (
    state.sessionStatus !== undefined &&
    getStatusCategory(workspaceRootPath, state.sessionStatus) === 'closed'
  );
}

/**
 * Decide whether this callback may be delivered right now.
 *
 * Order is deliberate. Containment answers first, so a caller aimed at another
 * workspace learns nothing further. Withdrawal answers next, because a
 * cancelled action should not report the session's state at all. Then the two
 * lifecycle refusals, then busy.
 *
 * `cancelled` and `session-not-found` are both returned for states the caller
 * may already know about; `session-closed` and `session-busy` are the only ones
 * that disclose anything, and both are about a session the caller holds an
 * approved, user-consented grant for.
 */
export function pageCallbackRefusal(
  target: PageCallbackTargetState | undefined,
  workspaceId: string,
  aborted: boolean,
): PageSessionRefusalCode | null {
  // Containment re-proven against live state, however the caller resolved the
  // target earlier. A missing session and a foreign one answer identically so a
  // caller cannot enumerate other workspaces' session ids.
  if (!target || target.workspace.id !== workspaceId) return 'session-not-found';

  // Read as late as possible and as close to the commit as possible: this is
  // the check that makes a cancel, a lease release, or the broker's deadline
  // stop a delivery rather than merely race it.
  if (aborted) return 'cancelled';

  // Finished work. Delivering into it would re-open a session in the user's
  // inbox on a page's schedule — ADR-0021's rule that closure is the human's
  // decision cuts both ways. Same predicate grant issuance uses, so the two
  // cannot disagree about what "finished" means.
  if (isSessionFinished(target.workspace.rootPath, target)) return 'session-closed';

  // Refuse rather than inherit `sendMessage`'s mid-stream behavior, which would
  // either interrupt the running turn or queue behind it. Both put a page's
  // text inside a turn the user is watching with no gesture of theirs between
  // the two; a user's own send deliberately keeps that behavior, a page does
  // not get it.
  if (target.isProcessing) return 'session-busy';

  return null;
}
