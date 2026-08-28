/**
 * Headroom savings report view model (fork: PLAN-040, SUV-0027).
 *
 * These are the acceptance checks for the rendering contract, and each one
 * fails in a specific, damaging way if the renderer starts doing arithmetic:
 *
 *   1. **Nothing is derived.** The report is fed intentionally *inconsistent*
 *      numbers — a `tokensSaved` that could not possibly be `before - after` —
 *      and the rendered cell must show the adapter's figure. If the renderer
 *      ever computes savings, this test shows the computed value instead and
 *      goes red. That is the only cheap way to prove the acceptance item "every
 *      figure traces to adapter.stats()".
 *   2. **Absent is not zero.** A measurement with fields omitted renders no
 *      value for them, and the whole rendered output for that scope contains no
 *      `0`, no `0%`, and no interpolation.
 *   3. **Disabled says so.** With Headroom off (or the no-op adapter answering),
 *      the scope carries a reason and *no rows at all* — not a table of zeros.
 */

import { describe, expect, it } from 'bun:test'
import type { HeadroomStatsReport } from '@craft-agent/core/types'
import {
  HEADROOM_REPORT_METRICS,
  buildHeadroomReportView,
  isHeadroomReportEmpty,
} from '../headroom-report'

function cell(
  view: ReturnType<typeof buildHeadroomReportView>,
  scope: 'workspace' | 'session',
  metric: (typeof HEADROOM_REPORT_METRICS)[number],
): string | null {
  const rows = scope === 'workspace' ? view.workspace.rows : (view.session?.rows ?? [])
  return rows.find((row) => row.metric === metric)?.value ?? null
}

describe('buildHeadroomReportView — every figure comes from the adapter', () => {
  it('renders the adapter’s savings figure, never one derived from before/after', () => {
    // 1000 - 250 would be 750. The adapter says 613. If the renderer ever
    // computes the saving itself, this assertion is what catches it.
    const report: HeadroomStatsReport = {
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: {
          available: true,
          value: {
            totalRequests: 7,
            totalTokensBefore: 1000,
            totalTokensAfter: 250,
            totalTokensSaved: 613,
            retrievals: 2,
          },
        },
      },
    }

    const view = buildHeadroomReportView(report)

    expect(cell(view, 'workspace', 'tokensSaved')).toBe('613')
    expect(cell(view, 'workspace', 'tokensBefore')).toBe('1,000')
    expect(cell(view, 'workspace', 'tokensAfter')).toBe('250')
    expect(cell(view, 'workspace', 'compressedItems')).toBe('7')
    expect(cell(view, 'workspace', 'retrievals')).toBe('2')
    // The derived value must appear nowhere in the rendered output.
    expect(JSON.stringify(view)).not.toContain('750')
  })

  it('renders the session slice from the session scope and the workspace slice from the workspace scope', () => {
    const report: HeadroomStatsReport = {
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: {
          available: true,
          value: {
            totalRequests: 9,
            totalTokensBefore: 9000,
            totalTokensAfter: 3000,
            totalTokensSaved: 6000,
          },
        },
      },
      session: {
        kind: 'session',
        id: 's-1',
        stats: {
          available: true,
          value: {
            totalRequests: 2,
            totalTokensBefore: 900,
            totalTokensAfter: 300,
            totalTokensSaved: 600,
          },
        },
      },
    }

    const view = buildHeadroomReportView(report)

    expect(view.session?.id).toBe('s-1')
    expect(cell(view, 'session', 'tokensSaved')).toBe('600')
    expect(cell(view, 'workspace', 'tokensSaved')).toBe('6,000')
    expect(isHeadroomReportEmpty(view)).toBe(false)
  })
})

