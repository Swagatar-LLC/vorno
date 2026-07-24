import { beforeEach, describe, expect, it } from 'bun:test'
import type { AnnotationV1, Message } from '@craft-agent/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'

/**
 * Regression test for the silent annotation-add failure.
 *
 * `addMessageAnnotation` / `updateMessageAnnotation` / `removeMessageAnnotation`
 * used to return `void` on every rejection branch (session/message missing,
 * duplicate id, per-message cap, ...). The RPC forwarded that `void` as a
 * resolved success, so the renderer's follow-up popup closed (markSubmitSuccess)
 * with nothing saved and no error — the annotation silently vanished.
 *
 * These methods now return an `AnnotationMutationResult` so the client can tell
 * success from rejection. This test pins the result for each branch.
 */

const SESSION_ID = 'sess-anno'
const MESSAGE_ID = 'msg-1'
const WORKSPACE = { id: 'ws-1', name: 'WS', rootPath: '/tmp/anno-ws', createdAt: 1 } as never

function buildAnnotation(id: string, opts?: { messageId?: string; start?: number; end?: number; bytes?: number }): AnnotationV1 {
  const start = opts?.start ?? 0
  const end = opts?.end ?? 5
  const exact = opts?.bytes ? 'x'.repeat(opts.bytes) : 'hello'
  return {
    id,
    schemaVersion: 1,
    createdAt: 1,
    body: [{ type: 'highlight' }],
    target: {
      source: { sessionId: SESSION_ID, messageId: opts?.messageId ?? MESSAGE_ID },
      selectors: [
        { type: 'text-position', start, end },
        { type: 'text-quote', exact, prefix: '', suffix: '' },
      ],
    },
  } as AnnotationV1
}

describe('message annotation mutation results', () => {
  let sm: SessionManager
  let events: Array<{ type: string }>

  function registerSession(annotations?: AnnotationV1[]) {
    const message = { id: MESSAGE_ID, role: 'assistant', content: 'hello world', timestamp: 1, annotations } as Message
    const managed = createManagedSession(
      { id: SESSION_ID },
      WORKSPACE,
      { messages: [message], messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)
    return message
  }

  beforeEach(() => {
    sm = new SessionManager()
    events = []
    // Avoid disk + transport side effects; capture emitted events.
    ;(sm as unknown as { persistSession: (m: unknown) => void }).persistSession = () => {}
    ;(sm as unknown as { sendEvent: (e: { type: string }) => void }).sendEvent = (e) => { events.push(e) }
  })

  it('returns success and emits an event when the add lands', () => {
    const message = registerSession()
    const result = sm.addMessageAnnotation(SESSION_ID, MESSAGE_ID, buildAnnotation('a1'))
    expect(result).toEqual({ success: true })
    expect(message.annotations?.length).toBe(1)
    expect(events.some(e => e.type === 'message_annotations_updated')).toBe(true)
  })

  it('rejects with session-not-found for an unregistered session', () => {
    const result = sm.addMessageAnnotation('nope', MESSAGE_ID, buildAnnotation('a1'))
    expect(result).toEqual({ success: false, reason: 'session-not-found' })
  })

  it('rejects with message-not-found when the message reference is stale', () => {
    registerSession()
    const result = sm.addMessageAnnotation(SESSION_ID, 'stale-msg', buildAnnotation('a1', { messageId: 'stale-msg' }))
    expect(result).toEqual({ success: false, reason: 'message-not-found' })
  })

  it('rejects with message-id-mismatch when the annotation targets another message', () => {
    registerSession()
    const result = sm.addMessageAnnotation(SESSION_ID, MESSAGE_ID, buildAnnotation('a1', { messageId: 'other' }))
    expect(result).toEqual({ success: false, reason: 'message-id-mismatch' })
  })

  it('rejects with duplicate-id when the annotation id already exists', () => {
    registerSession([buildAnnotation('dup')])
    const result = sm.addMessageAnnotation(SESSION_ID, MESSAGE_ID, buildAnnotation('dup'))
    expect(result).toEqual({ success: false, reason: 'duplicate-id' })
  })

  it('rejects with limit-reached at the per-message cap', () => {
    const seeded = Array.from({ length: 200 }, (_, i) => buildAnnotation(`seed-${i}`, { start: i, end: i + 1 }))
    registerSession(seeded)
    const result = sm.addMessageAnnotation(SESSION_ID, MESSAGE_ID, buildAnnotation('over', { start: 999, end: 1000 }))
    expect(result).toEqual({ success: false, reason: 'limit-reached' })
  })

  it('does not emit an event on a rejected add', () => {
    registerSession()
    sm.addMessageAnnotation('nope', MESSAGE_ID, buildAnnotation('a1'))
    expect(events.length).toBe(0)
  })

  it('update rejects with annotation-not-found and succeeds when present', () => {
    registerSession([buildAnnotation('a1')])
    expect(sm.updateMessageAnnotation(SESSION_ID, MESSAGE_ID, 'missing', { intent: 'comment' }))
      .toEqual({ success: false, reason: 'annotation-not-found' })
    expect(sm.updateMessageAnnotation(SESSION_ID, MESSAGE_ID, 'a1', { intent: 'comment' }))
      .toEqual({ success: true })
  })

  it('remove is idempotent: succeeds for a missing annotation and re-syncs the client', () => {
    registerSession([buildAnnotation('a1')])
    // Removing an already-absent annotation is a no-op that still succeeds (the
    // desired end state is reached) and re-broadcasts the message's current
    // annotations so a client holding a stale/phantom copy reconciles.
    expect(sm.removeMessageAnnotation(SESSION_ID, MESSAGE_ID, 'missing'))
      .toEqual({ success: true })
    expect(events.some(e => e.type === 'message_annotations_updated')).toBe(true)
    expect(sm.removeMessageAnnotation(SESSION_ID, MESSAGE_ID, 'a1'))
      .toEqual({ success: true })
  })

  it('remove still rejects when the message reference is stale', () => {
    registerSession([buildAnnotation('a1')])
    expect(sm.removeMessageAnnotation(SESSION_ID, 'stale-msg', 'a1'))
      .toEqual({ success: false, reason: 'message-not-found' })
  })
})
