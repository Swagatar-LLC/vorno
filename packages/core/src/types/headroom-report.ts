/**
 * The shape the Headroom report view reads (fork: PLAN-040 / SUV-0027).
 *
 * SUV-0023 and SUV-0024 made compression run; this is how the numbers it
 * produced reach a user. The report is deliberately *thin*: it names the scopes
 * being reported and carries, for each, exactly one
 * {@link HeadroomMeasurement} obtained from a {@link HeadroomAdapter}'s `stats()`
 * operation. There is no derived field here and there must never be one — the
 * moment this type grows a `savingsPercent`, some layer other than an adapter is
 * computing savings, which is the thing SUV-0027's acceptance forbids.
 *
 * Import-free plain data, same rule as the rest of the Headroom types: it
 * survives `JSON.stringify` intact, so a server-homed instance (PLAN-041) can
 * put the identical shape on the wire.
 *
 * **Measured or absent.** Every scope's `stats` is a measurement, so a scope
 * with nothing to say carries a reason and no numbers at all. A renderer cannot
 * accidentally read a zero out of this type; the absent arm has no numeric
 * fields to read.
 */

import type {
  HeadroomMeasurement,
  HeadroomUsageStats,
} from './headroom-adapter.ts';

/**
 * What a reported scope covers.
 *
 * - `session` — one session's own compression, measured by the scope-counting
 *   adapter that session holds. Its denominator is that session's lifetime in
 *   this process.
 * - `workspace` — the aggregate over the workspace's live sessions. Not the
 *   Headroom *service*'s cumulative counters: those span every workspace and
 *   every client of the service, and reporting them as a workspace figure would
 *   be a number that traces to a real measurement of the wrong thing.
 */
export type HeadroomStatsScopeKind = 'session' | 'workspace';

/** One reported scope: what it covers, and what its adapter measured. */
export interface HeadroomStatsScope {
  readonly kind: HeadroomStatsScopeKind;
  /** Session id or workspace id, matching {@link kind}. */
  readonly id: string;
  /** Verbatim from that scope's `adapter.stats()`. Never reshaped. */
  readonly stats: HeadroomMeasurement<HeadroomUsageStats>;
}

/**
 * Everything the report view renders.
 *
 * `session` is absent when the caller asked for no session slice, or asked for
 * one that has no live agent — which is a different statement from "that
 * session compressed nothing" and is rendered differently.
 */
export interface HeadroomStatsReport {
  readonly workspace: HeadroomStatsScope;
  readonly session?: HeadroomStatsScope;
}
