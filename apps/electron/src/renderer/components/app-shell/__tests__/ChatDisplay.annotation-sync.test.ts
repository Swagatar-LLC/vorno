/**
 * Convergence tests for annotation deletes — the "phantom follow-up chip you
 * cannot delete" family (LEARNING-035, and the 260724-light-delta recurrence on
 * 2026-07-25).
 *
 * These exercise the renderer code path that the **webui** runs: `apps/webui`
 * builds the same renderer modules over the WS adapter, so a delete issued from
 * mobile Safari lands in exactly these functions. The scenarios below are
 * written as the incident's failure modes:
 *
 *   - the `message_annotations_updated` event never arrives (dropped over the
 *     single-port WS proxy / suspended background tab)
 *   - the delete happens mid-turn, while the agent is streaming
 *   - the delete happens after a reconnect whose replay window had expired, so
 *     the local mirror is stale AND the reconciling event is gone
 *
 * The invariant under test: **a delete converges on the command result alone.**
 * No test here dispatches an annotations event — that is the point.
 */

import { describe, test, expect } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import type { Message } from '../../../../shared/types'
import {
  shouldConvergeRemoveLocally,
  removeAnnotationFromMessages,
} from '../ChatDisplay.annotation-sync'
import { derivePendingFollowUps } from '../ChatDisplay.follow-ups'

// ---------------------------------------------------------------------------
// Fixtures — modelled on the real incident payloads
// ---------------------------------------------------------------------------

const NOTE = 'The wording is fantastic, thank you for the reminder.'

function annotation(id: string, overrides: Partial<AnnotationV1> = {}): AnnotationV1 {
  return {
    id,
    schemaVersion: 1,
    createdAt: 1784955701660,
    target: {
      source: { sessionId: 'sess-1', messageId: 'msg-jztmef' },
      selectors: [{ type: 'text-quote', exact: '#119 wording' }],
    },
    body: [{ type: 'note', text: NOTE }],
    meta: { followUp: { text: NOTE } },
    ...overrides,
  } as AnnotationV1
}

function assistantMessage(id: string, annotations: AnnotationV1[]): Message {
  return {
    id,
    role: 'assistant',
    content: 'Closed #119 wording and drained the queue.',
    timestamp: 1784951146533,
    annotations,
  } as Message
}

/** The state a client is in when it holds an annotation the server does not. */
function phantomState(): Message[] {
  return [
    assistantMessage('msg-jztmef', [annotation('ann-0yhril')]),
    assistantMessage('msg-frtd7a', [annotation('ann-q7jy93', {
      target: {
        source: { sessionId: 'sess-1', messageId: 'msg-frtd7a' },
        selectors: [{ type: 'text-quote', exact: 'drain complete' }],
      },
    } as Partial<AnnotationV1>)]),
  ]
}

// ---------------------------------------------------------------------------

describe('shouldConvergeRemoveLocally — when is the server\'s answer authoritative?', () => {
  test('plain success converges', () => {
    expect(shouldConvergeRemoveLocally({ success: true })).toBe(true)
  })

  test('idempotent no-op (post-LEARNING-035 server: already absent → success) converges', () => {
    // This is the reply Jeff got at 05:16:43 UTC. Before this fix the client did
    // nothing with it and waited for an event that never came.
    expect(shouldConvergeRemoveLocally({ success: true })).toBe(true)
  })

  test('annotation-not-found converges — the desired end state already holds', () => {
    // Pre-LEARNING-035 servers, and a racing double-delete on current ones.
    expect(shouldConvergeRemoveLocally({ success: false, reason: 'annotation-not-found' })).toBe(true)
  })

  test('message-not-found does NOT converge — the server could not even look', () => {
    expect(shouldConvergeRemoveLocally({ success: false, reason: 'message-not-found' })).toBe(false)
  })

  test('session-not-found does NOT converge', () => {
    expect(shouldConvergeRemoveLocally({ success: false, reason: 'session-not-found' })).toBe(false)
  })

  test('an unparseable reply does not converge (only act on an answer we understood)', () => {
    expect(shouldConvergeRemoveLocally(undefined)).toBe(false)
    expect(shouldConvergeRemoveLocally(null)).toBe(false)
    expect(shouldConvergeRemoveLocally({})).toBe(false)
    expect(shouldConvergeRemoveLocally({ success: 'yes' })).toBe(false)
  })
})

