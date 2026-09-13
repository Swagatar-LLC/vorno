/**
 * The one definition of "which session does this target name, in THIS workspace".
 *
 * fork(ADR-0033 §4, SUV-0064). Two hosts resolve a `SessionTargetSelector`
 * against a live `SessionManager`, and until now each did it inline. The
 * desktop webhook executor resolved an explicit `{ id }` by asking whether a
 * session with that id exists *anywhere the process has loaded* — a global map
 * keyed by id, with no workspace comparison — and then acted on it with the
 * calling workspace's root path. That is tolerable-looking for a webhook a
 * human registered, and it is a containment break for a Page, whose whole
 * privilege story is "this capability belongs to this workspace". So the rule
 * lives here and both callers ask it.
 *
 * **Containment is structural, not a check.** The lookup enumerates the
 * workspace's own sessions and matches inside that list; it never reaches a
 * by-id map and then compares. The difference matters because a comparison is
 * something a future edit can drop, while "the id was not in this workspace's
 * list" cannot be dropped without deleting the lookup itself.
 *
 * Pure apart from the injected lookup: no IO, no clock, no session loading.
 * `getSessions` is the metadata accessor, not `getSession`, which lazily reads
 * a whole transcript off disk to answer a question about identity.
 */

import type { SessionTargetSelector } from './types.ts';

/** The session facts a target resolution needs, and nothing more. */
export interface WorkspaceSessionSummary {
  id: string;
  /** Bare ids or `id::value` entries, matched exactly. */
  labels?: string[];
}

/**
 * What this needs from a `SessionManager`. Structural on purpose: `shared`
 * cannot import `server-core`, and a narrow shape is also what lets a test
 * state a workspace's sessions as a literal.
 */
export interface WorkspaceSessionLookup {
  /** Sessions in ONE workspace, most-recently-active first. */
  getSessions(workspaceId: string): WorkspaceSessionSummary[];
}

/**
 * Resolve a target selector to a session id contained by `workspaceId`, or null.
 *
 * `id` → that session, only if this workspace owns it. `label` → the most
 * recently active session in this workspace carrying that entry.
 *
 * A null return deliberately does not distinguish "no such session" from "that
 * session belongs to another workspace". The caller is asking about a workspace
 * it holds a capability for; telling it which of the two happened would let it
 * enumerate other workspaces' session ids one guess at a time.
 */
export function resolveWorkspaceSessionTarget(
  lookup: WorkspaceSessionLookup,
  workspaceId: string,
  target: SessionTargetSelector,
): string | null {
  // An empty workspace id would make `getSessions` return every session on some
  // implementations (the filter is conditional there), which is exactly the
  // containment break this module exists to close.
  if (!workspaceId) return null;
  const sessions = lookup.getSessions(workspaceId);

  if (target.id) {
    return sessions.some((session) => session.id === target.id) ? target.id : null;
  }
  if (target.label) {
    for (const session of sessions) {
      if ((session.labels ?? []).includes(target.label)) return session.id;
    }
  }
  return null;
}
