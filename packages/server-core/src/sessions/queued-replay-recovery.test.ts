/**
 * SUV-0066 — what survives a process boundary, and what must not act across it.
 *
 * Two halves of the same lesson. A queued message outlives its process through
 * `isQueued` on the persisted message, and the queue entry rebuilt from it had
 * silently lost the skill slugs the original send carried — so the replay
 * skipped the source pre-enabling that `[skill:…]` exists to trigger. And
 * `generateTitle` is fired un-awaited and untracked, so the only thing keeping
 * it from mutating a session after that session's final state has been written
 * is its own refusal to act once the freeze has landed.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSessionFilePath,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession, skillSlugsFromBadges } from './SessionManager.ts'

describe('skillSlugsFromBadges', () => {
  const badge = (over: Record<string, unknown>) => ({
    type: 'skill', label: 'Commit', rawText: '[skill:commit]', start: 0, end: 0, ...over,
  }) as never

  it('recovers the slug from both mention forms', () => {
    expect(skillSlugsFromBadges([badge({})])).toEqual(['commit'])
    expect(skillSlugsFromBadges([badge({ rawText: '[skill:my workspace.1:roadmap-plan-advance]' })]))
      .toEqual(['roadmap-plan-advance'])
  })

  it('ignores badges that are not skills, and de-duplicates', () => {
    expect(skillSlugsFromBadges([
      badge({ type: 'source', rawText: '[source:linear]' }),
      badge({ type: 'file', rawText: '[file:/etc/passwd]' }),
      badge({}),
      badge({}),
    ])).toEqual(['commit'])
  })

  it('refuses a badge whose rawText is not the bracket form', () => {
    // A badge is CONTENT: it travels with a message, is persisted, and nothing
    // revalidates it on the way back in — while the slug it yields reaches
    // `loadSkillBySlug`, which builds a filesystem path out of it. So the shape
    // is the check, and it cannot express a path.
    for (const rawText of [
      '[skill:../../../etc/passwd]',
      '[skill:a/b]',
      '[skill:]',
      'commit',
      '[skill:commit',
      '[skill:commit] and more',
      '',
    ]) {
      expect(skillSlugsFromBadges([badge({ rawText })])).toBeUndefined()
    }
    expect(skillSlugsFromBadges([badge({ rawText: undefined })])).toBeUndefined()
    expect(skillSlugsFromBadges(undefined)).toBeUndefined()
    expect(skillSlugsFromBadges([])).toBeUndefined()
  })
})

describe('recovering a queued message across a restart', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'queued-replay-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  function seedWithQueuedMessage(id: string, badges?: unknown[]) {
    const filePath = getSessionFilePath(root, id)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id,
      workspaceRootPath: root,
      name: 'Replay session',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'run the commit skill', id: 'm1', isQueued: true, badges }],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id, name: 'Replay session', sessionStatus: 'todo', createdAt: Date.now() },
      { id: 'ws_replay', name: 'Replay WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messages = [{ role: 'user', content: 'run the commit skill', id: 'm1', isQueued: true, badges }]
    managed.messageQueue = []
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('carries the skill slugs the original send passed into the replayed options', () => {
    // `options` is not persisted, so a replay rebuilt it as `undefined` and the
    // pre-enable block (`if (options?.skillSlugs?.length)`) never ran: the
    // replayed turn started with the skill's required sources disabled, which is
    // exactly the two-turn penalty that block exists to remove.
    const managed = seedWithQueuedMessage('sess_replay_skill', [
      { type: 'skill', label: 'Commit', rawText: '[skill:commit]', start: 0, end: 0 },
    ])

    ;(sm as unknown as {
      recoverOrphanedQueuedMessages(m: unknown): void
    }).recoverOrphanedQueuedMessages(managed)

    const queue = managed.messageQueue as Array<{ messageId?: string; options?: { skillSlugs?: string[] } }>
    expect(queue).toHaveLength(1)
    expect(queue[0]!.messageId).toBe('m1')
    // The one member with an effect the replay would otherwise drop.
    expect(queue[0]!.options?.skillSlugs).toEqual(['commit'])
  })

  it('leaves options undefined when the message invoked no skill', () => {
    const managed = seedWithQueuedMessage('sess_replay_plain')
    ;(sm as unknown as {
      recoverOrphanedQueuedMessages(m: unknown): void
    }).recoverOrphanedQueuedMessages(managed)

    const queue = managed.messageQueue as Array<{ options?: unknown }>
    expect(queue).toHaveLength(1)
    expect(queue[0]!.options).toBeUndefined()
  })

  it('does not turn a forged skill badge into a filesystem lookup', () => {
    const managed = seedWithQueuedMessage('sess_replay_forged', [
      { type: 'skill', label: 'Commit', rawText: '[skill:../../../../etc/passwd]', start: 0, end: 0 },
    ])
    ;(sm as unknown as {
      recoverOrphanedQueuedMessages(m: unknown): void
    }).recoverOrphanedQueuedMessages(managed)

    const queue = managed.messageQueue as Array<{ options?: unknown }>
    expect(queue[0]!.options).toBeUndefined()
  })
})

describe('a title generated across a shutdown', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'title-quit-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  it('never asks the provider once the freeze has landed', async () => {
    // Discarding the answer is not enough on its own: a quit can begin while the
    // backend is still being stood up, and a title asked for after that point is
    // one whose answer is already destined for the discard. So the request is
    // not made at all — the check sits before it, inside the `try` whose
    // `finally` tears down a temporary backend.
    const sessionId = 'sess_title_no_request'
    const filePath = getSessionFilePath(root, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: sessionId,
      workspaceRootPath: root,
      name: 'Fallback name',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'hello' }],
    } as unknown as StoredSession)

    let asked = false
    const managed = createManagedSession(
      { id: sessionId, name: 'Fallback name', sessionStatus: 'todo', createdAt: Date.now() },
      { id: 'ws_title', name: 'Title WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'hello' }]
    managed.messageQueue = []
    managed.agent = { generateTitle: async () => { asked = true; return 'A Title' } }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    await sm.flushAllSessions()
    await (sm as unknown as {
      generateTitle(m: unknown, msg: string): Promise<void>
    }).generateTitle(managed, 'hello')

    expect(asked).toBe(false)
    expect(managed.name).toBe('Fallback name')

    sessionPersistenceQueue.reopenAfterFlushAll()
    rmSync(root, { recursive: true, force: true })
  }, 20000)

  it('is discarded rather than applied, announced, or logged as a success', async () => {
    // `generateTitle` is fired un-awaited from the send path and is not one of
    // the producers `stopPersistenceProducers` stops — a quit cannot be held
    // open for a model round-trip. So what bounds it is that it must not ACT
    // after the freeze: applying the title would mutate a session whose final
    // state has already been written and enqueue a write the closing queue
    // refuses, leaving memory, disk and the renderer disagreeing.
    const sessionId = 'sess_title_quit'
    const filePath = getSessionFilePath(root, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: sessionId,
      workspaceRootPath: root,
      name: 'Fallback name',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'hello' }],
    } as unknown as StoredSession)

    let releaseTitle!: () => void
    const titleHeld = new Promise<void>((r) => { releaseTitle = r })
    const managed = createManagedSession(
      { id: sessionId, name: 'Fallback name', sessionStatus: 'todo', createdAt: Date.now() },
      { id: 'ws_title', name: 'Title WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'hello' }]
    managed.messageQueue = []
    managed.agent = {
      generateTitle: async () => { await titleHeld; return 'An AI Generated Title' },
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    const events: Array<{ type: string }> = []
    ;(sm as unknown as { sendEvent(e: { type: string }, w?: string): void }).sendEvent = (e) => { events.push(e) }

    const titling = (sm as unknown as {
      generateTitle(m: unknown, msg: string): Promise<void>
    }).generateTitle(managed, 'hello')

    await sm.flushAllSessions()
    releaseTitle()
    await titling

    // The fallback name stands, in memory and on disk.
    expect(managed.name).toBe('Fallback name')
    const onDisk = readFileSync(filePath, 'utf-8')
    expect(onDisk).not.toContain('An AI Generated Title')
    expect(onDisk).toContain('Fallback name')
    // And the renderer was never told about a title that does not exist.
    expect(events.some((e) => e.type === 'title_generated')).toBe(false)

    // The shared singleton outlives this suite; a closed queue would refuse
    // every later suite's writes.
    sessionPersistenceQueue.reopenAfterFlushAll()
    rmSync(root, { recursive: true, force: true })
  }, 20000)
})
