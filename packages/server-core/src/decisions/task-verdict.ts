/**
 * Decision-model hook for Conductor task verdicts (feature toggle `taskVerdicts`).
 *
 * Resolves a decision point per call (Settings switch → toggle → key), runs the
 * request under the user's background deadline and records it with feature
 * `task_verdict`. `null` on every failure so the TaskRunner keeps its
 * pre-decision behaviour (re-ask the orchestrator).
 */

import type { TaskDecisionFn } from '../tasks/TaskRunner'
import { openDecisionPoint, type DecisionPointDeps } from './decision-point'

export type TaskVerdictDeciderDeps = DecisionPointDeps

export function buildTaskVerdictDecider(deps: TaskVerdictDeciderDeps = {}): TaskDecisionFn {
  return async (request, context) => {
    const decide = await openDecisionPoint({ ...deps, feature: 'taskVerdicts', record: 'task_verdict' })
    if (!decide) return null
    return decide(request, { slug: context.slug, runId: context.runId, questions: Object.keys(request.questions).length })
  }
}
