/**
 * Keeping the Headroom report live (fork: PLAN-040, SUV-0027).
 *
 * The report must reflect a session that just finished without an app restart.
 * That means the view cannot be a snapshot taken at mount: it subscribes, and
 * re-reads when the main process says the measurements moved.
 *
 * The subscription is written as a plain controller rather than inside a React
 * hook so the behaviour that actually matters — *does a completion signal
 * produce fresh numbers?* — is testable without a DOM. The hook in
 * `useHeadroomReport` is a five-line wrapper over this.
 *
 * Two details that are easy to get wrong and are handled here:
 *
 * - **The signal carries no numbers.** It says "ask again". Trusting a pushed
 *   payload would bypass the workspace's `exposeStats` decision, which is
 *   enforced server-side on each read.
 * - **Responses can land out of order.** Two completions in quick succession
 *   start two fetches; the older one must not overwrite the newer. A generation
 *   counter drops stale answers, which is also what makes teardown safe — after
 *   `stop()`, nothing in flight can still call back.
 */

import type { HeadroomStatsReport } from '@craft-agent/core/types'
import { buildHeadroomReportView, type HeadroomReportView } from './headroom-report'

/** What the controller needs from the transport. Both are `window.electronAPI` in the app. */
export interface HeadroomReportSource {
  fetch(workspaceId: string, sessionId?: string): Promise<HeadroomStatsReport>
  /** Returns its own unsubscribe. */
  subscribe(
    listener: (payload: { workspaceId: string; sessionId?: string }) => void,
  ): () => void
}

export interface HeadroomReportScopeRequest {
  workspaceId: string
  /** Ask for a session slice alongside the workspace aggregate. */
  sessionId?: string
}

/**
 * Start reading the report for one scope, and keep reading it.
 *
 * Emits once as soon as the first fetch resolves, and again after every signal
 * for this workspace. A failed fetch emits the not-loaded view — absent, with a
 * reason — rather than throwing into a render or leaving stale numbers on
 * screen claiming to be current.
 *
 * @returns A stop function. Idempotent, and safe to call while a fetch is in
 *   flight.
 */
export function watchHeadroomReport(
  source: HeadroomReportSource,
  scope: HeadroomReportScopeRequest,
  onView: (view: HeadroomReportView) => void,
): () => void {
  let generation = 0
  let stopped = false

  const read = () => {
    const mine = ++generation
    void source
      .fetch(scope.workspaceId, scope.sessionId)
      .then((report) => {
        if (stopped || mine !== generation) return
        onView(buildHeadroomReportView(report, scope.workspaceId))
      })
      .catch(() => {
        if (stopped || mine !== generation) return
        onView(buildHeadroomReportView(undefined, scope.workspaceId))
      })
  }

  const unsubscribe = source.subscribe((payload) => {
    // A completion in another workspace moves no number this view is showing.
    if (payload.workspaceId !== scope.workspaceId) return
    read()
  })

  read()

  return () => {
    stopped = true
    unsubscribe()
  }
}
