/**
 * View model for the Headroom savings report (fork: PLAN-040, SUV-0027).
 *
 * The renderer's whole job in this feature is *not doing arithmetic*. Every
 * number it shows was produced inside a `HeadroomAdapter.stats()` call —
 * per-session by the scope-counting adapter that session holds, per-workspace by
 * the aggregate over those adapters — and this module only decides how to spell
 * them. There is deliberately no subtraction, no division and no percentage
 * here: a savings figure computed in the renderer would be a number the user
 * could not trace to a measurement, which is exactly what SUV-0027's acceptance
 * forbids.
 *
 * The rendering contract, in one rule: **a stat that was not measured has no
 * cell value at all.** It comes back as `null`, and the component renders the
 * "unknown" affordance. `0` is reserved for a genuine measured zero, and the
 * two must never be confused — "compression saved nothing" and "we never
 * measured compression" lead a user to opposite conclusions about whether to
 * leave Headroom switched on.
 */

import type {
  HeadroomStatsReport,
  HeadroomStatsScope,
  HeadroomUnavailableReason,
} from '@craft-agent/core/types'

/** The figures the report shows, in display order. */
export const HEADROOM_REPORT_METRICS = [
  'tokensBefore',
  'tokensAfter',
  'tokensSaved',
  'compressedItems',
  'retrievals',
] as const

export type HeadroomReportMetric = (typeof HEADROOM_REPORT_METRICS)[number]

/** i18n key for each metric's label, so the component stays a pure renderer. */
export const HEADROOM_REPORT_METRIC_LABEL_KEYS: Record<HeadroomReportMetric, string> = {
  tokensBefore: 'settings.workspace.headroomReportTokensBefore',
  tokensAfter: 'settings.workspace.headroomReportTokensAfter',
  tokensSaved: 'settings.workspace.headroomReportTokensSaved',
  compressedItems: 'settings.workspace.headroomReportCompressedItems',
  retrievals: 'settings.workspace.headroomReportRetrievals',
}

/**
 * i18n key explaining why a scope has nothing to show.
 *
 * Three distinguishable operational states, three different sentences. Folding
 * them into one "no data" message would throw away the only thing that tells a
 * user whether to change a setting, start a session, or check the service.
 */
export const HEADROOM_REPORT_REASON_KEYS: Record<HeadroomUnavailableReason, string> = {
  disabled: 'settings.workspace.headroomReportUnavailableDisabled',
  'sdk-unavailable': 'settings.workspace.headroomReportUnavailableAbsent',
  'service-unavailable': 'settings.workspace.headroomReportUnavailableUnmeasured',
}

export interface HeadroomReportRow {
  metric: HeadroomReportMetric
  /** Display string, or `null` when the adapter did not report this figure. */
  value: string | null
}

export interface HeadroomReportScopeView {
  kind: 'session' | 'workspace'
  id: string
  /** True only when the adapter returned a measurement. */
  available: boolean
  /** Present only when `available` is false. */
  reasonKey?: string
  /** Empty when `available` is false — an unmeasured scope renders no figures. */
  rows: HeadroomReportRow[]
}

export interface HeadroomReportView {
  workspace: HeadroomReportScopeView
  /** Absent when no session slice was requested, or the report carried none. */
  session?: HeadroomReportScopeView
}

/**
 * Format a count for display.
 *
 * Grouping only — the value is passed through untouched. Fixed to `en-US`
 * rather than the UI locale because these tests, and the numbers themselves,
 * are about magnitude, and a locale-dependent separator would make the rendered
 * output depend on the machine rather than on the measurement.
 */
function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

/**
 * One scope's rows.
 *
 * Reads each field off the measurement and formats it, or emits `null`. Note
 * what is *not* here: `tokensSaved` is read, never derived from
 * `tokensBefore - tokensAfter`. An adapter that reports before and after but no
 * saving leaves that row unknown, which is the honest answer — the service is
 * the only thing that knows what its own transform saved.
 */
function scopeView(scope: HeadroomStatsScope): HeadroomReportScopeView {
  const base = { kind: scope.kind, id: scope.id }

  if (!scope.stats.available) {
    return {
      ...base,
      available: false,
      reasonKey: HEADROOM_REPORT_REASON_KEYS[scope.stats.reason],
      rows: [],
    }
  }

  const stats = scope.stats.value
  const byMetric: Record<HeadroomReportMetric, number | undefined> = {
    tokensBefore: stats.totalTokensBefore,
    tokensAfter: stats.totalTokensAfter,
    tokensSaved: stats.totalTokensSaved,
    compressedItems: stats.totalRequests,
    retrievals: stats.retrievals,
  }

  return {
    ...base,
    available: true,
    rows: HEADROOM_REPORT_METRICS.map((metric) => {
      const value = byMetric[metric]
      return {
        metric,
        // `undefined` means the adapter omitted the field. A non-finite number
        // is not a measurement either, and is treated the same way rather than
        // rendered as "NaN".
        value: typeof value === 'number' && Number.isFinite(value) ? formatCount(value) : null,
      }
    }),
  }
}

/**
 * Project a report onto what the section renders.
 *
 * `report === undefined` is the not-yet-loaded / older-server path and is not a
 * measurement either, so it takes the same shape as any other absent scope —
 * the component needs no third branch.
 */
export function buildHeadroomReportView(
  report: HeadroomStatsReport | undefined,
  fallbackWorkspaceId = '',
): HeadroomReportView {
  if (report === undefined) {
    return {
      workspace: {
        kind: 'workspace',
        id: fallbackWorkspaceId,
        available: false,
        reasonKey: HEADROOM_REPORT_REASON_KEYS['sdk-unavailable'],
        rows: [],
      },
    }
  }

  return {
    workspace: scopeView(report.workspace),
    ...(report.session === undefined ? {} : { session: scopeView(report.session) }),
  }
}

/**
 * True when nothing anywhere in the view has a figure to show.
 *
 * The component uses this to render a single explanatory line instead of two
 * empty tables — the "with Headroom disabled, say so rather than draw a chart of
 * zeros" requirement, expressed once.
 */
export function isHeadroomReportEmpty(view: HeadroomReportView): boolean {
  return !view.workspace.available && !(view.session?.available ?? false)
}
