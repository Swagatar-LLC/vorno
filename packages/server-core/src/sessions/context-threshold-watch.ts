/**
 * Context-threshold watcher helpers (fork: PLAN-055, SUV-0071).
 *
 * `SessionManager` receives every `usage_update` / `complete` event with the
 * live input-token count and context window. These helpers decide, from that
 * sample and the session's persisted latch, whether a PLAN-003 threshold has
 * just been crossed for the first time. They are pure so the decision is
 * testable without a session manager, and the manager keeps only the glue:
 * resolve thresholds, persist the latch, emit `ContextThresholdReached`.
 *
 * Eligibility is deliberately narrow — interactive sessions only. Hidden
 * sessions (mini edit sessions), Tasks Conductor sessions (`taskSlug`) and
 * automation-created sessions (`triggeredBy`) have their own lifecycles and
 * budgets and never receive the event or the SUV-0072 handoff.
 */

import type { ContextThresholdState } from '@craft-agent/shared/sessions'
import type { ContextUsage } from '@craft-agent/shared/context-usage'

export type ContextThresholdLevel = 'warn' | 'danger'

/** The subset of a managed session the eligibility rule reads. */
export interface ContextThresholdEligibilityInput {
  hidden?: boolean
  taskSlug?: string
  triggeredBy?: unknown
}

/** Interactive sessions only — see the module header for why each exclusion exists. */
export function isContextThresholdEligible(session: ContextThresholdEligibilityInput): boolean {
  if (session.hidden) return false
  if (session.taskSlug) return false
  if (session.triggeredBy) return false
  return true
}

/**
 * True once both levels have fired for this session. The manager checks this
 * before any I/O so a session that has already crossed everything costs nothing
 * per assistant message.
 */
export function isContextThresholdSettled(state: ContextThresholdState | undefined): boolean {
  return Boolean(state?.warnReachedAt && state?.dangerReachedAt)
}

/**
 * Which levels this sample reaches for the FIRST time, in ascending order.
 *
 * A session that lands straight in `danger` (one huge tool result) reports both
 * `warn` and `danger` in one call, so a consumer keyed on `warn` still fires.
 * An unknown denominator never crosses anything: "80% of an unknown window" is
 * not a statement anyone can make, which is the same rule the indicator uses.
 */
export function detectContextThresholdCrossings(
  state: ContextThresholdState | undefined,
  usage: ContextUsage,
): ContextThresholdLevel[] {
  if (!usage.denominatorKnown) return []
  const reachedWarn = usage.level === 'warn' || usage.level === 'danger'
  const reachedDanger = usage.level === 'danger'
  const out: ContextThresholdLevel[] = []
  if (reachedWarn && !state?.warnReachedAt) out.push('warn')
  if (reachedDanger && !state?.dangerReachedAt) out.push('danger')
  return out
}

/** Apply newly crossed levels to the latch, stamping each with `now`. */
export function recordContextThresholdCrossings(
  state: ContextThresholdState | undefined,
  crossings: ContextThresholdLevel[],
  now: number,
): ContextThresholdState {
  const next: ContextThresholdState = { ...(state ?? {}) }
  for (const level of crossings) {
    if (level === 'warn') next.warnReachedAt = now
    else next.dangerReachedAt = now
  }
  return next
}
