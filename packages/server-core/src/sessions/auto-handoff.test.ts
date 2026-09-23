/**
 * fork(PLAN-055 / SUV-0072): the built-in auto-handoff consumer.
 *
 * Covers the two halves of the contract: (1) the handoff prompt is delivered
 * through `sendMessage` exactly once per eligible session, only when the
 * workspace setting is enabled, with a restart-safe latch; (2) the configured
 * status and archive apply only after the handoff turn has completed, through
 * the PLAN-031 choke point with a host origin (so a closed status is allowed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_AUTO_HANDOFF_PROMPT } from '@craft-agent/shared/context-usage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type SentMessage = { sessionId: string; message: string; options?: { skillSlugs?: string[] } }

const flushTimers = () => new Promise<void>((r) => setTimeout(r, 5))

describe('SessionManager auto-handoff (SUV-0072)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let sent: SentMessage[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-auto-handoff-'))
    sm = new SessionManager()
    sent = []
    ;(sm as unknown as { automationSystems: Map<string, unknown> }).automationSystems.set(tmpRoot, {
      emit: async () => {},
      updateSessionMetadata: async () => {},
    })
    // The delivery path is the real `sendMessage`; here we intercept it so the
    // test asserts the CALL contract (once, with skill slugs, acked) without a
    // live agent. The ack mirrors what the real path does after persisting.
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = async (
      sessionId: string, message: string, _a: unknown, _b: unknown, options?: { skillSlugs?: string[] },
      _c?: unknown, _d?: unknown, onAck?: (id: string) => void,
    ) => {
      sent.push({ sessionId, message, options })
      onAck?.(`handoff-msg-${sent.length}`)
    }
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function writeConfig(autoHandoff: Record<string, unknown> | undefined) {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
      id: 'ws_ah', name: 'AH Workspace', slug: 'ah', createdAt: 1, updatedAt: 1,
      defaults: autoHandoff ? { autoHandoff } : {},
    }))
  }

  function buildSession(id: string, extra: Record<string, unknown> = {}) {
    const managed = createManagedSession(
      { id, name: 'handoff test', model: 'test-model-ah', ...extra } as never,
      { id: 'ws_ah', name: 'AH Workspace', rootPath: tmpRoot, createdAt: Date.now() } as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function sample(managed: ReturnType<typeof buildSession>, inputTokens: number) {
    managed.tokenUsage = { inputTokens, outputTokens: 0, totalTokens: inputTokens, contextTokens: 0, costUsd: 0, contextWindow: 100_000 }
    sm.observeContextThresholds(managed)
  }

  it('delivers the configured prompt once on the first warn crossing, with resolved skills', async () => {
    writeConfig({ enabled: true, prompt: 'Wrap up with [skill:not-installed] and hand off.' })
    const managed = buildSession('ah-basic')

    sample(managed, 50_000)
    await flushTimers()
    expect(sent).toHaveLength(0)

    sample(managed, 65_000)
    await flushTimers()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ sessionId: 'ah-basic', message: 'Wrap up with [skill:not-installed] and hand off.' })
    expect(sent[0]!.options).toBeUndefined() // the mentioned skill is not installed → no slugs
    expect(managed.contextThresholdState).toMatchObject({
      warnReachedAt: expect.any(Number),
      autoHandoffFiredAt: expect.any(Number),
      autoHandoffPending: false,
      autoHandoffMessageId: 'handoff-msg-1',
    })

    // Later crossings (danger) and repeated samples never re-deliver.
    sample(managed, 85_000)
    sample(managed, 95_000)
    await flushTimers()
    expect(sent).toHaveLength(1)
  })

  it('uses the default prompt when the configured one is blank and lands straight in danger', async () => {
    writeConfig({ enabled: true, prompt: '   ' })
    const managed = buildSession('ah-default')
    sample(managed, 90_000)
    await flushTimers()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.message).toBe(DEFAULT_AUTO_HANDOFF_PROMPT)
  })

  it('does nothing when the setting is off, absent, or the session is ineligible', async () => {
    writeConfig({ enabled: false, prompt: 'x' })
    sample(buildSession('ah-off'), 65_000)
    writeConfig(undefined)
    sample(buildSession('ah-absent'), 65_000)
    writeConfig({ enabled: true })
    sample(buildSession('ah-hidden', { hidden: true }), 65_000)
    sample(buildSession('ah-task', { taskSlug: 't' }), 65_000)
    await flushTimers()
    expect(sent).toHaveLength(0)
  })

  it('does not re-fire for a session reloaded with a persisted handoff latch', async () => {
    writeConfig({ enabled: true })
    const managed = buildSession('ah-reloaded', { contextThresholdState: { warnReachedAt: 1, autoHandoffFiredAt: 2 } })
    sample(managed, 85_000)
    await flushTimers()
    expect(sent).toHaveLength(0)
  })

  it('marks follow-through pending when a status or archive is configured', async () => {
    writeConfig({ enabled: true, status: 'done' })
    const managed = buildSession('ah-pending')
    sample(managed, 65_000)
    await flushTimers()
    expect(managed.contextThresholdState?.autoHandoffPending).toBe(true)
  })

  describe('completeAutoHandoff', () => {
    const complete = (managed: ReturnType<typeof buildSession>, reason = 'complete') =>
      (sm as unknown as { completeAutoHandoff: (m: unknown, r: string) => Promise<void> }).completeAutoHandoff(managed, reason)

    function pendingSession(id: string, messages: Array<{ id: string; role: 'user' | 'assistant'; isQueued?: boolean }>) {
      const managed = buildSession(id, {
        contextThresholdState: { warnReachedAt: 1, autoHandoffFiredAt: 2, autoHandoffPending: true, autoHandoffMessageId: 'handoff-msg' },
      })
      managed.messages = messages.map(m => ({ ...m, content: '', timestamp: 1 })) as never
      return managed
    }

    it('applies a closed status and archives after the handoff turn completed', async () => {
      writeConfig({ enabled: true, status: 'done', archive: true })
      const managed = pendingSession('ah-done', [
        { id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' },
        { id: 'handoff-msg', role: 'user' }, { id: 'a2', role: 'assistant' },
      ])
      await complete(managed)
      expect(managed.sessionStatus).toBe('done')
      expect(managed.isArchived).toBe(true)
      expect(managed.contextThresholdState).toMatchObject({ autoHandoffPending: false, autoHandoffCompletedAt: expect.any(Number) })
    })

    it('waits while the handoff message is still queued or unanswered', async () => {
      writeConfig({ enabled: true, status: 'done' })
      const queued = pendingSession('ah-queued', [{ id: 'handoff-msg', role: 'user', isQueued: true }])
      await complete(queued)
      expect(queued.sessionStatus).toBeUndefined()
      expect(queued.contextThresholdState?.autoHandoffPending).toBe(true)

      const unanswered = pendingSession('ah-unanswered', [{ id: 'a0', role: 'assistant' }, { id: 'handoff-msg', role: 'user' }])
      await complete(unanswered)
      expect(unanswered.sessionStatus).toBeUndefined()

      const notSent = buildSession('ah-not-sent', { contextThresholdState: { warnReachedAt: 1, autoHandoffFiredAt: 2, autoHandoffPending: true } })
      await complete(notSent)
      expect(notSent.contextThresholdState?.autoHandoffPending).toBe(true)
    })

    it('ignores interrupted or errored stops and sessions with nothing pending', async () => {
      writeConfig({ enabled: true, status: 'done', archive: true })
      const managed = pendingSession('ah-interrupted', [{ id: 'handoff-msg', role: 'user' }, { id: 'a1', role: 'assistant' }])
      await complete(managed, 'interrupted')
      await complete(managed, 'error')
      expect(managed.sessionStatus).toBeUndefined()
      expect(managed.isArchived).toBeUndefined()

      const idle = buildSession('ah-idle')
      await complete(idle)
      expect(idle.sessionStatus).toBeUndefined()
    })

    it('honors a status-only configuration and re-reads settings at completion', async () => {
      writeConfig({ enabled: true, status: 'done', archive: true })
      const managed = pendingSession('ah-status-only', [{ id: 'handoff-msg', role: 'user' }, { id: 'a1', role: 'assistant' }])
      // The user turned archive off while the handoff turn ran.
      writeConfig({ enabled: true, status: 'todo', archive: false })
      await complete(managed)
      expect(managed.sessionStatus).toBe('todo')
      expect(managed.isArchived).toBeUndefined()
    })
  })
})
