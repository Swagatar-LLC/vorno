/**
 * Large tool results via the decision model (feature toggle `largeResults`).
 *
 * A tool result too large for the context is always saved to a file. Before
 * the multi-second summarization call, the model judges from the start of the
 * result and the agent's stated intent whether a summary is needed or the
 * preview plus the saved file is enough. Only a confident "preview" skips the
 * summary; anything else summarizes as before.
 */

import type { LargeResultSummaryGate } from '@craft-agent/shared/utils'
import type { DecisionRequest } from '@craft-agent/shared/decisions'
import { openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** "Preview is enough" needs this much confidence. */
export const LARGE_RESULT_MIN_CONFIDENCE = 0.75
/** How much of the result the model sees. */
export const LARGE_RESULT_SAMPLE_CHARS = 3_000

export function buildLargeResultRequest(input: { toolName: string; intent?: string; text: string; estimatedTokens: number }): DecisionRequest {
  return {
    state: {
      tool: input.toolName,
      ...(input.intent ? { agent_intent: input.intent.slice(0, 500) } : {}),
      estimated_tokens: input.estimatedTokens,
      result_start: input.text.slice(0, LARGE_RESULT_SAMPLE_CHARS),
    },
    questions: {
      handling: {
        type: 'choice',
        instructions: 'This tool result is too large to show in full; it is saved to a file either way. What does the assistant need next to it?',
        criteria: {
          summary: 'A condensed summary: a long document, a big list or logs where the relevant part is spread out or not at the start.',
          preview: 'Only the beginning plus the saved file: the answer is at the top, the rest is repetitive, or the assistant will read the file selectively.',
        },
      },
    },
  }
}

/** Host gate for `setLargeResultSummaryGate`: `false` = preview is enough. Never throws. */
export function buildLargeResultSummaryGate(deps: DecisionPointDeps = {}): LargeResultSummaryGate {
  return async ({ text, context, estimatedTokens, sessionId }) => {
    const decide = await openDecisionPoint({ ...deps, feature: 'largeResults', record: 'large_results', sessionId })
    if (!decide) return null
    const result = await decide(buildLargeResultRequest({ toolName: context.toolName, intent: context.intent, text, estimatedTokens }), { tool: context.toolName, estimatedTokens })
    const answer = result?.answers.handling
    const preview = answer?.type === 'choice' && answer.confidence >= LARGE_RESULT_MIN_CONFIDENCE && answer.choice === 'preview'
    recordDecisionOutcome(result, preview ? { action: 'skip_summary', changed: true } : { action: 'summarize', changed: false })
    return preview ? false : null
  }
}
