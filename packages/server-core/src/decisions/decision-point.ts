/**
 * Host-side decision points.
 *
 * Every harness feature that asks the decision model something (task verdicts,
 * semantic labels, turn outcomes, ...) goes through `openDecisionPoint`:
 *
 *   1. resolve a client: Settings switch → the feature's toggle → key → endpoint;
 *   2. decide under the user's background deadline (`decisionLayer.deadlineMs`)
 *      unless the request sets its own;
 *   3. record every call (feature tag, question keys, answers, state hash, never
 *      the state itself);
 *   4. return `null` on any failure so the caller keeps its pre-decision behaviour;
 *   5. `recordDecisionOutcome(result, ...)` then records what the point did with the
 *      answer (an outcome line joined to the decision by id), so usage can be judged
 *      without re-deriving thresholds from the code; `recordDecisionFollowUp` adds what
 *      turned out later (was the suggested source used?), which is what tunes a threshold.
 *
 * A decision is advice for the host. It never grants authority.
 */

import {
  buildDecisionRecord,
  getDecisionRecorder,
  type DecisionFollowUp,
  type DecisionOutcome,
  type DecisionRecord,
  resolveDecisionClient,
  type DecisionClientResolution,
  type DecisionFeature,
  type DecisionLayerFeature,
  type DecisionRecorder,
  type DecisionRequest,
  type DecisionResult,
  type ResolveDecisionClientOptions,
} from '@craft-agent/shared/decisions'

/** Ask a resolved decision point. `null` means no answer: behave as before. `signal` cancels the call. */
export type DecisionPointFn = (request: DecisionRequest, meta?: Record<string, unknown>, signal?: AbortSignal) => Promise<DecisionResult | null>

/** Test seams and logging shared by every decision point. */
export interface DecisionPointDeps {
  log?: (message: string) => void
  resolveClient?: (options: ResolveDecisionClientOptions) => Promise<DecisionClientResolution>
  recorder?: DecisionRecorder
}

export interface DecisionPointOptions extends DecisionPointDeps {
  /** Settings toggle that gates this point. */
  feature: DecisionLayerFeature
  /** Tag written to decisions.jsonl. */
  record: DecisionFeature
  sessionId?: string
  /** Upper bound on the deadline for points someone waits on (a turn start, a message ack). */
  maxDeadlineMs?: number
}

/** Deadline cap for decision points that hold up a turn start or a message acknowledgement. */
export const FOREGROUND_MAX_DEADLINE_MS = 3_000

/**
 * Resolve once and return a function that asks the model, possibly several
 * times (batches). `null` when the point is switched off or unavailable.
 * Never throws.
 */
export async function openDecisionPoint(options: DecisionPointOptions): Promise<DecisionPointFn | null> {
  const resolveClient = options.resolveClient ?? resolveDecisionClient
  const tag = `[decision:${options.record}]`
  let resolution: DecisionClientResolution
  try {
    resolution = await resolveClient({ feature: options.feature })
  } catch (error) {
    options.log?.(`${tag} resolver failed: ${errorMessage(error)}`)
    return null
  }
  if (!resolution.ok) {
    if (resolution.failure.kind !== 'disabled') options.log?.(`${tag} unavailable: ${resolution.failure.message}`)
    return null
  }

  const { client, provider, endpoint, settings } = resolution.value
  const recorder = options.recorder ?? getDecisionRecorder()
  return async (request, meta, signal) => {
    const startedAt = performance.now()
    const base = { feature: options.record, provider, model: endpoint.model, questions: request.questions, sessionId: options.sessionId, meta }
    try {
      const deadlineMs = Math.min(request.deadlineMs ?? settings.deadlineMs, options.maxDeadlineMs ?? Number.POSITIVE_INFINITY)
      const result = await client.decide({ ...request, deadlineMs }, signal)
      const record = buildDecisionRecord({ ...base, result })
      void recorder.append(record)
      recordHandles.set(result, { record, recorder })
      return result
    } catch (error) {
      void recorder.record({ ...base, error, latencyMs: Math.round(performance.now() - startedAt) })
      options.log?.(`${tag} failed: ${errorMessage(error)}`)
      return null
    }
  }
}

/** Decision record behind each result a decision point returned, for `recordDecisionOutcome`/`recordDecisionFollowUp`. */
const recordHandles = new WeakMap<DecisionResult, { record: DecisionRecord; recorder: DecisionRecorder; outcomeRecorded?: boolean }>()

/**
 * Record what the point did with `result`'s answer. Call once per result, including when
 * the answer changed nothing (`changed: false`): the ratio is what shows whether a toggle
 * earns its keep. No-op for `null` (no answer; the decision line already says why) and for
 * a second call on the same result.
 */
export function recordDecisionOutcome(result: DecisionResult | null | undefined, outcome: DecisionOutcome): void {
  if (!result) return
  const handle = recordHandles.get(result)
  if (!handle || handle.outcomeRecorded) return
  handle.outcomeRecorded = true
  void handle.recorder.recordOutcome(handle.record, outcome)
}

/** Record what turned out later about `result`'s answer (e.g. the suggested source was used). */
export function recordDecisionFollowUp(result: DecisionResult | null | undefined, followUp: DecisionFollowUp): void {
  if (!result) return
  const handle = recordHandles.get(result)
  if (!handle) return
  void handle.recorder.recordFollowUp(handle.record, followUp)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
