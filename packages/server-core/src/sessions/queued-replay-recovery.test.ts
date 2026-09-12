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
    expect(normalizeQueuedSkillSlugs(['commit', 'commit', 'roadmap-plan-advance'])).toEqual([
      'commit', 'roadmap-plan-advance',
    ])
    expect(normalizeQueuedSkillSlugs(['  spaced  '])).toEqual(['spaced'])
    expect(normalizeQueuedSkillSlugs(['a1'])).toEqual(['a1'])
  })

  it('holds the repo slug shape: lowercase alphanumeric and hyphens', () => {
    // Stated compatibility rather than a discovered surprise: a skill DIRECTORY
    // may be named anything the filesystem allows, and one with a capital or an
    // underscore is mentionable today. Such a skill still runs — what it loses
    // is the source pre-enable, on the live path and the replayed one alike.
    expect(normalizeQueuedSkillSlugs(['My_Skill'])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(['Commit'])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(['under_score'])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(['-leading'])).toBeUndefined()
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

  it('refuses anything that is not actually an array', () => {
    // The value arrives from a file a user can edit, so "an array of strings" is
    // a hope. A bare STRING passes a `.length` check and then iterates as
    // characters — each of which is a perfectly valid slug shape — and an object
    // with a `length` passes it and THROWS on iteration.
    expect(normalizeQueuedSkillSlugs('commit')).toBeUndefined()
    expect(normalizeQueuedSkillSlugs({ length: 2 })).toBeUndefined()
    expect(normalizeQueuedSkillSlugs({ length: 2, 0: 'a', 1: 'b' })).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(42)).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(null)).toBeUndefined()
    expect(normalizeQueuedSkillSlugs({})).toBeUndefined()
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

  /**
   * Stop the send at the turn boundary and hand back a promise that resolves
   * when it gets there.
   *
   * A timer would only assert that 50ms passed. This waits for the event the
   * test is actually about, and `settled()` then drains the rejection that
   * follows so nothing is left running when the test ends.
   */
  function fakeTurnBoundary(sm: SessionManager) {
    let reached!: () => void
    const at = new Promise<void>((r) => { reached = r })
    ;(sm as unknown as {
      getOrCreateAgent(m: unknown): Promise<unknown>
    }).getOrCreateAgent = async () => {
      reached()
      throw new Error('fake turn boundary')
    }
    return {
      at,
      /**
       * Let the rejection unwind and the admission's `finally` run.
       *
       * Polls the real condition — an empty admission map — rather than
       * sleeping: the unwind takes an unknown number of microtask hops, and a
       * fixed wait would either be flaky or be slower than it needs to be.
       * Bounded, so a send that never settles fails the assertion rather than
       * hanging the suite.
       */
      settled: async () => {
        const admissions = (sm as unknown as { sendAdmissions: Map<symbol, unknown> }).sendAdmissions
        for (let i = 0; i < 200 && admissions.size > 0; i++) {
          await new Promise((r) => setImmediate(r))
        }
      },
    }
  }

  /** Nothing this manager started is still outstanding. */
  function expectNoLeakedWork(sm: SessionManager) {
    expect((sm as unknown as { sendAdmissions: Map<symbol, unknown> }).sendAdmissions.size).toBe(0)
  }

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
    const turn = fakeTurnBoundary(second)

    await (second as unknown as {
      ensureMessagesLoaded(m: unknown): Promise<void>
    }).ensureMessagesLoaded(revived)

    // Hydration re-queued it, with the slugs recovered from disk.
    const queue = revived.messageQueue as Array<{ messageId?: string; options?: { skillSlugs?: string[] } }>
    expect(queue).toHaveLength(1)
    expect(queue[0]!.options?.skillSlugs).toEqual([SKILL_SLUG])

    // Hydration scheduled the replay itself. Waited for by the EVENT it is about
    // — reaching the turn — rather than by a timer, which would only assert that
    // 50ms had passed.
    await turn.at
    await turn.settled()

    // THE POINT: the skill's required source was enabled before the turn.
    expect(revived.enabledSourceSlugs as string[]).toContain(SOURCE_SLUG)
    // And the durable marker was released only once a turn owned the message.
    const replayed = (revived.messages as Array<{ content?: string; isQueued?: boolean; queuedSkillSlugs?: unknown }>)
      .find((m) => m.content === 'run the commit helper')
    expect(replayed?.isQueued).toBeFalsy()
    expect(replayed?.queuedSkillSlugs).toBeUndefined()
    expectNoLeakedWork(second)
  }, 30000)

  it('promotes an undelivered steer to durable queued state, as the same message', async () => {
    // A steer is a user message that was ACCEPTED, ACKed and persisted, and then
    // pushed into the running turn instead of queued. When the turn ends without
    // delivering it, `steer_undelivered` brings it back — and it used to come
    // back as a bare string: a NEW message with a new id (a duplicate in the
    // transcript), no attachments, no skill slugs, and nothing durable, since
    // `messageQueue` dies with the process. So a quit right there lost a message
    // the user had been told was accepted.
    const sessionId = 'sess_steer_undelivered'
    const first = new SessionManager()
    const managed = seed(first, sessionId)
    const turns = first as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void }
    turns.setProcessing(managed, true)
    // A backend that accepts the steer.
    managed.agent = { redirect: () => true }
    managed.llmConnection = 'claude-max'

    await first.sendMessage(sessionId, 'steered mid-turn', undefined, undefined, {
      skillSlugs: [SKILL_SLUG],
    })
    // Accepted into the turn, so NOT queued.
    expect((managed.messageQueue as unknown[]).length).toBe(0)
    const sent = (managed.messages as Array<{ id: string; content?: string }>)
      .find((m) => m.content === 'steered mid-turn')!
    expect(sent).toBeDefined()

    // The turn ends without ever delivering it.
    await (first as unknown as {
      processEvent(m: unknown, e: unknown): Promise<void>
    }).processEvent(managed, { type: 'steer_undelivered', message: 'steered mid-turn' })

    // Durable, and the SAME message: same id, its slugs, one copy.
    const queue = managed.messageQueue as Array<{ messageId?: string; options?: { skillSlugs?: string[] } }>
    expect(queue).toHaveLength(1)
    expect(queue[0]!.messageId).toBe(sent.id)
    expect(queue[0]!.options?.skillSlugs).toEqual([SKILL_SLUG])
    expect((managed.messages as Array<{ content?: string }>)
      .filter((m) => m.content === 'steered mid-turn')).toHaveLength(1)

    // And the quit right there keeps it: the flag and the slugs are on disk.
    turns.setProcessing(managed, false, 'no-tail')
    await first.flushAllSessions()
    sessionPersistenceQueue.reopenAfterFlushAll()

    const line = readFileSync(getSessionFilePath(root, sessionId), 'utf-8')
      .trim().split('\n').slice(1).find((l) => l.includes('steered mid-turn'))!
    const stored = JSON.parse(line) as Record<string, unknown>
    expect(stored.id).toBe(sent.id)
    expect(stored.isQueued).toBe(true)
    expect(stored.queuedSkillSlugs).toEqual([SKILL_SLUG])

    // A new process recovers exactly that message, once.
    const second = new SessionManager()
    const revived = createManagedSession(
      { id: sessionId, name: 'Replay session', sessionStatus: 'todo', createdAt: Date.now() },
      workspace(),
    ) as unknown as Record<string, unknown>
    revived.messageQueue = []
    ;(second as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, revived)
    const turn = fakeTurnBoundary(second)
    await (second as unknown as {
      ensureMessagesLoaded(m: unknown): Promise<void>
    }).ensureMessagesLoaded(revived)

    const recovered = revived.messageQueue as Array<{ messageId?: string; options?: { skillSlugs?: string[] } }>
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.messageId).toBe(sent.id)
    expect(recovered[0]!.options?.skillSlugs).toEqual([SKILL_SLUG])

    await turn.at
    await turn.settled()
    expectNoLeakedWork(second)
  }, 30000)

  it('enables the same source on a LIVE send as on a replayed one, and drops a path-like slug', async () => {
    // Live and restart have to agree, and they did not: the slugs were
    // normalized where they were persisted, so the replay was validated while
    // the LIVE pre-enable — the one that reaches `loadSkillBySlug` first — took
    // whatever the caller sent. Normalizing once at ingress is what makes the
    // two paths the same list.
    const sessionId = 'sess_live_send'
    const sm = new SessionManager()
    const managed = seed(sm, sessionId)
    const turn = fakeTurnBoundary(sm)

    // No turn running: this is the ordinary path, straight to a turn.
    await sm.sendMessage(sessionId, 'run it now', undefined, undefined, {
      skillSlugs: ['../../../etc/passwd', SKILL_SLUG],
    }).catch(() => {})
    await turn.settled()

    // Same answer the replayed send gets: the source is on.
    expect(managed.enabledSourceSlugs as string[]).toContain(SOURCE_SLUG)
    // And the path-like slug never became a lookup.
    expect(managed.lastSentOptions as { skillSlugs?: string[] })
      .toMatchObject({ skillSlugs: [SKILL_SLUG] })
    expectNoLeakedWork(sm)
  }, 30000)

  it('keeps an undelivered steer that the event stream never delivers', async () => {
    // The order is the point. `chat()` yields `complete` and then yields
    // `steer_undelivered` from its `finally`; the send loop returns as soon as
    // it sees `complete`, which abandons the generator and throws that second
    // event away. So the event handler is NOT the guarantee — this test never
    // processes that event at all — and the turn-end handler the loop really
    // does reach has to ASK the backend instead.
    const sessionId = 'sess_steer_real_order'
    const sm = new SessionManager()
    const managed = seed(sm, sessionId)
    const turns = sm as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void }

    // A backend that accepts the steer, never delivers it, and reports it only
    // when asked — exactly the shape whose trailing yield gets discarded.
    const steer = { held: null as string | null }
    managed.agent = {
      redirect: (text: string) => { steer.held = text; return true },
      takeUndeliveredSteer: () => { const held = steer.held; steer.held = null; return held },
    }

    turns.setProcessing(managed, true)
    await sm.sendMessage(sessionId, 'steered into the turn', undefined, undefined, {
      skillSlugs: [SKILL_SLUG],
    })
    const steered = (managed.messages as Array<{ id: string; content?: string }>)
      .find((m) => m.content === 'steered into the turn')!
    // Accepted into the turn rather than queued — and the backend is holding it.
    expect((managed.messageQueue as unknown[]).length).toBe(0)
    expect(steer.held).toBe('steered into the turn')

    // The turn ends the way the send loop ends it on `complete`: straight into
    // this handler, with no further events consumed.
    await (sm as unknown as {
      onProcessingStopped(id: string, reason: string): Promise<void>
    }).onProcessingStopped(sessionId, 'complete')

    // Survived — as the same message, with its slugs, exactly once.
    const queued = (managed.messages as Array<{ id: string; isQueued?: boolean; queuedSkillSlugs?: string[] }>)
      .find((m) => m.id === steered.id)
    expect(queued?.isQueued).toBe(true)
    expect(queued?.queuedSkillSlugs).toEqual([SKILL_SLUG])
    expect((managed.messages as Array<{ content?: string }>)
      .filter((m) => m.content === 'steered into the turn')).toHaveLength(1)
    // And the backend is no longer holding it, so nothing can promote it twice.
    expect(steer.held).toBeNull()
  }, 30000)

  it('does not re-queue a steer from an earlier turn', async () => {
    // The envelopes are per-TURN. A steer that was delivered is not coming back,
    // and leaving its envelope behind meant the next undelivered steer with the
    // same text matched the OLD one — re-queueing a message that had already
    // been answered.
    const sessionId = 'sess_steer_stale'
    const sm = new SessionManager()
    const managed = seed(sm, sessionId)
    const turns = sm as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void }
    managed.agent = { redirect: () => true }

    // Turn 1: the steer IS delivered, and the turn finalises.
    turns.setProcessing(managed, true)
    await sm.sendMessage(sessionId, 'same words', undefined, undefined, undefined)
    const firstId = (managed.messages as Array<{ id: string; content?: string }>)
      .find((m) => m.content === 'same words')!.id
    await (sm as unknown as {
      onProcessingStopped(id: string, reason: string): Promise<void>
    }).onProcessingStopped(sessionId, 'complete')

    // Turn 2: the same words again, this time undelivered.
    turns.setProcessing(managed, true)
    await sm.sendMessage(sessionId, 'same words', undefined, undefined, undefined)
    const secondId = (managed.messages as Array<{ id: string; content?: string }>)
      .filter((m) => m.content === 'same words').at(-1)!.id
    expect(secondId).not.toBe(firstId)

    await (sm as unknown as {
      processEvent(m: unknown, e: unknown): Promise<void>
    }).processEvent(managed, { type: 'steer_undelivered', message: 'same words' })

    // The message that comes back is THIS turn's, not the one already answered.
    const queue = managed.messageQueue as Array<{ messageId?: string }>
    expect(queue.map((q) => q.messageId)).toEqual([secondId])
    turns.setProcessing(managed, false, 'no-tail')
  }, 30000)

  it('opens a session whose queued message has a corrupted slug field', async () => {
    // The read path, which is the one that matters: a hand-edited or
    // half-written JSONL must not stop a session from opening. Before the
    // array check, the string form silently produced one skill slug per
    // CHARACTER and the object form threw inside hydration.
    const sessionId = 'sess_corrupt_slugs'
    const filePath = getSessionFilePath(root, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: sessionId,
      workspaceRootPath: root,
      name: 'Corrupt session',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [
        { type: 'user', id: 'm-str', content: 'string form', isQueued: true, queuedSkillSlugs: SKILL_SLUG },
        { type: 'user', id: 'm-obj', content: 'object form', isQueued: true, queuedSkillSlugs: { length: 2 } },
      ],
    } as unknown as StoredSession)

    const sm = new SessionManager()
    const managed = createManagedSession(
      { id: sessionId, name: 'Corrupt session', sessionStatus: 'todo', createdAt: Date.now() },
      workspace(),
    ) as unknown as Record<string, unknown>
    managed.messageQueue = []
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    const turn = fakeTurnBoundary(sm)

    // Opens. Before the fix the object form threw out of here.
    await (sm as unknown as {
      ensureMessagesLoaded(m: unknown): Promise<void>
    }).ensureMessagesLoaded(managed)

    const queue = managed.messageQueue as Array<{ messageId?: string; options?: unknown }>
    expect(queue.map((q) => q.messageId)).toEqual(['m-str', 'm-obj'])
    // Neither corrupted value became slugs — and in particular the string did
    // not become five of them.
    expect(queue.every((q) => q.options === undefined)).toBe(true)

    // Let hydration's scheduled replay reach its boundary and unwind, rather
    // than leaving it running.
    await turn.at
    await turn.settled()
    expectNoLeakedWork(sm)
  }, 20000)

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
    // The deferred send refuses; let that rejection unwind so the admission's
    // `finally` has run before anything is asserted.
    await new Promise((r) => setImmediate(r))
    expectNoLeakedWork(sm)

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
