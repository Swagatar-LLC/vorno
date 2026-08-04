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
      return {
        id: `${e.id}-${e.ts}${isDiagnostic ? '-diag' : ''}`,
        automationId: e.id,
        event: (e.event as AutomationTrigger | undefined) ?? fallbackEvent,
        // `blocked` (not `error`) — nothing was attempted and nothing failed;
        // the rule is structurally unable to run. Rendered with the warning
        // treatment rather than the failure one.
        status: isDiagnostic ? ('blocked' as const) : e.ok ? ('success' as const) : ('error' as const),
        duration: e.webhook?.durationMs ?? 0,
        timestamp: e.ts,
        sessionId: e.sessionId,
        actionSummary: isDiagnostic
          ? describeDiagnostic(e)
          : e.webhook
            ? `Webhook ${e.webhook.method} ${e.webhook.url}${e.webhook.attempts && e.webhook.attempts > 1 ? ` (${e.webhook.attempts} attempts)` : ''}`
            : e.prompt,
        error: isDiagnostic ? undefined : (e.webhook?.error ?? e.error),
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
