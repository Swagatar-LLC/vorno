/**
 * SUV-0066 — a queued message crossing a process boundary, end to end.
 *
 * The claim under test is not "the recovery helper builds the right object". It
 * is that a send which was queued in one process replays in the NEXT one with
 * the skill slugs it was sent with, and pre-enables that skill's required
 * sources before the turn — which is the whole reason the slugs are persisted.
 * So this drives the real path: a real send with `skillSlugs` and no badges
 * (what an automation or CLI send looks like), through the real JSONL file, into
 * a second `SessionManager` that hydrates it cold, against a real skill file and
 * a real source config on disk.
 *
 * The second half covers the other direction: `generateTitle` is fired
 * un-awaited and untracked, so the only thing keeping it from acting after its
 * session's final state has been written is its own refusal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSessionFilePath,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession, normalizeQueuedSkillSlugs } from './SessionManager.ts'

const SKILL_SLUG = 'commit-helper'
const SOURCE_SLUG = 'linear-fixture'

describe('normalizeQueuedSkillSlugs', () => {
  it('keeps well-formed slugs, once each', () => {
    expect(normalizeQueuedSkillSlugs(['commit', 'commit', 'roadmap-plan_advance'])).toEqual([
      'commit', 'roadmap-plan_advance',
    ])
    expect(normalizeQueuedSkillSlugs(['  spaced  '])).toEqual(['spaced'])
  })

  it('drops anything that is not a bare slug', () => {
    // This value round-trips through a JSONL file a user can edit and comes back
    // to `loadSkillBySlug`, which builds a filesystem path out of it. The shape
    // check is what keeps it a name rather than a route, and it runs on the way
    // out AND on the way back in.
    expect(normalizeQueuedSkillSlugs(['../../../etc/passwd'])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(['a/b', 'c\\d', '..', 'has space', ''])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs([42, null, undefined, {}] as unknown[])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(undefined)).toBeUndefined()
    expect(normalizeQueuedSkillSlugs([])).toBeUndefined()
  })

  it('keeps the good slugs out of a mixed list', () => {
    expect(normalizeQueuedSkillSlugs(['../escape', 'commit'])).toEqual(['commit'])
  })
})

describe('a queued send crossing a process boundary', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'queued-replay-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })

    // A real skill that declares a required source, where `loadSkillBySlug`
    // looks for it.
    const skillDir = join(root, 'skills', SKILL_SLUG)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: Commit Helper',
      'description: Writes commits.',
      'requiredSources:',
      `  - ${SOURCE_SLUG}`,
      '---',
      '',
      'Body.',
    ].join('\n'))

    // A real source config that `isSourceUsable` accepts: enabled, no auth.
    const sourceDir = join(root, 'sources', SOURCE_SLUG)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      slug: SOURCE_SLUG,
      name: 'Linear Fixture',
      type: 'mcp',
      enabled: true,
      mcp: { authType: 'none', command: 'true', args: [] },
    }))
  })

  afterEach(() => {
    // The shared singleton outlives this suite; a closed queue would refuse
    // every later suite's writes.
    sessionPersistenceQueue.reopenAfterFlushAll()
    rmSync(root, { recursive: true, force: true })
  })

  const workspace = () => ({
    id: 'ws_replay', name: 'Replay WS', rootPath: root, createdAt: Date.now(),
  } as never)

  function seed(sm: SessionManager, id: string, extra: Record<string, unknown> = {}) {
    const filePath = getSessionFilePath(root, id)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id,
      workspaceRootPath: root,
      name: 'Replay session',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id, name: 'Replay session', sessionStatus: 'todo', createdAt: Date.now() },
      workspace(),
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = []
    managed.messageQueue = []
    Object.assign(managed, extra)
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('replays in a new process with its skill slugs, and enables the required source first', async () => {
    const sessionId = 'sess_process_boundary'

    // ---- Process 1: a real send that gets queued. No badges anywhere: this is
    // what an automation or CLI send looks like, which is exactly the case a
    // badge-derived reconstruction could never have covered.
    const first = new SessionManager()
    const managed = seed(first, sessionId)
    // A real turn, so the send lands on the mid-stream branch and the session
    // carries a finalisation deferred like any other running turn.
    ;(first as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void })
      .setProcessing(managed, true)
    await first.sendMessage(sessionId, 'run the commit helper', undefined, undefined, {
      skillSlugs: [SKILL_SLUG],
    })
    ;(first as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void })
      .setProcessing(managed, false, 'no-tail')

    // Already on disk: the mid-stream path flushes before it acks. On disk as
    // queued, carrying the slugs — and carrying no badges.
    const stored = JSON.parse(
      readFileSync(getSessionFilePath(root, sessionId), 'utf-8')
        .trim().split('\n').slice(1).find(l => l.includes('run the commit helper'))!,
    ) as Record<string, unknown>
    expect(stored.isQueued).toBe(true)
    expect(stored.queuedSkillSlugs).toEqual([SKILL_SLUG])
    expect(stored.badges).toBeUndefined()

    // ---- Process 2: a fresh manager hydrates the session cold.
    const second = new SessionManager()
    const revived = createManagedSession(
      { id: sessionId, name: 'Replay session', sessionStatus: 'todo', createdAt: Date.now() },
      workspace(),
    ) as unknown as Record<string, unknown>
    revived.messageQueue = []
    ;(second as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, revived)

    // The turn itself is faked: this asserts what happens BEFORE one, and a real
    // backend would be the only thing in the test that is not the thing under
    // test. Throwing is what stops the send at the boundary of that fake.
    ;(second as unknown as {
      getOrCreateAgent(m: unknown): Promise<unknown>
    }).getOrCreateAgent = async () => { throw new Error('fake turn boundary') }

    await (second as unknown as {
      ensureMessagesLoaded(m: unknown): Promise<void>
    }).ensureMessagesLoaded(revived)

    // Hydration re-queued it, with the slugs recovered from disk.
    const queue = revived.messageQueue as Array<{ messageId?: string; options?: { skillSlugs?: string[] } }>
    expect(queue).toHaveLength(1)
    expect(queue[0]!.options?.skillSlugs).toEqual([SKILL_SLUG])

    // Hydration scheduled the replay itself; let it run and settle. Waiting is
    // the point — a test that schedules work it does not wait for reports on a
    // state it never observed — and the replay ends in the fake turn boundary,
    // which `processNextQueuedMessage` catches.
    await new Promise((r) => setTimeout(r, 50))

    // THE POINT: the skill's required source was enabled before the turn.
    expect(revived.enabledSourceSlugs as string[]).toContain(SOURCE_SLUG)
    // And the durable marker was released only once a turn owned the message.
    const replayed = (revived.messages as Array<{ content?: string; isQueued?: boolean; queuedSkillSlugs?: unknown }>)
      .find((m) => m.content === 'run the commit helper')
    expect(replayed?.isQueued).toBeFalsy()
    expect(replayed?.queuedSkillSlugs).toBeUndefined()
  }, 30000)

  it('keeps the durable marker when the replay is refused by a shutdown', async () => {
    // At-least-once, never lost. `processNextQueuedMessage` claims the admission
    // synchronously and only then gives the message up, so a quit landing in the
    // gap waits for the send — and the send refuses with the marker still true,
    // which is what makes the message come back on the next launch.
    const sessionId = 'sess_replay_refused'
    const sm = new SessionManager()
    const managed = seed(sm, sessionId)
    const turns = sm as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void }
    turns.setProcessing(managed, true)
    await sm.sendMessage(sessionId, 'queued then refused', undefined, undefined, {
      skillSlugs: [SKILL_SLUG],
    })
    turns.setProcessing(managed, false, 'no-tail')
    expect((managed.messageQueue as unknown[]).length).toBe(1)

    // The replay is handed off, then the quit lands in the gap before it runs.
    ;(sm as unknown as { processNextQueuedMessage(id: string): void }).processNextQueuedMessage(sessionId)
    // Owned SYNCHRONOUSLY, before the handoff: this is the property that makes
    // the gap safe, and it is observable right here.
    expect((sm as unknown as { sendAdmissions: Map<symbol, unknown> }).sendAdmissions.size).toBe(1)
    await sm.flushAllSessions()
    await new Promise((r) => setTimeout(r, 20))

    const onDisk = readFileSync(getSessionFilePath(root, sessionId), 'utf-8')
    const line = onDisk.trim().split('\n').slice(1).find(l => l.includes('queued then refused'))!
    const stored = JSON.parse(line) as Record<string, unknown>
    expect(stored.isQueued).toBe(true)
    expect(stored.queuedSkillSlugs).toEqual([SKILL_SLUG])
    // The refused replay started no turn and left no second copy of the message.
    expect(managed.isProcessing).toBe(false)
    expect((managed.messages as Array<{ content?: string }>)
      .filter((m) => m.content === 'queued then refused')).toHaveLength(1)
  }, 30000)
})

describe('a title generated across a shutdown', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'title-quit-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    sessionPersistenceQueue.reopenAfterFlushAll()
    rmSync(root, { recursive: true, force: true })
  })

  function seedForTitle(sessionId: string, agent: unknown) {
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

    const managed = createManagedSession(
      { id: sessionId, name: 'Fallback name', sessionStatus: 'todo', createdAt: Date.now() },
      { id: 'ws_title', name: 'Title WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'hello' }]
    managed.messageQueue = []
    managed.agent = agent
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return { managed, filePath }
  }

  it('never asks the provider once the freeze has landed', async () => {
    // Discarding the answer is not enough on its own: a quit can begin while the
    // backend is still being stood up, and a title asked for after that point is
    // one whose answer is already destined for the discard.
    let asked = false
    const { managed } = seedForTitle('sess_title_no_request', {
      generateTitle: async () => { asked = true; return 'A Title' },
    })

    await sm.flushAllSessions()
    await (sm as unknown as {
      generateTitle(m: unknown, msg: string): Promise<void>
    }).generateTitle(managed, 'hello')

    expect(asked).toBe(false)
    expect(managed.name).toBe('Fallback name')
  }, 20000)

  it('is discarded rather than applied, announced, or logged as a success', async () => {
    // The in-flight case: the request was already out when the freeze landed.
    // Applying its answer would mutate a session whose final state has been
    // written and enqueue a write the closing queue refuses, leaving memory,
    // disk and the renderer disagreeing about the name.
    let releaseTitle!: () => void
    const titleHeld = new Promise<void>((r) => { releaseTitle = r })
    const { managed, filePath } = seedForTitle('sess_title_quit', {
      generateTitle: async () => { await titleHeld; return 'An AI Generated Title' },
    })

    const events: Array<{ type: string }> = []
    ;(sm as unknown as { sendEvent(e: { type: string }, w?: string): void }).sendEvent = (e) => { events.push(e) }

    const titling = (sm as unknown as {
      generateTitle(m: unknown, msg: string): Promise<void>
    }).generateTitle(managed, 'hello')

    await sm.flushAllSessions()
    releaseTitle()
    await titling

    expect(managed.name).toBe('Fallback name')
    expect(existsSync(filePath)).toBe(true)
    const onDisk = readFileSync(filePath, 'utf-8')
    expect(onDisk).not.toContain('An AI Generated Title')
    expect(onDisk).toContain('Fallback name')
    expect(events.some((e) => e.type === 'title_generated')).toBe(false)
  }, 20000)
})
