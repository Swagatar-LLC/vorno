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

/** Why a callback will not be delivered. `null` means deliver it. */
export type PageCallbackRefusalCode =
  | 'session-not-found'
  | 'session-closed'
  | 'session-busy'
  | 'cancelled';

/** The session facts this decision reads, and nothing more. */
export interface PageCallbackTargetState {
  workspace: { id: string; rootPath: string };
  isProcessing: boolean;
  isArchived?: boolean;
  sessionStatus?: string;
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
): PageCallbackRefusalCode | null {
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
  // decision cuts both ways.
  if (target.isArchived === true) return 'session-closed';
  if (
    target.sessionStatus !== undefined &&
    getStatusCategory(target.workspace.rootPath, target.sessionStatus) === 'closed'
  ) {
    return 'session-closed';
  }

  // Refuse rather than inherit `sendMessage`'s mid-stream behavior, which would
  // either interrupt the running turn or queue behind it. Both put a page's
  // text inside a turn the user is watching with no gesture of theirs between
  // the two; a user's own send deliberately keeps that behavior, a page does
  // not get it.
  if (target.isProcessing) return 'session-busy';

  return null;
}
