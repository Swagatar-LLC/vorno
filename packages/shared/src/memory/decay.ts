/**
 * Decay and temporal processing for the built-in markdown memory provider
 * (fork: PLAN-040 / SUV-0040).
 *
 * Pure arithmetic and date handling — no I/O, no filesystem, no clock of its
 * own. Every function that needs "now" takes it as an argument, so the whole
 * module is deterministic under test. That matters more here than elsewhere:
 * a ranking function you cannot pin to a fixed instant is a ranking function
 * whose tests are a coin flip near a band boundary.
 *
 * ## Where this algorithm comes from
 *
 * SUV-0040 asks for "semantics modelled on the agentic-memory engine's proven
 * behaviours". This is that engine's decay model, reimplemented rather than
 * imported (it is Python, and it is a private repo — the seam exists precisely
 * so we do not need its code to have its behaviour):
 *
 * - **Exponential half-life decay**: `score = 0.5 ** (age / halfLife)`. At
 *   exactly one half-life the score is 0.5; at zero age it is 1.0.
 * - **Three bands**: `fresh` (>= 0.5), `review` (>= 0.25), `archive-candidate`
 *   (< 0.25). The bands are what turn a continuous score into an action.
 * - **Importance modulates the half-life, not the score.** Doubling the
 *   half-life of an important memory means it decays *slower forever*, where
 *   adding a constant to its score would just shift when it crosses a band.
 * - **The anchor is `max(updated, lastCited)`, not `created`.** A memory that
 *   keeps being retrieved keeps earning its tokens and stays fresh; one that is
 *   never cited ages out honestly. Citation as a reinforcement signal is the
 *   single most load-bearing idea in the source engine, and it is why
 *   `search()` writes back to the store.
 */

/** What to do about a memory, derived from its decay score. */
export type DecayBand = 'fresh' | 'review' | 'archive-candidate';

/** Band thresholds. Inclusive lower bounds. */
export const DECAY_FRESH_THRESHOLD = 0.5;
export const DECAY_REVIEW_THRESHOLD = 0.25;

/**
 * Importance at or above this never decays at all.
 *
 * The source engine spells this `salience: pinned`. A pinned memory is exempt
 * from archiving entirely — not merely long-lived — because "this one matters
 * indefinitely" is a different statement from "this one matters twice as long".
 */
export const IMPORTANCE_PINNED = 0.9;
/** Importance at or above this doubles the effective half-life. */
export const IMPORTANCE_HIGH = 0.7;
/** Importance at or below this halves it. */
export const IMPORTANCE_LOW = 0.3;

export const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Clamp an importance hint into 0..1.
 *
 * Providers accept `importance` from callers who are not obliged to have read
 * this file. A caller who passes `5` meaning "very important" gets 1, not a
 * half-life of 2^5 days.
 */
export function normalizeImportance(importance: number | undefined): number {
  if (typeof importance !== 'number' || !Number.isFinite(importance)) return 0.5;
  if (importance < 0) return 0;
  if (importance > 1) return 1;
  return importance;
}

/**
 * The half-life actually applied to one memory, after importance.
 *
 * Returns `null` for a pinned memory — pinned needs no score, and returning a
 * very large number instead would make "pinned" merely "slow", which is exactly
 * the distinction being drawn.
 */
export function effectiveHalfLifeDays(
  baseHalfLifeDays: number,
  importance: number | undefined,
): number | null {
  const base = Number.isFinite(baseHalfLifeDays) && baseHalfLifeDays > 0 ? baseHalfLifeDays : 60;
  const value = normalizeImportance(importance);
  if (value >= IMPORTANCE_PINNED) return null;
  if (value >= IMPORTANCE_HIGH) return base * 2;
  if (value <= IMPORTANCE_LOW) return base / 2;
  return base;
}

/**
 * `0.5 ** (age / halfLife)`, clamped to 0..1.
 *
 * A `null` half-life (pinned) scores 1.0 — maximally fresh, forever. A negative
 * age (a memory stamped in the future, which clock skew makes possible) is
 * treated as zero rather than scoring above 1.
 */
