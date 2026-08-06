/**
 * Status-change origin — who is asking, and may they close a session?
 *
 * PLAN-031 / ADR-0021. "Closing a task is the human's decision" was a real invariant enforced in
 * exactly one place: the agent-facing MCP tool handler. `SessionManager.setSessionStatus` — which
 * every other writer goes through, including the renderer's Kanban drag-drop — validated nothing
 * and wrote whatever string it was handed. The invariant was asserted in three places and enforced
 * in one.
 *
 * ADR-0021's thesis is that the trust boundary is **declared intent, not transport**. This type
 * makes the declaration explicit at the one choke point all writers share, so the rule is a system
 * property rather than a convention each caller has to remember.
 *
 * What this deliberately does NOT do: obstruct a human. Dragging a card into a closed column *is*
 * the declaration of intent — "when a task is done, it should be Done" — so `user` may close with
 * no confirmation prompt. The gate exists to classify the caller, not to add friction to the
 * product's primary way of closing a task.
 */

/**
 * Who initiated a status change.
 *
 * Ordered here from most to least authority over closure:
 *
 * - `user` — a human acting in the UI (Kanban drop, status menu, context menu). Declared intent
 *   by construction; may close.
 * - `host` — deterministic fork code with no model in the loop: TaskRunner's DAG completion, the
 *   mini-agent auto-complete path. A declarative task that ran to completion *is* declared intent;
 *   this is the bypass the MCP guard's own comment has always documented. May close.
 * - `automation` — a rule written into `automations.json` by a human and reviewed at registration
 *   time. May close **only** with `allowClosed: true`, preserving ADR-0021 §2 exactly.
 * - `agent` — a model mid-turn. May never close, on any event. Unchanged and unconditional.
 * - `unattributed` — a caller that did not say. May never close. This is the default precisely so
 *   that new code fails closed: forgetting the parameter costs you the ability to close a session,
 *   not the protection against doing so accidentally.
 */
export type StatusChangeOrigin =
  | { kind: 'user' }
  | { kind: 'host'; reason: string }
  | { kind: 'automation'; matcherId: string; allowClosed: boolean }
  | { kind: 'agent' }
  | { kind: 'unattributed' };

/** The origin assumed when a caller doesn't declare one. Cannot close. */
export const UNATTRIBUTED_ORIGIN: StatusChangeOrigin = { kind: 'unattributed' };

/** A human acting in the UI. */
export const USER_ORIGIN: StatusChangeOrigin = { kind: 'user' };

/** Deterministic host code (TaskRunner, mini-agent completion). `reason` is for the refusal log. */
export function hostOrigin(reason: string): StatusChangeOrigin {
  return { kind: 'host', reason };
}

/**
 * May this origin move a session into a `closed`-category status?
 *
 * Note this is only consulted for closed-category targets — every origin may set an open status.
 */
export function mayCloseSession(origin: StatusChangeOrigin): boolean {
  switch (origin.kind) {
    case 'user':
    case 'host':
      return true;
    case 'automation':
      return origin.allowClosed;
    case 'agent':
    case 'unattributed':
      return false;
  }
}

/** Human-readable description of an origin, for refusal logs and errors. */
export function describeOrigin(origin: StatusChangeOrigin): string {
  switch (origin.kind) {
    case 'user':
      return 'user (UI)';
    case 'host':
      return `host (${origin.reason})`;
    case 'automation':
      return `automation (matcher ${origin.matcherId}, allowClosed=${origin.allowClosed})`;
    case 'agent':
      return 'agent (model-mediated)';
    case 'unattributed':
      return 'unattributed caller';
  }
}