describe('removeAnnotationFromMessages — the local mirror edit', () => {
  test('drops the target annotation', () => {
    const next = removeAnnotationFromMessages(phantomState(), 'msg-jztmef', 'ann-0yhril')
    expect(next).not.toBeNull()
    expect(next![0]!.annotations).toEqual([])
  })

  test('leaves every other message and annotation untouched', () => {
    const before = phantomState()
    const next = removeAnnotationFromMessages(before, 'msg-jztmef', 'ann-0yhril')!
    expect(next[1]!.annotations?.map(a => a.id)).toEqual(['ann-q7jy93'])
    // Identity preserved for untouched messages so memoized turn cards don't re-render.
    expect(next[1]).toBe(before[1]!)
  })

  test('does not mutate the input array', () => {
    const before = phantomState()
    removeAnnotationFromMessages(before, 'msg-jztmef', 'ann-0yhril')
    expect(before[0]!.annotations?.map(a => a.id)).toEqual(['ann-0yhril'])
  })

  test('returns null when nothing changed (skips a pointless state write)', () => {
    expect(removeAnnotationFromMessages(phantomState(), 'msg-jztmef', 'ann-nope')).toBeNull()
    expect(removeAnnotationFromMessages(phantomState(), 'msg-absent', 'ann-0yhril')).toBeNull()
    expect(removeAnnotationFromMessages([], 'msg-jztmef', 'ann-0yhril')).toBeNull()
    expect(removeAnnotationFromMessages(undefined, 'msg-jztmef', 'ann-0yhril')).toBeNull()
  })

  test('removes only the named annotation when a message carries several', () => {
    const messages = [assistantMessage('m1', [annotation('a1'), annotation('a2'), annotation('a3')])]
    const next = removeAnnotationFromMessages(messages, 'm1', 'a2')!
    expect(next[0]!.annotations?.map(a => a.id)).toEqual(['a1', 'a3'])
  })
})

// ---------------------------------------------------------------------------
// The regression itself: delete → chip gone, with no event in sight.
// ---------------------------------------------------------------------------

/**
 * Mirrors ChatDisplay's `onRemoveAnnotation`: issue the command, and if the
 * result says the annotation is gone, edit the local mirror. Nothing else —
 * in particular no `message_annotations_updated` is delivered anywhere in this
 * helper, which is the whole point.
 */
function clientDelete(
  messages: Message[],
  messageId: string,
  annotationId: string,
  serverReply: unknown,
): Message[] {
  if (!shouldConvergeRemoveLocally(serverReply)) return messages
  return removeAnnotationFromMessages(messages, messageId, annotationId) ?? messages
}

