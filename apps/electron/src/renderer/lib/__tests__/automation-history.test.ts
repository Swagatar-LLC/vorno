/**
 * fork(PLAN-030) — history records reach the surface operators actually check.
 *
 * Regression coverage for the gap that made Phase 0's diagnostics write-only:
 * the loader appended `config-diagnostic` records and the run-history view
 * dropped every record carrying a `kind`, so a rule that could never run was
 * reported to a file nobody reads and to a `console.warn` nobody watches.
 */

import { describe, it, expect } from 'bun:test'
import { toExecutionEntries, isDispatchRecord, describeSessionAction, type RawHistoryEntry } from '../automation-history'

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

describe('session-action records (fork(PLAN-030) Phase 2a)', () => {
  const sessionAction = (outcome: string, extra: Record<string, unknown> = {}): RawHistoryEntry => ({
    id: 'lifecycle-rule',
    ts: 2000,
    ok: !outcome.startsWith('skipped:') && !outcome.startsWith('rejected:') && !outcome.startsWith('error:'),
    sessionAction: { type: 'set-status', outcome, event: 'LabelAdd', sessionId: 'sess-1', ...extra },
  })

  it('surfaces a refusal — the whole point of Phase 2a', () => {
    // A `skipped:` record that reaches the file and not the timeline is exactly the
    // write-only failure Phase 0 shipped and had to be fixed for.
    const entry = toExecutionEntries([sessionAction('skipped:self-trigger', { reason: 'self-trigger' })], 'LabelAdd')[0]!
    expect(entry.status).toBe('blocked')
    expect(entry.actionSummary).toContain('own action caused')
  })

  it('renders a refusal as blocked, never as a failed run', () => {
    // `error` would read as "it tried and broke". Nothing was attempted.
    for (const reason of ['self-trigger', 'depth-exceeded', 'rate-limited', 'unknown-action']) {
      const entry = toExecutionEntries([sessionAction(`skipped:${reason}`)], 'LabelAdd')[0]!
      expect(entry.status).toBe('blocked')
      expect(entry.error).toBeUndefined()
    }
  })

  it('describes each refusal reason distinctly', () => {
    const summaries = ['self-trigger', 'depth-exceeded', 'rate-limited', 'unknown-action'].map(
      (r) => toExecutionEntries([sessionAction(`skipped:${r}`)], 'LabelAdd')[0]!.actionSummary,
    )
    expect(new Set(summaries).size).toBe(4)
  })

  it('appends the recorded detail so the summary is actionable', () => {
    const entry = toExecutionEntries(
      [sessionAction('skipped:rate-limited', { detail: 'matcher exceeded 5 session actions/min' })],
      'LabelAdd',
    )[0]!
    expect(entry.actionSummary).toContain('5 session actions/min')
  })

  it('renders a future refusal reason as blocked rather than as an error', () => {
    // Forward compatibility, matched on the `skipped:` prefix rather than an enum, so a
    // newer build's reason cannot silently degrade into a failed-run row.
    const entry = toExecutionEntries([sessionAction('skipped:some-future-guard')], 'LabelAdd')[0]!
    expect(entry.status).toBe('blocked')
    expect(entry.actionSummary).toContain('Refused')
  })

  it('gives executed session actions a summary too — they had none before', () => {
    // Not incidental: every session-action record has rendered with an empty summary since
    // PLAN-014, so a refused `set-status` and a successful one differed only by a red dot.
    const summaries = [
      'set-status:needs-review',
      'set-labels',
      'send-message',
      'rejected:closed-status:done',
      'rejected:invalid-status:in_progress',
      'deferred:target-not-found',
      'deferred:host-unreachable',
    ].map((o) => toExecutionEntries([sessionAction(o)], 'LabelAdd')[0]!.actionSummary)
    expect(summaries.every((s) => typeof s === 'string' && s.length > 0)).toBe(true)
    expect(new Set(summaries).size).toBe(7)
  })

  it('names the house rule when a close is refused', () => {
    const summary = toExecutionEntries([sessionAction('rejected:closed-status:done')], 'LabelAdd')[0]!.actionSummary!
    expect(summary).toContain('allowClosed')
    expect(summary).toContain('done')
  })

  it('keeps a successful mutation reading as a success', () => {
    const entry = toExecutionEntries([sessionAction('set-status:needs-review')], 'LabelAdd')[0]!
    expect(entry.status).toBe('success')
    expect(entry.actionSummary).toBe('Set status to "needs-review"')
  })

  it('an executor error still reads as an error, not as blocked', () => {
    const entry = toExecutionEntries([sessionAction('error:disk full')], 'LabelAdd')[0]!
    expect(entry.status).toBe('error')
    expect(entry.actionSummary).toContain('disk full')
  })

  it('does not collide with the healthy action it fired alongside', () => {
    // The unknown-action case writes a refusal in the same tick, under the same matcher id,
    // as the action that did run. Colliding keys drop a row from the timeline — silently.
    const ts = 3000
    const entries = toExecutionEntries(
      [
        { ...sessionAction('set-status:needs-review'), ts },
        { ...sessionAction('skipped:unknown-action', { reason: 'unknown-action' }), ts },
      ],
      'LabelAdd',
    )
    expect(entries).toHaveLength(2)
    expect(new Set(entries.map((e) => e.id)).size).toBe(2)
  })

  it('does not collide two refusals recorded in the same tick', () => {
    const ts = 3100
    const entries = toExecutionEntries(
      [
        { ...sessionAction('skipped:rate-limited', { reason: 'rate-limited' }), ts },
        { ...sessionAction('skipped:unknown-action', { reason: 'unknown-action' }), ts },
      ],
      'LabelAdd',
    )
    expect(new Set(entries.map((e) => e.id)).size).toBe(2)
  })

  it('deep-links to the session nested inside the record', () => {
    // Session-action records nest sessionId under `sessionAction`, not at the top level.
    expect(toExecutionEntries([sessionAction('skipped:self-trigger')], 'LabelAdd')[0]!.sessionId).toBe('sess-1')
  })

  it('prefers the record`s own event over the fallback', () => {
    expect(toExecutionEntries([sessionAction('skipped:self-trigger')], 'SchedulerTick')[0]!.event).toBe('LabelAdd')
  })

  it('falls back to type + outcome for an outcome it cannot classify', () => {
    expect(describeSessionAction({ type: 'set-status', outcome: 'something-new' })).toBe('set-status: something-new')
  })

  it('names the refused action types on a multi-action refusal', () => {
    const summary = describeSessionAction({ type: 'set-status, set-labels', outcome: 'skipped:depth-exceeded' })
    expect(summary).toContain('set-status, set-labels')
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