export function decayScore(ageDays: number, halfLifeDays: number | null): number {
  if (halfLifeDays === null) return 1;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  const age = Number.isFinite(ageDays) && ageDays > 0 ? ageDays : 0;
  const score = Math.pow(0.5, age / halfLifeDays);
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

/** `score >= 0.5` fresh; `>= 0.25` review; below that, an archive candidate. */
export function bandFor(score: number): DecayBand {
  if (score >= DECAY_FRESH_THRESHOLD) return 'fresh';
  if (score >= DECAY_REVIEW_THRESHOLD) return 'review';
  return 'archive-candidate';
}

/** Parse an ISO-8601 stamp to epoch ms, or `null` if unparseable. Never throws. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The instant a memory's age is measured from: `max(updated, lastCited)`,
 * falling back to `created`, falling back to now.
 *
 * Falling back to *now* rather than to the epoch is deliberate. A memory with
 * no usable timestamps is a memory we know nothing about, and treating unknown
 * as maximally stale would archive it on the first sweep — deleting information
 * because its metadata was malformed. Unknown is treated as new; the sweep sees
 * it again tomorrow with a real stamp.
 */
export function anchorTimestampMs(
  entry: { createdAt?: string; updatedAt?: string; lastCitedAt?: string },
  nowMs: number,
): number {
  const candidates = [
    parseTimestamp(entry.updatedAt),
    parseTimestamp(entry.lastCitedAt),
    parseTimestamp(entry.createdAt),
  ].filter((value): value is number => value !== null);
  if (candidates.length === 0) return nowMs;
  return Math.max(...candidates);
}

/** Whole and fractional days between two instants, never negative. */
export function ageInDays(anchorMs: number, nowMs: number): number {
  const delta = nowMs - anchorMs;
  return delta > 0 ? delta / MILLISECONDS_PER_DAY : 0;
}

/** The temporal weight of one memory, and the band that follows from it. */
export interface TemporalWeight {
  readonly ageDays: number;
  readonly halfLifeDays: number | null;
  readonly score: number;
  readonly band: DecayBand;
  readonly pinned: boolean;
}

/** Compute {@link TemporalWeight} for one memory at a fixed instant. */
export function temporalWeight(
  entry: { createdAt?: string; updatedAt?: string; lastCitedAt?: string; importance?: number },
  baseHalfLifeDays: number,
  nowMs: number,
): TemporalWeight {
  const halfLifeDays = effectiveHalfLifeDays(baseHalfLifeDays, entry.importance);
  const ageDays = ageInDays(anchorTimestampMs(entry, nowMs), nowMs);
  const score = decayScore(ageDays, halfLifeDays);
  return {
    ageDays,
    halfLifeDays,
    score,
    band: bandFor(score),
    pinned: halfLifeDays === null,
  };
}

/**
 * How much a perfect lexical match can be dragged down by staleness, and by
 * unimportance, before ranking.
 *
 * Floors rather than raw multipliers, because a multiplicative model with no
 * floor lets a two-year-old memory score effectively zero no matter how exactly
 * it matches the query — at which point the ranking is a recency sort wearing a
 * relevance costume. With these floors, decay and importance *reorder* results
 * that match comparably; they never suppress a strong match entirely.
 */
export const RECENCY_FLOOR = 0.5;
export const IMPORTANCE_FLOOR = 0.6;

/**
 * Combine a lexical match score with temporal decay and importance.
 *
 * The two properties SUV-0040's acceptance turns on, both of which follow
 * directly from this being a product of a floored recency term and a floored
 * importance term:
 *
 * - equal lexical score, different freshness → the fresher memory ranks higher;
 * - equal lexical score and freshness, different importance → the more
 *   important memory ranks higher.
 *
 * Result is in 0..1 and comparable only within one provider's result set.
 */
export function rankingScore(
  lexical: number,
  decay: number,
  importance: number | undefined,
): number {
  const base = Number.isFinite(lexical) ? Math.min(1, Math.max(0, lexical)) : 0;
  const recencyTerm = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.min(1, Math.max(0, decay));
  const value = normalizeImportance(importance);
  const importanceTerm = IMPORTANCE_FLOOR + (1 - IMPORTANCE_FLOOR) * value;
  return Math.min(1, base * recencyTerm * importanceTerm);
}
