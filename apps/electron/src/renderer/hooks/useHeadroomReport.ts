/**
 * `useHeadroomReport` (fork: PLAN-040, SUV-0027).
 *
 * A wrapper over `watchHeadroomReport` and nothing more. All the behaviour —
 * first read, re-read on a completion signal, stale-response ordering, teardown
 * — lives in that controller, where it is tested without a DOM. Keeping the hook
 * this thin is deliberate: the interesting failure (a snapshot taken at mount
 * that never updates) is not one a React test would have caught cheaply.
 */

import { useEffect, useState } from 'react'
import { buildHeadroomReportView, type HeadroomReportView } from '@/lib/headroom-report'
import { watchHeadroomReport } from '@/lib/headroom-report-live'

/**
 * The measured Headroom report for a workspace, optionally with one session's
 * slice.
 *
 * Returns the not-loaded view — absent, with a reason, no numbers — until the
 * first read resolves, so a caller never has to render a "loading zero".
 */
export function useHeadroomReport(
  workspaceId: string | null | undefined,
  sessionId?: string,
): HeadroomReportView {
  const [view, setView] = useState<HeadroomReportView>(() =>
    buildHeadroomReportView(undefined, workspaceId ?? ''),
  )

  useEffect(() => {
    if (!workspaceId) {
      setView(buildHeadroomReportView(undefined, ''))
      return
    }

    const api = window.electronAPI
    // An older host (or the web client before this channel exists) simply has no
    // method here. That is "no measurement", not zero.
    if (!api?.getHeadroomStats || !api.onHeadroomStatsChanged) {
      setView(buildHeadroomReportView(undefined, workspaceId))
      return
    }

    setView(buildHeadroomReportView(undefined, workspaceId))

    return watchHeadroomReport(
      {
        fetch: (ws, session) => api.getHeadroomStats(ws, session),
        subscribe: (listener) => api.onHeadroomStatsChanged(listener),
      },
      { workspaceId, ...(sessionId === undefined ? {} : { sessionId }) },
      setView,
    )
  }, [workspaceId, sessionId])

  return view
}
