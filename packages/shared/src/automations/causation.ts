/**
 * Automation causation — provenance and loop safety for session actions.
 *
 * fork(PLAN-030 Phase 1) / ADR-0021 §3.
 *
 * Session actions mutate session state, and session state changes emit events, so
 * `set-status` on `SessionStatusChange` and `set-labels` on `LabelAdd` are self-feeding
 * *by construction*. The `WebhookReceived` scoping this phase removes was incidentally
 * providing the loop safety; these guards are what replaces it.
 *
 * Provenance is **exact, not heuristic**: the SessionManager mutation sites call the
 * automation differ directly and hand it the cause, so `causedBy` is the matcher that
 * actually performed the mutation rather than a correlation guess. An event with no
 * `causedBy` genuinely has no automation ancestor — an external write, a human in the
 * UI, an agent — and is treated as depth 0.
 */

/**
 * Why an event exists: the automation matcher whose action caused it, and how many
 * automation hops deep that chain already is.
 *
 * `depth` counts hops already taken, so the event *emitted by* a depth-0 (user-caused)
 * trigger carries `depth: 1`.
 */
export interface AutomationCause {
  /** Matcher id of the automation whose action caused this event. */
  matcherId: string;
  /** Number of automation hops that produced this event. First hop is 1. */
  depth: number;
}

/**
 * Maximum automation hops in one causal chain. Constant, deliberately not configurable
 * (ADR-0021 §3) — a configurable loop limit is a loop limit someone will raise to debug
 * a runaway chain, which is the moment it needs to hold.
 */
export const MAX_AUTOMATION_CHAIN_DEPTH = 3;

/**
 * Per-matcher session-action ceiling, per sliding minute.
 *
 * The third guard, and the one that catches what the other two structurally cannot. The
 * depth cap bounds any *single* chain; what this bounds is *many short chains* — one rule
 * firing a fresh depth-1 action on every event of a chatty type, which never self-triggers
 * and never accumulates depth.
 *
 * **This number must stay below `DEFAULT_RATE_LIMIT` in `event-bus.ts` (10/min per app
 * event type, workspace-wide) or it is dead code**: the bus would drop the events before
 * any matcher ever saw them. Sitting below it buys the property the bus limit does not
 * have — a single runaway rule is refused *with a reportable reason*, per matcher, before
 * it can consume the shared per-event-type budget and silently starve every other
 * automation on that event. Pinned by a test in `causation.test.ts`.
 */
export const SESSION_ACTION_RATE_PER_MINUTE = 5;

/**
 * Why a session action was refused before execution. Recorded in history as
 * `skipped:<reason>` (fork(PLAN-030) Phase 2a).
 *
 * The first three are the Phase 1 loop guards. `unknown-action` is the Phase 0 dead-rule
 * class caught at *dispatch* rather than at load: the load-time `config-diagnostic` covers
 * a rule that can never run at all, and this covers the narrower case of a rule that fires
 * normally while one of its actions is unrunnable — which the load diagnostic reports once
 * and then never mentions again, however many times the rule half-fires.
 */
export type SessionActionSkipReason =
  | 'depth-exceeded'
  | 'self-trigger'
  | 'rate-limited'
  | 'unknown-action';

/**
 * A refused session action. Carries everything a history record needs, so Phase 2
 * ("effect-accurate history") can write `skipped:<reason>` entries without reaching back
 * into the handler.
 */
export interface SessionActionSkip {
  matcherId: string;
  automationName: string;
  /** The event that would have triggered the action. */
  event: string;
  reason: SessionActionSkipReason;
  /** Human-readable specifics (depth reached, the self-triggering matcher, …). */
  detail: string;
  /** The session the event was about, when it had one. */
  sessionId?: string;
  /**
   * The action types this refusal covers. The loop guards are evaluated per *matcher*, so
   * a refusal covers every session action the matcher declared; `unknown-action` covers
   * only the unrecognized ones. The history envelope's `sessionAction.type` is written
   * from this, so a skip record names what was actually refused rather than a placeholder.
   */
  actionTypes: string[];
}

/** Decision for one matcher on one event: run its session actions, or refuse and why. */
export type ChainGuardDecision =
  | { allow: true; cause: AutomationCause }
  | { allow: false; reason: SessionActionSkipReason; detail: string };

/**
 * Apply the two provenance-derived guards — self-trigger suppression and the depth cap —
 * and compute the cause to stamp on whatever this matcher's actions go on to emit.
 *
 * Pure and total: no clock, no state, no I/O. The rate gate is the caller's job because
 * it is inherently stateful; keeping it out of here is what makes these two guards
 * exhaustively testable.
 *
 * Order matters. Self-trigger is checked first and is unconditional (ADR-0021 §3: "a
 * matcher never re-enters on an event its own action caused, *regardless of depth*"), so
 * a rule pointed at itself is refused identically at depth 1 and depth 2 — the refusal
 * reason stays honest instead of degrading into `depth-exceeded` on the third pass.
 */
export function evaluateChainGuards(
  matcherId: string | undefined,
  causedBy: AutomationCause | undefined,
): ChainGuardDecision {
  const depth = causedBy?.depth ?? 0;

  if (causedBy && matcherId !== undefined && causedBy.matcherId === matcherId) {
    return {
      allow: false,
      reason: 'self-trigger',
      detail: `matcher "${matcherId}" would re-enter on an event its own action caused (depth ${depth})`,
    };
  }

  if (depth >= MAX_AUTOMATION_CHAIN_DEPTH) {
    return {
      allow: false,
      reason: 'depth-exceeded',
      detail: `automation chain reached depth ${depth} (max ${MAX_AUTOMATION_CHAIN_DEPTH}), caused by "${causedBy?.matcherId ?? 'unknown'}"`,
    };
  }

  return {
    allow: true,
    // A matcher with no id still needs a cause, or its own effects would look
    // user-originated and reset the chain to depth 0. Ids are backfilled on load, so
    // this is a defensive fallback rather than an expected path.
    cause: { matcherId: matcherId ?? '(anonymous)', depth: depth + 1 },
  };
}
