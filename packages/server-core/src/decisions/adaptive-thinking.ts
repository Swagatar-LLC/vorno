/**
 * Adaptive thinking via the decision model (feature toggle `adaptiveThinking`).
 *
 * Before a turn starts, the model rates how demanding the user's message is on
 * a four-level rubric; simple requests run with a lower thinking level for that
 * turn only. It never raises the level above the session's, and no confident
 * answer keeps the session level.
 */

import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'
import type { DecisionRequest } from '@craft-agent/shared/decisions'
import { FOREGROUND_MAX_DEADLINE_MS, openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** The rated level must come with this much confidence. */
export const ADAPTIVE_THINKING_MIN_CONFIDENCE = 0.6
/** The message is cut to this many characters before it is sent. */
export const ADAPTIVE_THINKING_MAX_MESSAGE_CHARS = 4_000

/** Thinking cap per rubric level; the top level keeps the session's setting. */
const CAP_BY_LEVEL: readonly (ThinkingLevel | null)[] = ['low', 'medium', 'high', null]

export function buildDemandRequest(message: string): DecisionRequest {
  return {
    state: { message: message.length > ADAPTIVE_THINKING_MAX_MESSAGE_CHARS ? `${message.slice(0, ADAPTIVE_THINKING_MAX_MESSAGE_CHARS)}…` : message },
    questions: {
      demand: {
        type: 'score',
        instructions: 'How much reasoning does the assistant need to answer this message well?',
        criteria: [
          'A greeting, a thank-you, or a simple factual question with a short answer',
          'A routine request with clear instructions: a small edit, a lookup, a short summary',
          'A substantial task: multi-step work, non-trivial code, or careful analysis',
          'A hard problem: complex reasoning, debugging, architecture, or ambiguous requirements',
        ],
      },
    },
  }
}

/** The lower of two thinking levels. */
function lowerOf(a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel {
  return THINKING_LEVEL_IDS.indexOf(a) <= THINKING_LEVEL_IDS.indexOf(b) ? a : b
}

/**
 * The thinking level to use for this turn when it is lower than `sessionLevel`,
 * or `null` to keep the session level. Never throws.
 */
export async function pickTurnThinkingLevel(
  message: string,
  sessionLevel: ThinkingLevel,
  deps: DecisionPointDeps & { sessionId?: string } = {},
): Promise<ThinkingLevel | null> {
  if (sessionLevel === 'off' || !message.trim()) return null
  // The turn start waits for this answer.
  const decide = await openDecisionPoint({ ...deps, feature: 'adaptiveThinking', record: 'adaptive_thinking', maxDeadlineMs: FOREGROUND_MAX_DEADLINE_MS })
  if (!decide) return null
  const result = await decide(buildDemandRequest(message.trim()), { sessionLevel })
  const answer = result?.answers.demand
  const keep = (reason: string) => {
    recordDecisionOutcome(result, { action: 'keep', changed: false, detail: { reason, sessionLevel } })
    return null
  }
  if (!answer || answer.type !== 'score') return keep('no_answer')
  if (answer.confidence < ADAPTIVE_THINKING_MIN_CONFIDENCE) return keep('low_confidence')
  const level = Math.min(CAP_BY_LEVEL.length - 1, Math.max(0, Math.round(answer.score)))
  const cap = CAP_BY_LEVEL[level]
  if (!cap) return keep('needs_session_level')
  const turnLevel = lowerOf(cap, sessionLevel)
  if (turnLevel === sessionLevel) return keep('not_lower')
  recordDecisionOutcome(result, { action: `thinking:${turnLevel}`, changed: true, detail: { sessionLevel } })
  return turnLevel
}