describe('deletes converge without the message_annotations_updated event', () => {
  test('normal delete clears the pending chip on the command result alone', () => {
    let messages = phantomState()
    expect(derivePendingFollowUps(messages).map(f => f.annotationId)).toEqual(['ann-0yhril', 'ann-q7jy93'])

    messages = clientDelete(messages, 'msg-jztmef', 'ann-0yhril', { success: true })

    expect(derivePendingFollowUps(messages).map(f => f.annotationId)).toEqual(['ann-q7jy93'])
  })

  test('PHANTOM: server already dropped it (idempotent no-op) — chip still clears', () => {
    // The 05:16:43 case. Server has nothing to remove, replies success, and
    // re-broadcasts. Assume the re-broadcast is dropped (it was).
    let messages = phantomState()
    messages = clientDelete(messages, 'msg-jztmef', 'ann-0yhril', { success: true })
    expect(derivePendingFollowUps(messages).some(f => f.annotationId === 'ann-0yhril')).toBe(false)
  })

  test('PHANTOM: an older server replying annotation-not-found also clears the chip', () => {
    let messages = phantomState()
    messages = clientDelete(messages, 'msg-jztmef', 'ann-0yhril', {
      success: false,
      reason: 'annotation-not-found',
    })
    expect(derivePendingFollowUps(messages).some(f => f.annotationId === 'ann-0yhril')).toBe(false)
  })

  test('retrying a converged delete is stable — the chip never comes back', () => {
    let messages = phantomState()
    for (let attempt = 0; attempt < 5; attempt++) {
      messages = clientDelete(messages, 'msg-jztmef', 'ann-0yhril', { success: true })
    }
    expect(derivePendingFollowUps(messages).map(f => f.annotationId)).toEqual(['ann-q7jy93'])
  })

  test('DELETE DURING A TURN: streaming/processing does not gate convergence', () => {
    // The incident's delete landed 9s after Jeff interrupted an unwanted turn.
    // Convergence is a pure edit of the mirror — nothing about it consults
    // isProcessing, and appending streamed messages must not resurrect the chip.
    let messages = phantomState()
    messages = clientDelete(messages, 'msg-jztmef', 'ann-0yhril', { success: true })

    // Agent keeps streaming: new messages arrive after the delete converged.
    const streamed = [...messages, assistantMessage('msg-new', [])]
    expect(derivePendingFollowUps(streamed).map(f => f.annotationId)).toEqual(['ann-q7jy93'])
  })

  test('DELETE AFTER RECONNECT: stale mirror + expired replay window still converges', () => {
    // Reconnect outside the 30s event buffer: the client reconnected with a
    // mirror that still holds ann-0yhril, and the annotations event that would
    // have reconciled it was evicted. Server-side the annotation is long gone.
    const staleMirrorAfterReconnect = phantomState()

    const messages = clientDelete(
      staleMirrorAfterReconnect,
      'msg-jztmef',
      'ann-0yhril',
      { success: true }, // server: already absent → idempotent success
    )

    expect(derivePendingFollowUps(messages).some(f => f.annotationId === 'ann-0yhril')).toBe(false)
  })

  test('deleting every follow-up empties the chip row', () => {
    let messages = phantomState()
    messages = clientDelete(messages, 'msg-jztmef', 'ann-0yhril', { success: true })
    messages = clientDelete(messages, 'msg-frtd7a', 'ann-q7jy93', { success: true })
    expect(derivePendingFollowUps(messages)).toEqual([])
  })

  test('a delete the server could not evaluate leaves the mirror alone (toast + reload path)', () => {
    const messages = clientDelete(phantomState(), 'msg-jztmef', 'ann-0yhril', {
      success: false,
      reason: 'message-not-found',
    })
    expect(derivePendingFollowUps(messages).map(f => f.annotationId)).toEqual(['ann-0yhril', 'ann-q7jy93'])
  })
})

describe('derivePendingFollowUps — chip derivation (the assertion surface above)', () => {
  test('a sent follow-up is not pending', () => {
    const sent = annotation('ann-sent', {
      meta: {
        followUp: {
          text: NOTE,
          lastSentAt: 1784956612831,
          lastSentText: NOTE,
        },
      },
    })
    expect(derivePendingFollowUps([assistantMessage('m1', [sent])])).toEqual([])
  })

  test('an annotation with no note is not a follow-up', () => {
    const highlightOnly = annotation('ann-hl', { body: [], meta: {} })
    expect(derivePendingFollowUps([assistantMessage('m1', [highlightOnly])])).toEqual([])
  })

  test('user messages never contribute follow-ups', () => {
    const userMsg = { ...assistantMessage('m1', [annotation('a1')]), role: 'user' } as Message
    expect(derivePendingFollowUps([userMsg])).toEqual([])
  })

  test('sorted oldest-first so chip numbering is stable', () => {
    const messages = [
      assistantMessage('m1', [annotation('late', { createdAt: 200 })]),
      assistantMessage('m2', [annotation('early', { createdAt: 100 })]),
    ]
    expect(derivePendingFollowUps(messages).map(f => f.annotationId)).toEqual(['early', 'late'])
  })

  test('empty/absent input yields no chips', () => {
    expect(derivePendingFollowUps([])).toEqual([])
    expect(derivePendingFollowUps(undefined)).toEqual([])
  })
})
