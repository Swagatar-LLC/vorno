/**
 * fork(PLAN-017): tests for detectMissedFires (pure function).
 */

import { describe, it, expect } from 'bun:test';
import { detectMissedFires } from './missed-fire.ts';
import type { AutomationsConfig } from './types.ts';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** A fixed "now": 2026-07-10T12:00:00Z (noon UTC). */
const NOW = new Date('2026-07-10T12:00:00Z').getTime();

function config(matchers: AutomationsConfig['automations']['SchedulerTick']): AutomationsConfig {
  return { automations: { SchedulerTick: matchers } };
}

/** A daily 09:00 UTC matcher — most recent fire before noon is 09:00 today. */
function daily9(id = 'm1', extra: Record<string, unknown> = {}) {
  return { id, cron: '0 9 * * *', timezone: 'UTC', actions: [{ type: 'prompt' as const, prompt: 'x' }], ...extra };
}

/** The expected fire ts for daily9 relative to NOW (today 09:00 UTC). */
const EXPECTED_9AM = new Date('2026-07-10T09:00:00Z').getTime();

describe('detectMissedFires', () => {
  it('detects a missed fire when there is no dispatch record for the expected fire', () => {
    const missed = detectMissedFires({ config: config([daily9()]), historyLines: [], now: NOW });
    expect(missed).toHaveLength(1);
    expect(missed[0]!.id).toBe('m1');
    expect(missed[0]!.kind).toBe('missed');
    expect(missed[0]!.ok).toBe(false);
    expect(missed[0]!.expectedTs).toBe(EXPECTED_9AM);
  });

  it('does NOT flag when a dispatch record exists at/after the expected fire', () => {
    const history = [JSON.stringify({ id: 'm1', ts: EXPECTED_9AM + 5 * MIN, ok: true })];
    const missed = detectMissedFires({ config: config([daily9()]), historyLines: history, now: NOW });
    expect(missed).toHaveLength(0);
  });

  it('treats a dispatch a few seconds before the expected fire as covering (60s slack)', () => {
    const history = [JSON.stringify({ id: 'm1', ts: EXPECTED_9AM - 30 * 1000, ok: true })];
    const missed = detectMissedFires({ config: config([daily9()]), historyLines: history, now: NOW });
    expect(missed).toHaveLength(0);
  });

  it('still flags when the only dispatch record predates the expected fire (previous day)', () => {
    const history = [JSON.stringify({ id: 'm1', ts: EXPECTED_9AM - 24 * HOUR, ok: true })];
    const missed = detectMissedFires({ config: config([daily9()]), historyLines: history, now: NOW });
    expect(missed).toHaveLength(1);
    expect(missed[0]!.expectedTs).toBe(EXPECTED_9AM);
  });

  it('dedups against an existing missed record for the same (id, expectedTs)', () => {
    const history = [
      JSON.stringify({ id: 'm1', ts: NOW - MIN, kind: 'missed', ok: false, expectedTs: EXPECTED_9AM }),
    ];
    const missed = detectMissedFires({ config: config([daily9()]), historyLines: history, now: NOW });
    expect(missed).toHaveLength(0);
  });

  it('does NOT dedup when the existing missed record is for a different expectedTs', () => {
    const history = [
      JSON.stringify({ id: 'm1', ts: NOW - 25 * HOUR, kind: 'missed', ok: false, expectedTs: EXPECTED_9AM - 24 * HOUR }),
    ];
    const missed = detectMissedFires({ config: config([daily9()]), historyLines: history, now: NOW });
    expect(missed).toHaveLength(1);
    expect(missed[0]!.expectedTs).toBe(EXPECTED_9AM);
  });

  it('respects the 2-minute grace: a fire in the last 2 minutes is not yet missed', () => {
    // now is 1 minute past a per-minute cron's last fire → within grace → not missed.
    const nowJustAfterFire = new Date('2026-07-10T12:00:30Z').getTime();
    const everyMinute = { id: 'em', cron: '* * * * *', timezone: 'UTC', actions: [{ type: 'prompt' as const, prompt: 'x' }] };
    const missed = detectMissedFires({ config: config([everyMinute]), historyLines: [], now: nowJustAfterFire });
    // The last expected fire strictly before (now-2min) is 11:58:00Z; with no
    // history it IS missed — but assert the grace excludes the very last minute
    // by checking expectedTs is not the 12:00 fire.
    expect(missed).toHaveLength(1);
    expect(missed[0]!.expectedTs).toBe(new Date('2026-07-10T11:58:00Z').getTime());
  });

  it('bounds detection to the 24h lookback window', () => {
    // A cron that only fires on the 1st of the month; on 2026-07-10 the last fire
    // (2026-07-01) is > 24h ago → out of window → not flagged.
    const monthly = { id: 'mo', cron: '0 0 1 * *', timezone: 'UTC', actions: [{ type: 'prompt' as const, prompt: 'x' }] };
    const missed = detectMissedFires({ config: config([monthly]), historyLines: [], now: NOW });
    expect(missed).toHaveLength(0);
  });

  it('handles timezones: a 09:00 America/New_York fire resolves in that zone', () => {
    // 09:00 in New York (EDT, UTC-4) = 13:00 UTC. Relative to NOW (12:00 UTC),
    // today's 13:00 UTC fire hasn't happened yet, so the most recent fire is
    // YESTERDAY 09:00 NY = 2026-07-09T13:00:00Z (within 24h) → missed.
    const ny = { id: 'ny', cron: '0 9 * * *', timezone: 'America/New_York', actions: [{ type: 'prompt' as const, prompt: 'x' }] };
    const missed = detectMissedFires({ config: config([ny]), historyLines: [], now: NOW });
    expect(missed).toHaveLength(1);
    expect(missed[0]!.expectedTs).toBe(new Date('2026-07-09T13:00:00Z').getTime());
  });

  it('skips disabled matchers', () => {
    const missed = detectMissedFires({ config: config([daily9('m1', { enabled: false })]), historyLines: [], now: NOW });
    expect(missed).toHaveLength(0);
  });

  it('skips matchers without a cron expression', () => {
    const noCron = { id: 'nc', actions: [{ type: 'prompt' as const, prompt: 'x' }] } as unknown as ReturnType<typeof daily9>;
    const missed = detectMissedFires({ config: config([noCron]), historyLines: [], now: NOW });
    expect(missed).toHaveLength(0);
  });

  it('skips matchers without an id (cannot correlate history)', () => {
    const noId = { cron: '0 9 * * *', timezone: 'UTC', actions: [{ type: 'prompt' as const, prompt: 'x' }] } as unknown as ReturnType<typeof daily9>;
    const missed = detectMissedFires({ config: config([noId]), historyLines: [], now: NOW });
    expect(missed).toHaveLength(0);
  });

  it('returns empty when there are no SchedulerTick matchers', () => {
    expect(detectMissedFires({ config: { automations: {} }, historyLines: [], now: NOW })).toHaveLength(0);
    expect(detectMissedFires({ config: null, historyLines: [], now: NOW })).toHaveLength(0);
  });

  it('emits at most one missed record per matcher (most recent expected fire only)', () => {
    // Two enabled daily matchers, no history → exactly one record each.
    const missed = detectMissedFires({
      config: config([daily9('a'), daily9('b')]),
      historyLines: [],
      now: NOW,
    });
    expect(missed).toHaveLength(2);
    expect(missed.map(m => m.id).sort()).toEqual(['a', 'b']);
  });

  it('ignores malformed history lines', () => {
    const history = ['not json{{', '', JSON.stringify({ id: 'm1', ts: EXPECTED_9AM + MIN, ok: true })];
    const missed = detectMissedFires({ config: config([daily9()]), historyLines: history, now: NOW });
    expect(missed).toHaveLength(0);
  });
});
