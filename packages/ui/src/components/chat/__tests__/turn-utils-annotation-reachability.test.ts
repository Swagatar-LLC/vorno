import { describe, it, expect } from 'bun:test'
import { buildAnnotatableTurnIndex, groupMessagesByTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

/**
 * Regression suite for the phantom follow-up incident (session 260724-light-delta).
 *
 * A follow-up annotation is only reachable in the UI when the turn that renders
 * its message carries the annotation array (otherwise the transcript shows no
 * chip and the external open request from the composer chip is dropped) and
 * when the composer can widen the paginated transcript window far enough to
 * mount that turn. These tests pin both properties.
 */

function annotation(id: string, messageId: string, exact: string): NonNullable<Message['annotations']>[number] {
  return {
    id,
    schemaVersion: 1,
    createdAt: 1700000000000,
    intent: 'comment',
    body: [{ type: 'highlight' }, { type: 'note', text: 'follow up on this', format: 'plain' }],
    target: {
      source: { sessionId: 'session-1', messageId },
      selectors: [
        { type: 'text-position', start: 0, end: exact.length },
        { type: 'text-quote', exact, prefix: '', suffix: '' },
      ],
    },
    style: { color: 'yellow' },
    meta: { followUp: { text: 'follow up on this', createdAt: 1700000000000 } },
  }
}

describe('annotations survive turn grouping', () => {
  it('keeps annotations on a response promoted from an intermediate message', () => {
    const anns = annotation('ann-intermediate-1', 'assistant-intermediate-1', 'drain complete')

    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'Drain the queue', timestamp: 1000 },
      {
        id: 'tool-1',
        role: 'tool',
        content: 'Running',
        timestamp: 1100,
        toolName: 'Bash',
        toolUseId: 'tu-1',
        toolStatus: 'completed',
      },
      {
        id: 'assistant-intermediate-1',
        role: 'assistant',
        content: 'drain complete',
        timestamp: 1200,
        isIntermediate: true,
        annotations: [anns],
      },
      // A following user message closes the turn, which triggers the
      // "promote last intermediate text to response" path.
      { id: 'user-2', role: 'user', content: 'thanks', timestamp: 1300 },
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurn = turns.find(turn => turn.type === 'assistant')
    expect(assistantTurn).toBeDefined()
    if (!assistantTurn || assistantTurn.type !== 'assistant') return

    expect(assistantTurn.response?.messageId).toBe('assistant-intermediate-1')
    // Without this the message renders with `annotations: undefined`: no chip in
    // the transcript, and the composer chip can't open the island because the
    // external open request is dropped for an empty annotation list.
    expect(assistantTurn.response?.annotations).toEqual([anns])
  })

  it('keeps annotations on the intermediate activity itself', () => {
    const anns = annotation('ann-intermediate-2', 'assistant-intermediate-2', 'partial thought')

    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'go', timestamp: 1000 },
      {
        id: 'assistant-intermediate-2',
        role: 'assistant',
        content: 'partial thought',
        timestamp: 1100,
        isIntermediate: true,
        annotations: [anns],
      },
      {
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'final answer',
        timestamp: 1200,
      },
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurn = turns.find(turn => turn.type === 'assistant')
    if (!assistantTurn || assistantTurn.type !== 'assistant') throw new Error('expected assistant turn')

    const intermediate = assistantTurn.activities.find(activity => activity.type === 'intermediate')
    expect(intermediate?.messageId).toBe('assistant-intermediate-2')
    expect(intermediate?.annotations).toEqual([anns])
    // The final response keeps its own (absent) annotations — no bleed across messages.
    expect(assistantTurn.response?.messageId).toBe('assistant-final-1')
    expect(assistantTurn.response?.annotations).toBeUndefined()
  })
})

describe('buildAnnotatableTurnIndex (long transcripts)', () => {
  function longTranscript(turnCount: number): Message[] {
    const messages: Message[] = []
    for (let i = 0; i < turnCount; i++) {
      messages.push({ id: `user-${i}`, role: 'user', content: `ask ${i}`, timestamp: i * 100 + 1 })
      messages.push({ id: `assistant-${i}`, role: 'assistant', content: `answer ${i}`, timestamp: i * 100 + 2 })
    }
    return messages
  }

  it('maps every response message id to its turn index across a 60-turn transcript', () => {
    const turns = groupMessagesByTurn(longTranscript(60))
    const index = buildAnnotatableTurnIndex(turns)

    // The oldest annotated message must still be locatable — this is what lets
    // the composer chip widen the reverse-pagination window (TURNS_PER_PAGE=20)
    // until the turn is mounted.
    const oldest = index.get('assistant-0')
    expect(oldest).toBeDefined()
    expect(turns[oldest!]?.type).toBe('assistant')

    const newest = index.get('assistant-59')
    expect(newest).toBeDefined()
    expect(newest!).toBeGreaterThan(oldest!)

    // Turns needed to reveal the oldest annotated turn exceeds one page, i.e.
    // the caller genuinely has to expand the window.
    expect(turns.length - oldest!).toBeGreaterThan(20)
  })

  it('maps plan message ids too (plans render as annotatable ResponseCards)', () => {
    const messages: Message[] = [
      ...(() => {
        const filler: Message[] = []
        for (let i = 0; i < 30; i++) {
          filler.push({ id: `user-${i}`, role: 'user', content: `ask ${i}`, timestamp: i * 100 + 1 })
          filler.push({ id: `assistant-${i}`, role: 'assistant', content: `answer ${i}`, timestamp: i * 100 + 2 })
        }
        return filler
      })(),
      { id: 'user-plan', role: 'user', content: 'plan it', timestamp: 9000 },
      {
        id: 'tool-plan',
        role: 'tool',
        content: 'Submitting plan',
        timestamp: 9100,
        toolName: 'mcp__session__SubmitPlan',
        toolUseId: 'tu-plan',
        toolStatus: 'completed',
      },
      {
        id: 'plan-msg-1',
        role: 'plan',
        content: '# Plan\n- Step 1',
        timestamp: 9200,
        annotations: [annotation('ann-plan-1', 'plan-msg-1', 'Step 1')],
      },
    ]

    const index = buildAnnotatableTurnIndex(groupMessagesByTurn(messages))
    expect(index.get('plan-msg-1')).toBeDefined()
  })

  it('returns an empty index for a transcript with no assistant turns', () => {
    const index = buildAnnotatableTurnIndex(groupMessagesByTurn([
      { id: 'user-1', role: 'user', content: 'hi', timestamp: 1 },
    ]))
    expect(index.size).toBe(0)
  })
})
