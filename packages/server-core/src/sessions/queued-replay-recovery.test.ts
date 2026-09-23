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

  it('accepts a path-safe directory name, capitals and underscores included', () => {
    // A skill is a DIRECTORY the user made. `My_Skill` and `Commit` are names the
    // mention parser already accepts and `loadSkillBySlug` already finds, so
    // enforcing the cosmetic half of the repo's slug rule here would have
    // silently stopped pre-enabling their sources — on the live path as well as
    // the replayed one. What the check is for is the other half: it must stay a
    // name and never become a route.
    expect(normalizeQueuedSkillSlugs(['My_Skill'])).toEqual(['My_Skill'])
    expect(normalizeQueuedSkillSlugs(['Commit'])).toEqual(['Commit'])
    expect(normalizeQueuedSkillSlugs(['under_score'])).toEqual(['under_score'])
    expect(normalizeQueuedSkillSlugs(['-leading'])).toEqual(['-leading'])
  })

  it('still rejects separators, dots and anything with structure', () => {
    expect(normalizeQueuedSkillSlugs(['a.b'])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(['a/b', 'a\\b', '..', '.', 'has space'])).toBeUndefined()
    expect(normalizeQueuedSkillSlugs(['~/x', 'a:b', 'a\u0000b'])).toBeUndefined()
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
    let reached!: (sessionId: string) => void
    const at = new Promise<string>((r) => { reached = r })
    const pending: string[] = []
    ;(sm as unknown as {
      getOrCreateAgent(m: { id: string }): Promise<unknown>
    }).getOrCreateAgent = async (managed) => {
      // Recorded, not just signalled. A hydration that queues TWO messages
      // replays twice, and the second replay arrives after the first turn has
      // been closed — so a one-shot promise reports the first boundary and
      // silently drops the rest.
      pending.push(managed.id)
      reached(managed.id)
      throw new Error('fake turn boundary')
    }
    return {
      at,
      /**
       * Finish the turn this boundary cut short.
       *
       * Required, and the reason is a real one rather than test plumbing: the
       * send starts the turn and only THEN reaches `getOrCreateAgent`, which
       * sits outside the chat loop's try — so a throw there unwinds past every
       * handler and leaves `isProcessing` true with nothing scheduled to clear
       * it. Production has the same hole (reported separately); here the fixture
       * closes the lifecycle it interrupted, so quiescence is a state the test
       * can actually reach instead of one it waits out.
       */
      endTurn: async () => {
        const sessionId = await at
        // CONSUME the boundary being closed. Leaving it recorded would let
        // `closePending` finalise this same turn a second time, and
        // `onProcessingStopped` is not idempotent — a second pass can shift
        // another queued message into a concurrent turn, which is the exact
        // hazard SUV-0067 documents. Exactly one occurrence, so a later replay
        // on the same session still has its own entry to drain.
        const recorded = pending.indexOf(sessionId)
        if (recorded !== -1) pending.splice(recorded, 1)
        await (sm as unknown as {
          onProcessingStopped(id: string, reason: string): Promise<void>
        }).onProcessingStopped(sessionId, 'error')
      },
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
      /**
       * Close every turn this boundary has cut short since the last call.
       *
       * `endTurn` closes the FIRST one. That is enough when hydration queues a
       * single message, and wrong the moment it queues two: the second replay
       * starts only after the first turn ends, hits this boundary, and throws
       * past every handler — leaving a turn nothing will ever finalise and an
       * admission that never settles. Quiescence is then unreachable, and
       * whether the second replay lands inside the wait's bound decides whether
       * the test passes. That is the whole flake.
       *
       * Draining the recorded boundaries makes the fixture close as many turns
       * as the replays actually start. It stands in for the production gap
       * SUV-0067 tracks; until that lands, a test driving replays through this
       * boundary has to finish what it interrupts.
       */
      closePending: async () => {
        let closed = 0
        while (pending.length) {
          await (sm as unknown as {
            onProcessingStopped(id: string, reason: string): Promise<void>
          }).onProcessingStopped(pending.shift()!, 'error')
          closed++
        }
        return closed
      },
    }
  }

  /**
   * Wait until this manager is STABLY idle, then assert it — in the same turn
   * the stability was observed.
   *
   * An empty admission map is not quiescence: it is momentarily true between a
   * replay settling and the next one being admitted, and a check sampling that
   * instant passes while work is still in flight. So idleness has to hold across
   * consecutive turns before it counts, and the wait is bounded — work that
   * never settles fails an assertion rather than hanging the suite.
   *
   * Two details are load-bearing, and the previous version had neither, which
   * made this helper fail about five runs in eight.
   *
   * **A pending runtime queue is not idle.** `sendAdmissions` and `isProcessing`
   * describe the turn that is running, not the ones still owed. A session whose
   * `messageQueue` is non-empty will admit again the moment the current replay
   * settles, so sampling only the first two reads idle in exactly the gap this
   * helper exists to skip over. It is the queue that says whether more work is
   * coming.
   *
   * **The assertion cannot sit after another `await`.** The old loop advanced
   * the event loop after its final observation and asserted on the far side of
   * it, so a replay admitted during that one turn failed an assertion about a
   * state that had been true when last looked at. Stability is now confirmed and
   * asserted in one synchronous continuation, with no yield in between — the
   * whole point is to assert a state we are still standing in.
   */
  async function quiesce(sm: SessionManager, turn?: { closePending(): Promise<number> }) {
    const inner = sm as unknown as {
      sendAdmissions: Map<symbol, unknown>
      sessions: Map<string, { isProcessing?: boolean; turnFinalization?: unknown; messageQueue?: unknown[] }>
    }
    const busy = () => [...inner.sessions.values()]
      .filter(m => m.isProcessing || m.turnFinalization || (m.messageQueue?.length ?? 0) > 0)
    const idle = () => inner.sendAdmissions.size === 0 && busy().length === 0

    const assertIdle = () => {
      expect(inner.sendAdmissions.size).toBe(0)
      expect([...inner.sessions.values()].filter(m => m.isProcessing)).toHaveLength(0)
      expect(busy()).toHaveLength(0)
    }

    // Bounded by WALL CLOCK, not by turns of the event loop. The previous
    // version spun 400 `setImmediate`s, which on an unloaded machine elapse in
    // well under a millisecond — far quicker than the persistence writes a
    // replay is waiting on. It therefore did not wait for the work so much as
    // observe that the work had not started, and its verdict tracked machine
    // speed rather than the state of the manager. Pacing with a real timer lets
    // I/O actually make progress between samples.
    const deadline = Date.now() + 5000
    let stable = 0
    while (Date.now() < deadline) {
      // A replay that starts during the wait hits the boundary and throws past
      // every handler, so nothing else will ever finalise its turn. Closing it
      // here is what makes quiescence REACHABLE rather than something the wait
      // races against; without it the loop can only time out and assert on
      // whatever it finds.
      if (turn && await turn.closePending()) { stable = 0; continue }
      if (idle()) {
        // Asserted here, not after another await: nothing may run between the
        // observation that ends the wait and the assertion about it.
        if (++stable >= 5) return assertIdle()
      } else {
        stable = 0
      }
      await new Promise((r) => setTimeout(r, 1))
    }
    // Never reached stability inside the bound — assert anyway, so the failure
    // reports the real outstanding state rather than a bare timeout.
    assertIdle()
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
    // 50ms had passed. Closing the turn is part of the wait: the boundary throws
    // from a point the send's own handlers do not cover.
    await turn.endTurn()

    // THE POINT: the skill's required source was enabled before the turn.
    expect(revived.enabledSourceSlugs as string[]).toContain(SOURCE_SLUG)
    // And the durable marker was released only once a turn owned the message.
    const replayed = (revived.messages as Array<{ content?: string; isQueued?: boolean; queuedSkillSlugs?: unknown }>)
      .find((m) => m.content === 'run the commit helper')
    expect(replayed?.isQueued).toBeFalsy()
    expect(replayed?.queuedSkillSlugs).toBeUndefined()
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

  // RETIRED with the fork's single-slot steering machinery (upstream v0.13.4
  // merge). These tests exercised `takeUndeliveredSteer`, the `pendingSteers`
  // envelope list and `reconcilePendingSteers`, none of which exist now:
  // upstream's turn-scoped `PendingSteers` queue delivers multiple steers in
  // order at each tool boundary, and recovery goes through `takePendingSteers`
  // / `recoverPendingSteers` / `recoverUndeliveredSteer`. Equivalent coverage,
  // including the fork's P3 lesson that duplicate steer text must be told apart
  // by identity, lives in `midstream-queue.test.ts` ("recovers distinct
  // identical-text steers by identity without interrupting or duplicating",
  // "transfers handoff steers ahead of already queued later attachments",
  // "hard Stop visibly cancels accepted pending steers") and in
  // `packages/shared/src/agent/__tests__/claude-steering.test.ts`.
  // The one thing NOT covered by that equivalent coverage is durability across
  // a crash, which upstream's design drops: it keeps an accepted steer only in
  // the runtime `acceptedSteers` map and persists the message with
  // `isQueued = false` before the ack. The fork's at-least-once marker is
  // restored on top of upstream's queue, and the three tests below are what hold
  // it: provisional marker written before the ack, retired at settlement for
  // steers the backend delivered, kept for steers it handed back.

  /**
   * A steer the backend can be asked about, with a scripted answer for the one
   * question settlement asks it.
   *
   * `takePendingSteers` returning `[]` is the backend saying "everything you
   * gave me went out" — the only evidence allowed to retire a provisional
   * marker. Returning an envelope is the opposite answer.
   */
  function steerableAgent(undelivered: Array<{ message: string; messageId?: string }> = []) {
    let asked = false
    return {
      redirect: () => true,
      takePendingSteers: () => {
        if (asked) return []
        asked = true
        return undelivered
      },
    }
  }

  it('replays an accepted steer whose process died before the turn settled', async () => {
    // The crash boundary the marker exists for: the steer was ACKed to the user,
    // lives only in the backend's memory and in the runtime `acceptedSteers`
    // map, and the process dies before `onProcessingStopped` ever runs. Without
    // a durable marker the cold-load scan sees nothing and the message the user
    // was told had landed is simply gone.
    const sessionId = 'sess_steer_crash'

    // ---- Process 1: steer accepted, then nothing. No settlement, no clean quit.
    const first = new SessionManager()
    const managed = seed(first, sessionId, { agent: steerableAgent() })
    ;(first as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void })
      .setProcessing(managed, true)
    await first.sendMessage(sessionId, 'steer into the running turn')

    // Accepted, not queued — and durably marked anyway. The mid-stream path
    // flushes before it acks, so this is already on disk.
    const steered = (managed.messages as Array<{ content?: string; isQueued?: boolean }>)
      .find(m => m.content === 'steer into the running turn')
    expect(steered?.isQueued).toBe(true)
    expect((managed.messageQueue as unknown[]).length).toBe(0)
    const stored = JSON.parse(
      readFileSync(getSessionFilePath(root, sessionId), 'utf-8')
        .trim().split('\n').slice(1).find(l => l.includes('steer into the running turn'))!,
    ) as Record<string, unknown>
    expect(stored.isQueued).toBe(true)

    // ---- Process 2: a fresh manager hydrates the same session cold.
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

    // THE POINT: the ACKed steer came back as a queued message to replay.
    const queue = revived.messageQueue as Array<{ messageId?: string }>
    expect(queue).toHaveLength(1)
    expect(queue[0]!.messageId).toBe(steered!.id as unknown as string)

    await turn.endTurn()
    await quiesce(second, turn)
  }, 30000)

  it('retires the provisional marker once the turn settles with the steer delivered', async () => {
    // The no-crash path, and the reason the marker is PROVISIONAL: a steer that
    // was delivered must not come back on the next launch. Settlement asks the
    // backend, gets silence, and drops the marker on that evidence.
    const sessionId = 'sess_steer_delivered'
    const sm = new SessionManager()
    const managed = seed(sm, sessionId, { agent: steerableAgent() })
    ;(sm as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void })
      .setProcessing(managed, true)
    await sm.sendMessage(sessionId, 'steer that lands')

    await (sm as unknown as {
      onProcessingStopped(id: string, reason: string): Promise<void>
    }).onProcessingStopped(sessionId, 'complete')

    const settled = (managed.messages as Array<{ content?: string; isQueued?: boolean; queuedSkillSlugs?: unknown }>)
      .find(m => m.content === 'steer that lands')
    expect(settled?.isQueued).toBeFalsy()
    expect(settled?.queuedSkillSlugs).toBeUndefined()
    expect((managed.messageQueue as unknown[]).length).toBe(0)

    // And on disk, so the next launch's scan finds nothing to replay.
    await sm.flushAllSessions()
    const lines = readFileSync(getSessionFilePath(root, sessionId), 'utf-8')
      .trim().split('\n').slice(1).filter(l => l.includes('steer that lands'))
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(last.isQueued).toBeFalsy()
  }, 30000)

  it('keeps the marker for a steer the backend hands back undelivered', async () => {
    // The third answer: the backend still had it. The message is put back on the
    // runtime queue AND keeps its durable marker, so a crash before the replay
    // owns a turn still recovers it.
    const sessionId = 'sess_steer_undelivered'
    const sm = new SessionManager()
    const managed = seed(sm, sessionId)
    // The recovered message is replayed, so the turn it starts needs the same
    // boundary the other replay tests use.
    const turn = fakeTurnBoundary(sm)
    ;(sm as unknown as { setProcessing(m: unknown, p: boolean, f?: unknown): void })
      .setProcessing(managed, true)
    // The agent is installed with a placeholder id first, then pointed at the
    // real message id: the id only exists once the send has created it.
    const handback: Array<{ message: string; messageId?: string }> = []
    managed.agent = steerableAgent(handback)
    const originalRedirect = (managed.agent as { redirect(m: string, o?: { messageId?: string }): boolean }).redirect
    ;(managed.agent as { redirect(m: string, o?: { messageId?: string }): boolean }).redirect =
      (message, opts) => {
        handback.push({ message, messageId: opts?.messageId })
        return originalRedirect(message)
      }
    await sm.sendMessage(sessionId, 'steer that never went out')

    await (sm as unknown as {
      onProcessingStopped(id: string, reason: string): Promise<void>
    }).onProcessingStopped(sessionId, 'complete')

    const kept = (managed.messages as Array<{ id?: string; content?: string; isQueued?: boolean }>)
      .find(m => m.content === 'steer that never went out')
    expect(kept?.isQueued).toBe(true)
    // Settlement put it back on the runtime queue, which `onProcessingStopped`
    // then drained into a replay turn — so the queue is already empty here and
    // the observable proof of the re-queue is the turn that started for it.
    expect(await turn.at).toBe(sessionId)
    // One copy of the message, not a duplicate bubble.
    expect((managed.messages as Array<{ content?: string }>)
      .filter(m => m.content === 'steer that never went out')).toHaveLength(1)

    await quiesce(sm, turn)
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
    await turn.endTurn()
    await quiesce(sm, turn)
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
