/**
 * Decay and temporal processing (fork: PLAN-040 / SUV-0040).
 *
 * Every test pins a fixed instant. A ranking function whose tests read the wall
 * clock is a ranking function with a flaky test near every band boundary.
 */

import { describe, expect, it } from 'bun:test';

import {
  DECAY_FRESH_THRESHOLD,
  DECAY_REVIEW_THRESHOLD,
  IMPORTANCE_FLOOR,
  IMPORTANCE_HIGH,
  IMPORTANCE_LOW,
  IMPORTANCE_PINNED,
  MILLISECONDS_PER_DAY,
  RECENCY_FLOOR,
  ageInDays,
  anchorTimestampMs,
  bandFor,
  decayScore,
  effectiveHalfLifeDays,
  normalizeImportance,
  parseTimestamp,
  rankingScore,
  temporalWeight,
} from '../decay.ts';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW - days * MILLISECONDS_PER_DAY).toISOString();

describe('normalizeImportance', () => {
  it('passes through values already in range', () => {
    expect(normalizeImportance(0)).toBe(0);
    expect(normalizeImportance(0.42)).toBe(0.42);
    expect(normalizeImportance(1)).toBe(1);
  });

  it('clamps a caller who meant "very important" by passing 5', () => {
    expect(normalizeImportance(5)).toBe(1);
    expect(normalizeImportance(-3)).toBe(0);
  });

  it('treats absent and non-finite as the neutral middle, not as zero', () => {
    // Zero would mean "actively unimportant", which is a claim the caller did
    // not make. Neutral is the honest reading of no information.
    expect(normalizeImportance(undefined)).toBe(0.5);
    expect(normalizeImportance(Number.NaN)).toBe(0.5);
    expect(normalizeImportance(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe('effectiveHalfLifeDays', () => {
  it('returns the base half-life for neutral importance', () => {
    expect(effectiveHalfLifeDays(60, 0.5)).toBe(60);
  });

  it('doubles the half-life at high importance', () => {
    expect(effectiveHalfLifeDays(60, IMPORTANCE_HIGH)).toBe(120);
  });

  it('halves the half-life at low importance', () => {
    expect(effectiveHalfLifeDays(60, IMPORTANCE_LOW)).toBe(30);
  });

  it('returns null for pinned — exempt, not merely long-lived', () => {
    // The distinction is load-bearing: a very large number would make "pinned"
    // mean "slow", and a pinned memory would eventually be archived anyway.
    expect(effectiveHalfLifeDays(60, IMPORTANCE_PINNED)).toBeNull();
    expect(effectiveHalfLifeDays(60, 1)).toBeNull();
  });

  it('falls back to a sane base when handed a nonsense one', () => {
    expect(effectiveHalfLifeDays(0, 0.5)).toBe(60);
    expect(effectiveHalfLifeDays(-10, 0.5)).toBe(60);
    expect(effectiveHalfLifeDays(Number.NaN, 0.5)).toBe(60);
  });
});

describe('decayScore', () => {
  it('is 1.0 at zero age and 0.5 at exactly one half-life', () => {
    expect(decayScore(0, 60)).toBe(1);
    expect(decayScore(60, 60)).toBeCloseTo(0.5, 10);
    expect(decayScore(120, 60)).toBeCloseTo(0.25, 10);
  });

  it('scores a pinned memory maximally fresh forever', () => {
    expect(decayScore(10_000, null)).toBe(1);
  });

  it('treats a future timestamp as age zero rather than scoring above 1', () => {
    // Clock skew across machines makes this reachable, and a score above 1
    // would break every downstream assumption about the 0..1 range.
    expect(decayScore(-30, 60)).toBe(1);
  });

  it('returns 0 for an unusable half-life', () => {
    expect(decayScore(10, 0)).toBe(0);
    expect(decayScore(10, -5)).toBe(0);
  });
});

describe('bandFor', () => {
  it('bands on the documented thresholds', () => {
    expect(bandFor(1)).toBe('fresh');
    expect(bandFor(DECAY_FRESH_THRESHOLD)).toBe('fresh');
    expect(bandFor(DECAY_FRESH_THRESHOLD - 0.0001)).toBe('review');
    expect(bandFor(DECAY_REVIEW_THRESHOLD)).toBe('review');
    expect(bandFor(DECAY_REVIEW_THRESHOLD - 0.0001)).toBe('archive-candidate');
    expect(bandFor(0)).toBe('archive-candidate');
  });
});

describe('parseTimestamp', () => {
  it('parses ISO stamps and rejects everything else without throwing', () => {
    expect(parseTimestamp('2026-08-28T12:00:00.000Z')).toBe(NOW);
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp(42)).toBeNull();
  });
});

describe('anchorTimestampMs', () => {
  it('takes the most recent of updated and lastCited', () => {
    const anchor = anchorTimestampMs(
      { createdAt: daysAgo(100), updatedAt: daysAgo(50), lastCitedAt: daysAgo(2) },
      NOW,
    );
    expect(anchor).toBe(Date.parse(daysAgo(2)));
  });

  it('lets a citation outrank an older edit — this is the reinforcement signal', () => {
    const cited = anchorTimestampMs({ updatedAt: daysAgo(90), lastCitedAt: daysAgo(1) }, NOW);
    const uncited = anchorTimestampMs({ updatedAt: daysAgo(90) }, NOW);
    expect(cited).toBeGreaterThan(uncited);
  });

  it('falls back to created when nothing else is present', () => {
    expect(anchorTimestampMs({ createdAt: daysAgo(10) }, NOW)).toBe(Date.parse(daysAgo(10)));
  });

  it('treats a memory with no usable stamps as new, not as maximally stale', () => {
    // Archiving something because its metadata was malformed would be deleting
    // information for a bookkeeping failure.
    expect(anchorTimestampMs({}, NOW)).toBe(NOW);
    expect(anchorTimestampMs({ createdAt: 'garbage', updatedAt: '' }, NOW)).toBe(NOW);
  });
});

describe('ageInDays', () => {
  it('measures elapsed days and never goes negative', () => {
    expect(ageInDays(NOW - 3 * MILLISECONDS_PER_DAY, NOW)).toBeCloseTo(3, 10);
    expect(ageInDays(NOW + 5 * MILLISECONDS_PER_DAY, NOW)).toBe(0);
  });
});

describe('temporalWeight', () => {
  it('bands a fresh memory fresh and a very old one as an archive candidate', () => {
    expect(temporalWeight({ updatedAt: daysAgo(1), importance: 0.5 }, 60, NOW).band).toBe('fresh');
    expect(temporalWeight({ updatedAt: daysAgo(400), importance: 0.5 }, 60, NOW).band).toBe(
      'archive-candidate',
    );
  });

  it('reports a pinned memory as pinned and fresh at any age', () => {
    const weight = temporalWeight({ updatedAt: daysAgo(5000), importance: 1 }, 60, NOW);
    expect(weight.pinned).toBe(true);
    expect(weight.score).toBe(1);
    expect(weight.band).toBe('fresh');
  });

  it('keeps an important memory fresh where a neutral one has decayed', () => {
    const important = temporalWeight({ updatedAt: daysAgo(90), importance: 0.8 }, 60, NOW);
    const neutral = temporalWeight({ updatedAt: daysAgo(90), importance: 0.5 }, 60, NOW);
    expect(important.score).toBeGreaterThan(neutral.score);
    expect(important.band).toBe('fresh');
    expect(neutral.band).toBe('review');
  });
});

describe('rankingScore', () => {
  it('SUV-0040 acceptance: equal lexical score, the fresher memory ranks higher', () => {
    const fresh = rankingScore(0.8, 1.0, 0.5);
    const stale = rankingScore(0.8, 0.1, 0.5);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('SUV-0040 acceptance: equal lexical and freshness, the more important ranks higher', () => {
    const important = rankingScore(0.8, 0.7, 0.9);
    const trivial = rankingScore(0.8, 0.7, 0.1);
    expect(important).toBeGreaterThan(trivial);
  });

  it('never suppresses a strong match entirely, however stale', () => {
    // Without floors, ranking degenerates into a recency sort wearing a
    // relevance costume: a perfect match from two years ago would score ~0.
    const ancientPerfectMatch = rankingScore(1, 0, 0);
    expect(ancientPerfectMatch).toBeCloseTo(RECENCY_FLOOR * IMPORTANCE_FLOOR, 10);
    expect(ancientPerfectMatch).toBeGreaterThan(0.25);
  });

  it('still lets a much better lexical match beat a fresher, more important one', () => {
    const goodMatchStale = rankingScore(0.9, 0.2, 0.2);
    const weakMatchFresh = rankingScore(0.3, 1, 1);
    expect(goodMatchStale).toBeGreaterThan(weakMatchFresh);
  });

  it('stays inside 0..1 for every input, including hostile ones', () => {
    for (const lexical of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      for (const decay of [-1, 0, 0.5, 1, 2]) {
        for (const importance of [-1, 0, 0.5, 1, 2, undefined]) {
          const score = rankingScore(lexical, decay, importance);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
