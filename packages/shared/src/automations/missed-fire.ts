/**
 * fork(PLAN-017): Missed-fire detection.
 *
 * The scheduler (`scheduler-service.ts`) is stateless and minute-aligned — it
 * fires `SchedulerTick` only while the process is running. If the app is closed
 * or asleep across a cron's expected fire, that fire is silently skipped and no
 * history record is written. This module derives "missed" records from history
 * so a scheduled automation that never ran while the app was down produces a
 * visible not-ok record (and can trigger onFailure).
 *
 * Pure function: given the config, the raw history lines, and `now`, it returns
 * the missed-fire entries to append. No I/O — the integration layer in
 * `automation-system.ts` reads the file and appends the results.
 */

import { Cron } from 'croner';
import { createMissedHistoryEntry } from './webhook-utils.ts';
import type { AutomationsConfig } from './types.ts';

/** Grace period after an expected fire before it counts as missed (2 minutes). */
const MISSED_GRACE_MS = 2 * 60 * 1000;

/** How far back to look for a missed fire (24 hours). Bounds the window so a
 * newly-created automation isn't flagged for fires that predate it. */
const MISSED_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * A dispatch record counts as "covering" an expected fire if its timestamp is
 * at or after (expectedTs - this slack). The scheduler ticks on minute
 * boundaries; a dispatch may be logged a second or two after the expected wall
 * time, so allow a 60s slack so a real fire isn't mistaken for a miss.
 */
const DISPATCH_MATCH_SLACK_MS = 60 * 1000;

export interface DetectMissedFiresInput {
  config: AutomationsConfig | null;
  /** Raw JSONL lines from automations-history.jsonl (already split; blanks ok). */
  historyLines: string[];
  /** Current time (ms epoch). */
  now: number;
}

interface ParsedHistoryEntry {
  id?: string;
  ts?: number;
  kind?: string;
  expectedTs?: number;
}

/**
 * Detect missed cron fires. Returns the missed-fire history entries to append
 * (possibly empty). At most one entry per matcher (its most recent expected
 * fire within the lookback window).
 */
export function detectMissedFires(input: DetectMissedFiresInput): Record<string, unknown>[] {
  const { config, historyLines, now } = input;
  if (!config) return [];

  const schedulerMatchers = config.automations.SchedulerTick;
  if (!schedulerMatchers || schedulerMatchers.length === 0) return [];

  // Parse history once. Group timestamps per matcher id.
  //  - `records`: any non-'missed' record ts (dispatch/outcome/webhook) — used
  //    to decide whether an expected fire was actually covered.
  //  - `missedExpected`: set of expectedTs already recorded as missed — dedup
  //    across restarts so the same missed fire isn't re-appended.
  const records = new Map<string, number[]>();
  const missedExpected = new Map<string, Set<number>>();

  for (const line of historyLines) {
    if (!line) continue;
    let parsed: ParsedHistoryEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const id = parsed.id;
    if (typeof id !== 'string') continue;

    if (parsed.kind === 'missed') {
      if (typeof parsed.expectedTs === 'number') {
        let set = missedExpected.get(id);
        if (!set) {
          set = new Set();
          missedExpected.set(id, set);
        }
        set.add(parsed.expectedTs);
      }
      continue;
    }

    if (typeof parsed.ts === 'number') {
      let list = records.get(id);
      if (!list) {
        list = [];
        records.set(id, list);
      }
      list.push(parsed.ts);
    }
  }

  const cutoff = now - MISSED_GRACE_MS;
  const lookbackFloor = now - MISSED_LOOKBACK_MS;
  const results: Record<string, unknown>[] = [];

  for (const matcher of schedulerMatchers) {
    // Skip disabled and non-cron matchers.
    if (matcher.enabled === false) continue;
    if (!matcher.cron) continue;
    const matcherId = matcher.id;
    if (!matcherId) continue;

    // Most recent expected fire strictly before (now - grace).
    let expectedTs: number;
    try {
      const options = matcher.timezone ? { timezone: matcher.timezone } : {};
      const job = new Cron(matcher.cron, options);
      // croner's previousRuns(1, ref) returns the last run strictly before `ref`.
      const prev = job.previousRuns(1, new Date(cutoff));
      if (!prev.length || !prev[0]) continue;
      expectedTs = prev[0].getTime();
    } catch {
      continue;
    }

    // Bound by the 24h lookback window (don't flag ancient / just-created).
    if (expectedTs < lookbackFloor) continue;

    // Already recorded as missed for this exact expected fire? Dedup.
    if (missedExpected.get(matcherId)?.has(expectedTs)) continue;

    // Covered by an actual record at/after (expectedTs - slack)? Then not missed.
    const tsList = records.get(matcherId);
    const covered = tsList?.some((ts) => ts >= expectedTs - DISPATCH_MATCH_SLACK_MS);
    if (covered) continue;

    results.push(createMissedHistoryEntry({ matcherId, expectedTs }));
  }

  return results;
}
