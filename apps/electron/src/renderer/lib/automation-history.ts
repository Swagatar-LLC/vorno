/**
 * fork(PLAN-030): map raw automations-history records to timeline entries.
 *
 * Extracted from `useAutomations` so the filtering rules are testable — they are
 * load-bearing, and getting them wrong is silent in both directions. Two kinds
 * of record share one file:
 *
 * - **Dispatch** records (no `kind`) are actual fires. These are the run list.
 * - **Reconciliation** records (`kind: 'outcome' | 'missed'`, fork(PLAN-017))
 *   annotate a fire that already has a dispatch record. Rendering them would
 *   double-count runs and misrender, since they carry no prompt/webhook summary.
 * - **Config diagnostics** (`kind: 'config-diagnostic'`, fork(PLAN-030)) are
 *   neither. They report a rule that *cannot* fire. The original PLAN-017 filter
 *   dropped every record carrying a `kind`, which silently swallowed these too —
 *   the diagnostic was written to disk and then hidden from the one surface it
 *   was written for. They render as `blocked`: visible, but not counted as runs.
 *
 * **Session-action records** (`sessionAction`, fork(PLAN-030) Phase 2a) are dispatch
 * records — the event arrived and a decision was made — and were already surviving the
 * filter. They were nonetheless effectively invisible: this module had no `sessionAction`
 * field at all, so every one of them rendered with an empty summary. A `set-status` that
 * was refused for closing a task looked identical to one that succeeded, save for a red
 * dot. `describeSessionAction` below is what makes the outcome vocabulary legible, and it
 * is the reason Phase 2a's `skipped:*` refusals do not repeat Phase 0's write-only defect.
 */

import type { ExecutionEntry, AutomationTrigger } from '@/components/automations/types'

/** The raw record shape returned by the GET_HISTORY RPC. */
export interface RawHistoryEntry {
  id: string
  ts: number
  ok: boolean
  kind?: 'outcome' | 'missed' | 'config-diagnostic'
  reason?: string
  detail?: string
  event?: string
  sessionId?: string
  prompt?: string
  error?: string
  /** fork(PLAN-030): a session-mutation action's recorded effect. */
  sessionAction?: {
    type?: string
    outcome?: string
    event?: string
    depth?: number
    reason?: string
    detail?: string
    /** Session-action records nest the target session here, not at the top level. */
    sessionId?: string
  }
  webhook?: {
    method: string
    url: string
    statusCode: number
    durationMs: number
    attempts?: number
    error?: string
    responseBody?: string
  }
}

/** Human-readable cause for each diagnostic reason the loader can write. */
const DIAGNOSTIC_SUMMARIES: Record<string, string> = {
  'unknown-action-type': 'This automation can never run: unrecognized action type',
  'invalid-action-shape': 'This automation can never run: an action is missing required fields',
  'unknown-event': 'This automation is discarded at load: unrecognized event name',
}

function describeDiagnostic(entry: RawHistoryEntry): string {
  const base = DIAGNOSTIC_SUMMARIES[entry.reason ?? ''] ?? 'This automation can never run'
  return entry.detail ? `${base} (${entry.detail})` : base
}

/** True for records that represent an actual fire — i.e. that count as a run. */
export function isDispatchRecord(entry: RawHistoryEntry): boolean {
  return entry.kind === undefined
}

/** Why a session action was refused before it ever reached an executor. */
const SKIP_SUMMARIES: Record<string, string> = {
  'depth-exceeded': 'Refused: automation chain depth limit reached',
  'self-trigger': 'Refused: the rule would re-enter on an event its own action caused',
  'rate-limited': 'Refused: this rule exceeded its session-action rate limit',
  'unknown-action': 'Refused: no handler dispatches this action type',
}

/**
 * True when nothing was mutated because a guard refused the action up front.
 *
 * Keyed off the `skipped:` prefix rather than a `kind`, so the record keeps the same
 * envelope every other session action uses. Prefix-matched, not enumerated, so a newer
 * build's refusal reason still renders as blocked instead of silently reading as a
 * failed run.
 */
function isSkipOutcome(outcome: string | undefined): boolean {
  return outcome?.startsWith('skipped:') === true
}

