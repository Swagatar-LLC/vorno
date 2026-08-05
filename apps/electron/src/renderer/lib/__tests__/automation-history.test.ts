/**
 * fork(PLAN-030) — history records reach the surface operators actually check.
 *
 * Regression coverage for the gap that made Phase 0's diagnostics write-only:
 * the loader appended `config-diagnostic` records and the run-history view
 * dropped every record carrying a `kind`, so a rule that could never run was
 * reported to a file nobody reads and to a `console.warn` nobody watches.
 */

import { describe, it, expect } from 'bun:test'
import { toExecutionEntries, isDispatchRecord, type RawHistoryEntry } from '../automation-history'

const dispatch: RawHistoryEntry = { id: 'a', ts: 1000, ok: true, prompt: 'do the thing' }
const failedDispatch: RawHistoryEntry = { id: 'a', ts: 1100, ok: false, error: 'boom' }
const outcome: RawHistoryEntry = { id: 'a', ts: 1200, ok: false, kind: 'outcome' }
const missed: RawHistoryEntry = { id: 'a', ts: 1300, ok: false, kind: 'missed' }
const diagnostic: RawHistoryEntry = {
  id: 'a',
  ts: 1400,
  ok: false,
  kind: 'config-diagnostic',
  event: 'LabelAdd',
  reason: 'unknown-action-type',
  detail: 'setSessionStatus',
}

describe('toExecutionEntries', () => {
  it('surfaces config diagnostics — the whole point of writing them', () => {
    const entries = toExecutionEntries([diagnostic], 'LabelAdd')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.status).toBe('blocked')
  })

  it('still drops PLAN-017 outcome/missed reconciliation records', () => {
    // These annotate a fire that already has its own dispatch record; rendering
    // them double-counts the run and misrenders (no prompt/webhook summary).
    expect(toExecutionEntries([outcome, missed], 'LabelAdd')).toHaveLength(0)
  })

  it('keeps a diagnostic distinguishable from a real fire', () => {
    // A diagnostic is visible in the timeline but must never read as a run:
    // `blocked` is what separates "could not run" from "ran and succeeded".
    const entries = toExecutionEntries([dispatch, diagnostic], 'LabelAdd')
    expect(entries).toHaveLength(2)
    expect(entries.filter((e) => e.status === 'blocked')).toHaveLength(1)
    expect(entries.filter((e) => e.status === 'success')).toHaveLength(1)
  })

  it('names the cause and the offending value in the summary', () => {
    const summary = toExecutionEntries([diagnostic], 'LabelAdd')[0]!.actionSummary!
    expect(summary).toContain('never run')
    expect(summary).toContain('setSessionStatus')
  })

  it('describes each diagnostic reason distinctly', () => {
    const summaries = (['unknown-action-type', 'invalid-action-shape', 'unknown-event'] as const).map(
      (reason) => toExecutionEntries([{ ...diagnostic, reason }], 'LabelAdd')[0]!.actionSummary,
    )
    expect(new Set(summaries).size).toBe(3)
  })

  it('falls back to a generic cause for a reason it does not know', () => {
    // Forward compatibility: a newer build's diagnostic reason must still render
    // as a visible blocked entry rather than vanishing or throwing.
    const entry = toExecutionEntries([{ ...diagnostic, reason: 'some-future-reason' }], 'LabelAdd')[0]!
    expect(entry.status).toBe('blocked')
    expect(entry.actionSummary).toContain('never run')
  })

  it('marks a diagnostic as blocked, not error — nothing was attempted', () => {
    const entry = toExecutionEntries([diagnostic], 'LabelAdd')[0]!
    expect(entry.status).toBe('blocked')
    expect(entry.error).toBeUndefined()
    expect(entry.duration).toBe(0)
  })

  it('does not collide ids when a diagnostic shares a timestamp with a fire', () => {
    const entries = toExecutionEntries([{ ...dispatch, ts: 1400 }, diagnostic], 'LabelAdd')
    expect(new Set(entries.map((e) => e.id)).size).toBe(2)
  })

  it('prefers the diagnostic\'s own event over the fallback', () => {
    expect(toExecutionEntries([diagnostic], 'SchedulerTick')[0]!.event).toBe('LabelAdd')
  })

  it('uses the fallback event for records that carry none', () => {
    expect(toExecutionEntries([dispatch], 'SchedulerTick')[0]!.event).toBe('SchedulerTick')
  })

  it('preserves existing dispatch rendering', () => {
    const [ok, failed] = toExecutionEntries([dispatch, failedDispatch], 'LabelAdd')
    expect(ok!.status).toBe('success')
    expect(ok!.actionSummary).toBe('do the thing')
    expect(failed!.status).toBe('error')
    expect(failed!.error).toBe('boom')
  })

  it('renders webhook dispatches with details and attempt count', () => {
    const webhookEntry: RawHistoryEntry = {
      id: 'w',
      ts: 1,
      ok: true,
      webhook: { method: 'POST', url: 'https://e.com/h', statusCode: 200, durationMs: 42, attempts: 3 },
    }
    const entry = toExecutionEntries([webhookEntry], 'WebhookReceived')[0]!
    expect(entry.actionSummary).toBe('Webhook POST https://e.com/h (3 attempts)')
    expect(entry.duration).toBe(42)
    expect(entry.webhookDetails?.statusCode).toBe(200)
  })

  it('returns nothing for an empty history', () => {
    expect(toExecutionEntries([], 'LabelAdd')).toHaveLength(0)
  })
})

describe('isDispatchRecord', () => {
  it('counts only records with no kind as runs', () => {
    expect(isDispatchRecord(dispatch)).toBe(true)
    expect(isDispatchRecord(failedDispatch)).toBe(true)
    expect(isDispatchRecord(outcome)).toBe(false)
    expect(isDispatchRecord(diagnostic)).toBe(false)
  })
})