describe('buildHeadroomReportView — absent renders as unknown, never as zero', () => {
  it('leaves omitted fields with no value and prints no zeros for them', () => {
    const report: HeadroomStatsReport = {
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: {
          available: true,
          value: {
            totalRequests: 3,
            totalTokensBefore: 1200,
            totalTokensAfter: 400,
            totalTokensSaved: 800,
            // `retrievals` deliberately omitted — the adapter did not measure it.
          },
        },
      },
    }

    const view = buildHeadroomReportView(report)

    expect(cell(view, 'workspace', 'retrievals')).toBeNull()
    // Nothing was substituted for the missing field.
    const rendered = view.workspace.rows.map((row) => row.value).filter((v) => v !== null)
    expect(rendered).not.toContain('0')
    expect(rendered).not.toContain('0%')
  })

  it('treats a non-finite number as no measurement rather than rendering NaN', () => {
    const report: HeadroomStatsReport = {
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: {
          available: true,
          value: {
            totalRequests: 1,
            totalTokensBefore: Number.NaN,
            totalTokensAfter: 10,
            totalTokensSaved: 5,
          },
        },
      },
    }

    const view = buildHeadroomReportView(report)

    expect(cell(view, 'workspace', 'tokensBefore')).toBeNull()
    expect(JSON.stringify(view)).not.toContain('NaN')
  })

  it('renders an entirely absent measurement as no rows at all — no zeros anywhere', () => {
    const report: HeadroomStatsReport = {
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: { available: false, reason: 'service-unavailable' },
      },
      session: {
        kind: 'session',
        id: 's-1',
        stats: { available: false, reason: 'service-unavailable' },
      },
    }

    const view = buildHeadroomReportView(report)

    expect(view.workspace.rows).toEqual([])
    expect(view.session?.rows).toEqual([])
    expect(view.workspace.available).toBe(false)
    // Not one digit reaches the figures. (The scope ids are not figures.)
    expect(JSON.stringify([view.workspace.rows, view.session?.rows])).not.toMatch(/\d/)
    expect(isHeadroomReportEmpty(view)).toBe(true)
  })
})

describe('buildHeadroomReportView — the disabled / no-op path states why', () => {
  it('says Headroom is off rather than showing an empty chart of zeros', () => {
    const report: HeadroomStatsReport = {
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: { available: false, reason: 'disabled' },
      },
      session: {
        kind: 'session',
        id: 's-1',
        stats: { available: false, reason: 'disabled' },
      },
    }

    const view = buildHeadroomReportView(report)

    expect(isHeadroomReportEmpty(view)).toBe(true)
    expect(view.workspace.reasonKey).toBe(
      'settings.workspace.headroomReportUnavailableDisabled',
    )
    expect(view.session?.reasonKey).toBe(
      'settings.workspace.headroomReportUnavailableDisabled',
    )
    expect(view.workspace.rows).toEqual([])
  })

  it('distinguishes “Headroom absent”, “nothing measured yet” and “switched off”', () => {
    const keys = (['disabled', 'sdk-unavailable', 'service-unavailable'] as const).map(
      (reason) =>
        buildHeadroomReportView({
          workspace: { kind: 'workspace', id: 'ws-1', stats: { available: false, reason } },
        }).workspace.reasonKey,
    )

    expect(new Set(keys).size).toBe(3)
  })

  it('treats a report that has not loaded as unmeasured, not as zero', () => {
    const view = buildHeadroomReportView(undefined, 'ws-1')

    expect(view.workspace.available).toBe(false)
    expect(view.workspace.rows).toEqual([])
    expect(view.session).toBeUndefined()
    expect(isHeadroomReportEmpty(view)).toBe(true)
  })

  it('shows a measured zero as a real zero — the one case where 0 is honest', () => {
    // A session that ran compression and genuinely saved nothing is a different
    // statement from one that was never measured, and must be able to say so.
    const view = buildHeadroomReportView({
      workspace: {
        kind: 'workspace',
        id: 'ws-1',
        stats: {
          available: true,
          value: {
            totalRequests: 4,
            totalTokensBefore: 500,
            totalTokensAfter: 500,
            totalTokensSaved: 0,
          },
        },
      },
    })

    expect(cell(view, 'workspace', 'tokensSaved')).toBe('0')
  })
})