/** Turn a recorded session-action outcome into something an operator can read. */
export function describeSessionAction(sa: NonNullable<RawHistoryEntry['sessionAction']>): string {
  const outcome = sa.outcome ?? ''

  if (isSkipOutcome(outcome)) {
    const base = SKIP_SUMMARIES[outcome.slice('skipped:'.length)] ?? 'Refused before execution'
    const scope = sa.type ? ` (${sa.type})` : ''
    return sa.detail ? `${base}${scope}: ${sa.detail}` : `${base}${scope}`
  }

  if (outcome.startsWith('set-status:')) return `Set status to "${outcome.slice('set-status:'.length)}"`
  if (outcome.startsWith('rejected:invalid-status:')) {
    return `Refused: no such status "${outcome.slice('rejected:invalid-status:'.length)}"`
  }
  if (outcome.startsWith('rejected:closed-status:')) {
    // The house rule operators hit most often, so it says *why* rather than just "refused".
    return `Refused: closing a session ("${outcome.slice('rejected:closed-status:'.length)}") requires allowClosed`
  }
  if (outcome === 'set-labels') return 'Updated labels'
  if (outcome === 'send-message') return 'Sent a message to the session'
  if (outcome === 'deferred:target-not-found') return 'Deferred: no session matched the target selector'
  if (outcome === 'deferred:host-unreachable') return 'Deferred: this host cannot reach the target session'
  if (outcome.startsWith('error:')) return `Failed: ${outcome.slice('error:'.length)}`

  return sa.type ? `${sa.type}: ${outcome}` : outcome
}

/**
 * Convert raw history records into timeline entries, dropping the ones that
 * would misrender or inflate the run count.
 */
export function toExecutionEntries(
  entries: RawHistoryEntry[],
  fallbackEvent: AutomationTrigger,
): ExecutionEntry[] {
  return entries
    .filter((e) => isDispatchRecord(e) || e.kind === 'config-diagnostic')
    .map((e) => {
      const isDiagnostic = e.kind === 'config-diagnostic'
      // A guard refusal is a fire that mutated nothing, so it shares the diagnostic's
      // `blocked` treatment rather than reading as a failed run.
      const isSkip = isSkipOutcome(e.sessionAction?.outcome)
      return {
        // The suffix is load-bearing, not cosmetic. A Phase 2a `unknown-action` refusal is
        // written in the same tick as the healthy action it fired alongside, under the same
        // matcher id — so without it both rows carry the same React key and one of them
        // silently stops rendering, which is the Phase 0 invisibility defect all over again.
        id: `${e.id}-${e.ts}${isDiagnostic ? '-diag' : isSkip ? `-skip-${e.sessionAction?.reason ?? ''}` : ''}`,
        automationId: e.id,
        event: (e.sessionAction?.event as AutomationTrigger | undefined)
          ?? (e.event as AutomationTrigger | undefined)
          ?? fallbackEvent,
        // `blocked` (not `error`) — nothing was attempted and nothing failed;
        // the rule is structurally unable to run. Rendered with the warning
        // treatment rather than the failure one.
        status: isDiagnostic || isSkip ? ('blocked' as const) : e.ok ? ('success' as const) : ('error' as const),
        duration: e.webhook?.durationMs ?? 0,
        timestamp: e.ts,
        // Session-action records nest it; without this the timeline row for a
        // session mutation has no session to deep-link to.
        sessionId: e.sessionId ?? e.sessionAction?.sessionId,
        actionSummary: isDiagnostic
          ? describeDiagnostic(e)
          : e.sessionAction
            ? describeSessionAction(e.sessionAction)
            : e.webhook
              ? `Webhook ${e.webhook.method} ${e.webhook.url}${e.webhook.attempts && e.webhook.attempts > 1 ? ` (${e.webhook.attempts} attempts)` : ''}`
              : e.prompt,
        error: isDiagnostic || isSkip ? undefined : (e.webhook?.error ?? e.error),
        webhookDetails: e.webhook
          ? {
              method: e.webhook.method,
              url: e.webhook.url,
              statusCode: e.webhook.statusCode,
              durationMs: e.webhook.durationMs,
              attempts: e.webhook.attempts,
              error: e.webhook.error,
              responseBody: e.webhook.responseBody,
            }
          : undefined,
      }
    })
}
