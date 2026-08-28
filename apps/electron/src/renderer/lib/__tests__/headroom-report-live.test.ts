/**
 * The report stays live (fork: PLAN-040, SUV-0027).
 *
 * The acceptance item this covers: *the view updates to reflect a newly
 * completed session's stats without an app restart*. The failure it guards
 * against is the easy one — reading `stats()` once at mount and rendering that
 * snapshot forever, which looks perfect in a screenshot and is wrong the moment
 * a session finishes a turn.
 */

import { describe, expect, it } from 'bun:test'
import type { HeadroomStatsReport } from '@craft-agent/core/types'
import { watchHeadroomReport, type HeadroomReportSource } from '../headroom-report-live'
import type { HeadroomReportView } from '../headroom-report'

function reportSaving(tokensSaved: number, requests = 1): HeadroomStatsReport {
  return {
    workspace: {
      kind: 'workspace',
      id: 'ws-1',
      stats: {
        available: true,
        value: {
          totalRequests: requests,
          totalTokensBefore: tokensSaved * 2,
          totalTokensAfter: tokensSaved,
          totalTokensSaved: tokensSaved,
        },
      },
    },
  }
}

function saved(view: HeadroomReportView): string | null {
  return view.workspace.rows.find((row) => row.metric === 'tokensSaved')?.value ?? null
}

/** A transport double whose answers and signals the test drives by hand. */
function fakeSource(reports: HeadroomStatsReport[]) {
  let call = 0
  const listeners = new Set<(p: { workspaceId: string; sessionId?: string }) => void>()
  const source: HeadroomReportSource = {
    async fetch() {
      return reports[Math.min(call++, reports.length - 1)]!
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    source,
    signal(payload: { workspaceId: string; sessionId?: string }) {
      for (const listener of listeners) listener(payload)
    },
    get listenerCount() {
      return listeners.size
    },
    get fetchCount() {
      return call
    },
  }
}

/** Let the microtask queue drain, which is all these promises need. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('watchHeadroomReport', () => {
  it('re-reads when a session completes, so the view reflects the new numbers', async () => {
    const fake = fakeSource([reportSaving(600), reportSaving(1500, 3)])
    const views: HeadroomReportView[] = []

    const stop = watchHeadroomReport(fake.source, { workspaceId: 'ws-1' }, (view) =>
      views.push(view),
    )
    await settle()
    expect(saved(views[views.length - 1]!)).toBe('600')

    // A session finished a turn.
    fake.signal({ workspaceId: 'ws-1', sessionId: 's-1' })
    await settle()

    expect(saved(views[views.length - 1]!)).toBe('1,500')
    expect(views.length).toBe(2)
    stop()
  })

  it('ignores completions in other workspaces', async () => {
    const fake = fakeSource([reportSaving(600), reportSaving(1500)])
    const views: HeadroomReportView[] = []

    const stop = watchHeadroomReport(fake.source, { workspaceId: 'ws-1' }, (view) =>
      views.push(view),
    )
    await settle()

    fake.signal({ workspaceId: 'ws-other' })
    await settle()

    expect(views.length).toBe(1)
    expect(saved(views[0]!)).toBe('600')
    stop()
  })

  it('stops emitting after teardown and releases its subscription', async () => {
    const fake = fakeSource([reportSaving(600), reportSaving(1500)])
    const views: HeadroomReportView[] = []

    const stop = watchHeadroomReport(fake.source, { workspaceId: 'ws-1' }, (view) =>
      views.push(view),
    )
    await settle()
    stop()

    fake.signal({ workspaceId: 'ws-1' })
    await settle()

    expect(views.length).toBe(1)
    expect(fake.listenerCount).toBe(0)
  })

  it('renders a failed read as unmeasured rather than leaving stale numbers on screen', async () => {
    let first = true
    const source: HeadroomReportSource = {
      async fetch() {
        if (first) {
          first = false
          return reportSaving(600)
        }
        throw new Error('transport down')
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const listeners = new Set<(p: { workspaceId: string }) => void>()
    const views: HeadroomReportView[] = []

    const stop = watchHeadroomReport(source, { workspaceId: 'ws-1' }, (view) =>
      views.push(view),
    )
    await settle()
    expect(saved(views[0]!)).toBe('600')

    for (const listener of listeners) listener({ workspaceId: 'ws-1' })
    await settle()

    const latest = views[views.length - 1]!
    expect(latest.workspace.available).toBe(false)
    expect(latest.workspace.rows).toEqual([])
    stop()
  })

  it('drops a slow earlier response so it cannot overwrite a newer one', async () => {
    const pending: Array<(report: HeadroomStatsReport) => void> = []
    const listeners = new Set<(p: { workspaceId: string }) => void>()
    const source: HeadroomReportSource = {
      fetch() {
        return new Promise<HeadroomStatsReport>((resolve) => pending.push(resolve))
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const views: HeadroomReportView[] = []

    const stop = watchHeadroomReport(source, { workspaceId: 'ws-1' }, (view) =>
      views.push(view),
    )
    for (const listener of listeners) listener({ workspaceId: 'ws-1' })

    // Resolve the *second* fetch first, then the stale first one.
    pending[1]!(reportSaving(1500))
    await settle()
    pending[0]!(reportSaving(600))
    await settle()

    expect(views.length).toBe(1)
    expect(saved(views[0]!)).toBe('1,500')
    stop()
  })
})
