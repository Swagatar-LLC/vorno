/**
 * SUV-0066 — the quit path must not return while a session write is mid-commit.
 *
 * `flushAll` waiting correctly is one claim; the app's quit actually routing
 * through it is another, and only the second one is what a user experiences.
 * The chain is `before-quit` → `SessionManager.flushAllSessions()` →
 * `sessionPersistenceQueue.flushAll()`, awaited at every link
 * (`apps/electron/src/main/index.ts`, and the same call in `apps/server`'s
 * standalone host and `packages/server`). This covers the SessionManager link,
 * which is the one inside this package.
 *
 * The window that matters is between the Windows-compat `unlink` of the target
 * and the `rename`: for that moment the session has no file on disk at all.
 * Returning from quit there means exiting with a session missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSessionFilePath,
  sessionPersistenceQueue,
  sessionWriteKey,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { installSingletonCommitHooksForTesting } from '@craft-agent/shared/sessions/internal'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_quit'
const SESSION_ID = 'sess_quit'

describe('quit flushes sessions that are mid-commit', () => {
  let root: string
  /** Disposer for this suite's own hooks; never clears another owner's. */
  let disposeHooks: (() => void) | undefined
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quit-flush-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    // Shared module singleton — a leaked hook fires inside every later suite.
    disposeHooks?.()
    disposeHooks = undefined
    // `flushAll` CLOSES the shared queue — that is the point of it — and this
    // singleton outlives the suite. Without reopening, every later suite's
    // writes would be refused.
    sessionPersistenceQueue.reopenAfterFlushAll()
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * A real managed session, seeded on disk.
   *
   * Shutdown now touches EVERY loaded session — it aborts running turns and
   * persists each final state with a checked receipt — so a hand-rolled
   * `{ someTimer }` object no longer survives the sequence. That is the
   * sequence working: a fake thin enough to skip the persist is a fake that
   * cannot show the persist happened.
   */
  function seedManaged(id: string, extra: Record<string, unknown> = {}) {
    const filePath = getSessionFilePath(root, id)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id,
      workspaceRootPath: root,
      name: 'Quit session',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'transcript' }],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id, name: 'Quit session', sessionStatus: 'todo', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Quit WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'transcript' }]
    Object.assign(managed, extra)
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  /**
   * The private turn-lifecycle API, reached the way the rest of this suite
   * reaches privates. A function, not a const: `sm` is rebuilt per test.
   *
   * `setProcessing`'s stop overload REQUIRES a disposition — an owner that will
   * release after its tail, or `'no-tail'` — so the cast spells the third
   * argument out rather than letting a test pretend it is optional.
   */
  function turns() {
    return sm as unknown as {
      setProcessing(m: unknown, processing: boolean, finalization?: unknown): void
      claimTurnFinalization(sessionId: string): { token: symbol; release(): void }
      admitSend(sessionId: string): { token: symbol; settle(): void }
      beginTurnFromAdmittedSend(m: unknown, admission: { token: symbol; settle(): void }): void
      sendAdmissions: Map<symbol, unknown>
      collectSessionsNeedingFinalPersist(): Array<{ id: string }>
      completePlanSubmissionHandoff(m: unknown): Promise<void>
      completeAuthRequestHandoff(m: unknown, request: unknown, authMessage: unknown): void
    }
  }

  /** A browser-pane manager whose visual clear parks until `release()` is called. */
  function holdBrowserRelease(): { release: () => void } {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    ;(sm as unknown as {
      getBrowserPaneManagerForSession(id: string): unknown
    }).getBrowserPaneManagerForSession = () => ({
      clearVisualsForSession: async () => { await held },
      unbindAllForSession: () => {},
    })
    return { release: () => release() }
  }

  it('flushAllSessions waits for a write already past the queue', async () => {
    const filePath = getSessionFilePath(root, SESSION_ID)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: SESSION_ID,
      workspaceRootPath: root,
      name: 'Quit session',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'transcript' }],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id: SESSION_ID, name: 'Quit session', sessionStatus: 'todo', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Quit WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'transcript' }]
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)

    // Hold the write inside its commit. Released on a timer, not after the
    // flush returns — releasing it afterwards would deadlock, which is itself
    // the proof that quit now waits.
    let renamed = false
    disposeHooks = installSingletonCommitHooksForTesting({
      beforeRename: async () => { await new Promise((r) => setTimeout(r, 120)) },
      afterRename: () => { renamed = true },
    })

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    const driven = sessionPersistenceQueue.driveChecked(sessionWriteKey(root, SESSION_ID))
    await new Promise((r) => setTimeout(r, 20))

    // The state the old `flushAll` could not see: in flight, nothing queued.
    expect(sessionPersistenceQueue.hasPending(sessionWriteKey(root, SESSION_ID))).toBe(false)
    expect(renamed).toBe(false)

    await sm.flushAllSessions()

    // Quit returned only after the rename committed.
    expect(renamed).toBe(true)
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toContain('transcript')

    await driven
  })

  it('waits for a watcher reconciliation that arrives during the drain', async () => {
    // The hole freezing intake opened, at the level it actually lives.
    //
    // `applyExternalSessionMetadata` supersedes the in-flight write (so it
    // cannot commit pre-edit state) and then persists the merged result. Those
    // are two halves of one operation: if the shutdown freeze refuses the
    // second, absorbing an external edit DESTROYS it — the cancelled write is
    // gone and the stale file stands. So that persist takes the queue's
    // reconciliation path, and the drain waits for it.
    const filePath = getSessionFilePath(root, SESSION_ID)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: SESSION_ID,
      workspaceRootPath: root,
      name: 'Original',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'transcript' }],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id: SESSION_ID, name: 'Original', sessionStatus: 'todo', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Quit WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'transcript' }]
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)

    const header = () =>
      JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]!) as Record<string, unknown>

    // `permissionMode` is the one merged field the reconciliation does not copy
    // into memory, so the merge is the only route by which it can reach disk —
    // which makes it the only field that proves the replacement really landed.
    let reconciled = false
    disposeHooks = installSingletonCommitHooksForTesting({
      afterRename: () => {
        if (reconciled) return
        reconciled = true
        const observed = { ...header(), name: 'Renamed during quit', permissionMode: 'safe' }
        ;(sm as unknown as {
          applyExternalSessionMetadata(m: unknown, h: unknown): boolean
        }).applyExternalSessionMetadata(
          (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(SESSION_ID),
          observed,
        )
      },
    })

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushAllSessions()
    disposeHooks?.()
    disposeHooks = undefined

    expect(reconciled).toBe(true)
    // The edit is on disk: the shutdown waited for the replacement instead of
    // refusing it and exiting over the stale file.
    expect(header().permissionMode).toBe('safe')
    expect(sessionPersistenceQueue.isClosing).toBe(true)
  })

  it('cancels a pending auto-retry timer before it closes the queue', async () => {
    // The producer that is per-SESSION rather than per-workspace, and so the
    // easy one to miss: the source-activation auto-retry fires `sendMessage`,
    // which mutates the session and persists. A shutdown starting inside its
    // window would let it commit state after the freeze and have that write
    // refused, so the app would exit without the retried message while the
    // flush reported quiescence.
    let fired = false
    const managed = seedManaged(SESSION_ID, {
      autoRetryTimer: setTimeout(() => { fired = true }, 40),
      autoRetryPending: { content: 'x', deadlineMs: Date.now() + 2000, committed: false },
    })

    await sm.flushAllSessions()

    expect(managed.autoRetryTimer).toBeUndefined()
    expect(managed.autoRetryPending).toBeUndefined()
    await new Promise((r) => setTimeout(r, 70))
    expect(fired).toBe(false)
  })

  it('cancels the forced turn-cleanup timer, so a quit inside its window writes nothing', async () => {
    // The other per-session producer, and the subtler one: the 5s safety timer
    // that forces turn cleanup when a stopped generator does not drain calls
    // `onProcessingStopped`, which persists. A quit landing inside that window
    // would let it fire against a frozen queue.
    let fired = false
    const managed = seedManaged(SESSION_ID, {
      forceStopCleanupTimer: setTimeout(() => { fired = true }, 40),
      stopRequested: true,
    })

    await sm.flushAllSessions()

    expect(managed.forceStopCleanupTimer).toBeUndefined()
    await new Promise((r) => setTimeout(r, 70))
    expect(fired).toBe(false)
  })

  it('stops the producers before it closes the queue', async () => {
    // Ordering belongs here rather than in each host, so the three quit paths
    // (electron, standalone server, headless server) cannot get it wrong
    // independently. A watcher left running during the drain does not merely
    // arrive late — its write is refused.
    const watchers = (sm as unknown as { configWatchers: Map<string, { stop(): void }> }).configWatchers
    let stopped = false
    watchers.set(root, { stop: () => { stopped = true } })

    await sm.flushAllSessions()

    expect(stopped).toBe(true)
    expect(watchers.size).toBe(0)
  })

  describe('the ordered shutdown', () => {
    it('waits for an active turn to finish, lands its final state, and starts no replay', async () => {
      // The sequence's whole reason for existing, end to end.
      //
      // `onProcessingStopped` finalises a turn and persists it ASYNCHRONOUSLY
      // after the abort. A shutdown that aborted and moved on would close the
      // queue underneath that write, so the assistant's final response would be
      // lost — and if it then replayed the queued message, it would start a turn
      // whose writes land after the close.
      const sessionId = 'sess_active_turn'
      let aborted = false

      const managed = seedManaged(sessionId, {
        isProcessing: true,
        messageQueue: [{ message: 'queued follow-up', messageId: 'q1' }],
      })

      // A fake agent that behaves like the real one: the abort makes the turn
      // finish, which is what `onProcessingStopped` is reached by.
      managed.agent = {
        forceAbort: () => {
          aborted = true
          // The generator drains a tick later, exactly as in production.
          setTimeout(() => {
            const live = (sm as unknown as { sessions: Map<string, Record<string, unknown>> })
              .sessions.get(sessionId)!
            // The final assistant response arrives before the turn closes.
            ;(live.messages as unknown[]).push({
              id: 'final-1',
              role: 'assistant',
              content: 'final response',
              timestamp: Date.now(),
            })
            // Through the REAL finalisation path, not by setting the flag: that
            // is what persists the turn and what would otherwise replay the
            // queued message, so both halves are exercised for real.
            void (sm as unknown as {
              onProcessingStopped(id: string, reason: string): Promise<void>
            }).onProcessingStopped(sessionId, 'interrupted')
          }, 20)
        },
      }

      await sm.flushAllSessions()

      expect(aborted).toBe(true)
      // Waited: the turn is finished before the queue closed.
      expect(managed.isProcessing).toBe(false)
      // The final response is ON DISK, which is the thing the wait buys.
      const contents = readFileSync(getSessionFilePath(root, sessionId), 'utf-8')
      expect(contents).toContain('final response')
      // No replay started: the queued message is still queued, and persisted,
      // so a restart picks it up instead of a turn beginning during shutdown.
      expect((managed.messageQueue as unknown[]).length).toBe(1)
      // And the queue really is closed afterwards.
      expect(sessionPersistenceQueue.isClosing).toBe(true)
    })

    it('decides what to persist BEFORE quiescing, so a turn that ends without persisting still lands', async () => {
      // Why the `needsFinalPersist` snapshot is taken before turns are aborted
      // rather than after.
      //
      // Reading it afterwards works only as long as every finishing turn
      // enqueues a write of its own — `onProcessingStopped` does, so the drain
      // would cover it. That is an assumption about a collaborator, and this is
      // the case where it does not hold: a turn that clears `isProcessing`
      // without persisting. Read after quiesce, such a session looks cold and
      // idle with nothing queued, and its state is dropped. Read before, it was
      // processing, so it gets a final write.
      const sessionId = 'sess_silent_finish'
      const managed = seedManaged(sessionId, { isProcessing: true, messageQueue: [] })
      managed.agent = {
        forceAbort: () => {
          setTimeout(() => {
            const live = (sm as unknown as { sessions: Map<string, Record<string, unknown>> })
              .sessions.get(sessionId)!
            ;(live.messages as unknown[]).push({
              id: 'silent-final',
              role: 'assistant',
              content: 'finished without persisting',
              timestamp: Date.now(),
            })
            // Ends the turn WITHOUT going through `onProcessingStopped`, so
            // nothing enqueues on its behalf.
            live.isProcessing = false
          }, 20)
        },
      }

      await sm.flushAllSessions()

      expect(readFileSync(getSessionFilePath(root, sessionId), 'utf-8')).toContain(
        'finished without persisting',
      )
    })

    it('persists an active turn even when an intermediate write is already queued', async () => {
      // An outstanding write must not stand in for a turn's final state.
      //
      // A streaming turn enqueues intermediate snapshots as it goes, so
      // `hasPendingOrTail` is routinely TRUE for exactly the sessions that most
      // need a final write. Checking that first — as the first version of the
      // filter did — meant shutdown drained a mid-turn snapshot while the
      // completed response, assembled moments later, was never written.
      const sessionId = 'sess_intermediate'
      const managed = seedManaged(sessionId, { isProcessing: true, messageQueue: [] })

      // The mid-turn snapshot: partial text, enqueued and outstanding.
      ;(managed.messages as unknown[]).push({
        id: 'partial-1',
        role: 'assistant',
        content: 'partial so f',
        timestamp: Date.now(),
      })
      ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
      expect(sessionPersistenceQueue.hasPendingOrTail(sessionWriteKey(root, sessionId))).toBe(true)

      managed.agent = {
        forceAbort: () => {
          setTimeout(() => {
            const live = (sm as unknown as { sessions: Map<string, Record<string, unknown>> })
              .sessions.get(sessionId)!
            // The completed response replaces the partial one.
            ;(live.messages as unknown[]).pop()
            ;(live.messages as unknown[]).push({
              id: 'complete-1',
              role: 'assistant',
              content: 'partial so far, then the completed answer',
              timestamp: Date.now(),
            })
            live.isProcessing = false
          }, 20)
        },
      }

      await sm.flushAllSessions()

      const contents = readFileSync(getSessionFilePath(root, sessionId), 'utf-8')
      expect(contents).toContain('then the completed answer')
    })

    it('refuses a new send once shutdown has begun', async () => {
      const sessionId = 'sess_refuse_send'
      seedManaged(sessionId)

      await sm.flushAllSessions()

      expect(sm.isShuttingDown).toBe(true)
      // Refused BEFORE anything is mutated, so nothing half-happened.
      await expect(sm.sendMessage(sessionId, 'too late')).rejects.toThrow(/shutting down/)
    })

    it('a stuck turn does not cost the OTHER sessions their final write', async () => {
      // The regression the first version of this sequence introduced: it threw
      // the moment a turn refused to finish, which skipped the final persist
      // and the drain entirely. One stuck turn therefore cost every other
      // session its last write — and the hosts caught the error and exited
      // anyway, so the net effect of "failing loudly" was losing more data.
      //
      // Failing loudly must not mean skipping the salvage.
      const stuckId = 'sess_stuck_neighbour'
      const innocentId = 'sess_innocent'
      seedManaged(stuckId, { isProcessing: true, agent: { forceAbort: () => {} } })
      const innocent = seedManaged(innocentId)
      ;(innocent.messages as unknown[]).push({
        id: 'late-1',
        role: 'assistant',
        content: 'innocent final state',
        timestamp: Date.now(),
      })
      // Enqueued the way a real mutation is. Shutdown deliberately does not
      // rewrite cold sessions, so an in-memory change nobody persisted is not
      // state it can know about — a real mutator calls `persistSession`, which
      // is what makes the drain responsible for it.
      ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(innocent)

      // Still throws — the shutdown was NOT clean and the caller must know.
      await expect(sm.flushAllSessions()).rejects.toThrow(/not clean/)

      // ...but the innocent session's final state is on disk anyway.
      expect(readFileSync(getSessionFilePath(root, innocentId), 'utf-8')).toContain('innocent final state')
      // And the queue was still closed and drained rather than abandoned.
      expect(sessionPersistenceQueue.isClosing).toBe(true)
      expect(sessionPersistenceQueue.pendingCount).toBe(0)
    }, 15000)

    it('fails the shutdown when a turn will not finish, rather than closing over it', async () => {
      // Bounded, and exceeding the bound is a FAILURE: the wait exists so the
      // final state gets persisted, so giving up quietly would discard exactly
      // what it was waiting for.
      const sessionId = 'sess_stuck_turn'
      seedManaged(sessionId, {
        isProcessing: true,
        // An agent whose abort does nothing — the turn never drains.
        agent: { forceAbort: () => {} },
      })

      await expect(sm.flushAllSessions()).rejects.toThrow(/did not finish within/)
    }, 15000)
  })

  describe('shutdown does not rewrite the workspace', () => {
    it('leaves 200 cold sessions untouched — no rewrite, no restamp, no hydration', async () => {
      // The correction. Persisting every loaded session meant a quit rewrote
      // the whole workspace: each cold session hydrated from disk purely to be
      // written back, and each restamped with a fresh `lastUsedAt` — so idle
      // sessions drifted to the top of a recency-sorted list because the app
      // closed. Expensive, and wrong for records that had not changed.
      const COLD = 200
      const before = new Map<string, { mtimeMs: number; bytes: string }>()
      for (let i = 0; i < COLD; i++) {
        const id = `cold-${i}`
        seedManaged(id, { messagesLoaded: false, messages: [] })
        const file = getSessionFilePath(root, id)
        before.set(id, { mtimeMs: statSync(file).mtimeMs, bytes: readFileSync(file, 'utf-8') })
      }

      // One session with real work, to prove the skip is selective rather than
      // a blanket "persist nothing".
      const activeId = 'cold-active'
      const active = seedManaged(activeId, {
        messageQueue: [{ message: 'queued', messageId: 'q1' }],
      })
      ;(active.messages as unknown[]).push({
        id: 'kept-1',
        role: 'assistant',
        content: 'work worth keeping',
        timestamp: Date.now(),
      })

      // A filesystem mtime can be coarse, so make any rewrite unambiguous.
      await new Promise((r) => setTimeout(r, 15))
      await sm.flushAllSessions()

      for (const [id, snapshot] of before) {
        const file = getSessionFilePath(root, id)
        // Byte-identical: not rewritten at all, so `lastUsedAt` cannot have
        // been restamped and the header is exactly as it was.
        expect(readFileSync(file, 'utf-8')).toBe(snapshot.bytes)
        expect(statSync(file).mtimeMs).toBe(snapshot.mtimeMs)
      }

      // Not hydrated either — a rewrite would have had to load messages first.
      for (let i = 0; i < COLD; i++) {
        const managed = (sm as unknown as { sessions: Map<string, Record<string, unknown>> })
          .sessions.get(`cold-${i}`)!
        expect(managed.messagesLoaded).toBe(false)
      }

      // And the session that HAD work kept its final state.
      expect(readFileSync(getSessionFilePath(root, activeId), 'utf-8')).toContain('work worth keeping')
    }, 30000)
  })

  describe('finalisation is not the isProcessing flag', () => {
    it('stays pending until the finaliser completes, then has the final state on disk', async () => {
      // `isProcessing = false` is NOT "the turn is finished". The stop handler
      // clears it and then keeps going — browser visuals, read state, status,
      // runtime teardown — before the persist that records all of it. Waiting
      // on the flag let shutdown resume mid-tail and close the queue underneath
      // that write.
      //
      // Holding `clearVisualsForSession` parks the finaliser at its first await
      // WITH the flag already false, which is exactly the window.
      const sessionId = 'sess_finalizer'
      const managed = seedManaged(sessionId, { messageQueue: [] })

      const visuals = holdBrowserRelease()

      // Start a real turn so `setProcessing` mints the finalisation deferred.
      turns().setProcessing(managed, true)
      expect(managed.turnFinalization).toBeDefined()

      // The turn produces its answer and the finaliser begins.
      ;(managed.messages as unknown[]).push({
        id: 'final-held',
        role: 'assistant',
        content: 'answer written while shutdown waited',
        timestamp: Date.now(),
      })
      void (sm as unknown as {
        onProcessingStopped(id: string, reason: string): Promise<void>
      }).onProcessingStopped(sessionId, 'complete')
      await new Promise((r) => setTimeout(r, 20))

      // The flag is already false; the turn is NOT finished.
      expect(managed.isProcessing).toBe(false)
      expect(managed.turnFinalization).toBeDefined()

      let settled = false
      const shutdown = sm.flushAllSessions().then(() => { settled = true })
      await new Promise((r) => setTimeout(r, 80))

      // Still pending, and the queue still open — the point of the deferred.
      expect(settled).toBe(false)
      expect(sessionPersistenceQueue.isClosing).toBe(false)

      visuals.release()
      await shutdown

      expect(settled).toBe(true)
      expect(sessionPersistenceQueue.isClosing).toBe(true)
      // And the finaliser's work is on disk, including the read-state it sets.
      const header = JSON.parse(
        readFileSync(getSessionFilePath(root, sessionId), 'utf-8').split('\n')[0]!,
      ) as Record<string, unknown>
      expect(header.hasUnread).toBe(true)
      expect(readFileSync(getSessionFilePath(root, sessionId), 'utf-8')).toContain(
        'answer written while shutdown waited',
      )
    }, 20000)
  })

  describe('a mid-finalisation session earns a checked final receipt', () => {
    it('is selected for a final persist even though isProcessing is already false', async () => {
      // The predicate has to include `turnFinalization`, not just the flag.
      // `onProcessingStopped` clears `isProcessing` early and keeps going, so a
      // session whose finaliser is running reads as idle — and the persist the
      // finaliser does itself is fire-and-forget, with no receipt. Without this,
      // the one session whose state was being assembled during shutdown is the
      // one that never gets a checked write.
      const sessionId = 'sess_mid_finalization'
      const managed = seedManaged(sessionId, { messageQueue: [] })
      turns().setProcessing(managed, true)
      turns().setProcessing(managed, false, 'no-tail')
      // Put it back into the mid-finalisation shape: flag down, deferred up.
      let resolveFinal!: () => void
      managed.turnFinalization = {
        token: Symbol(sessionId),
        promise: new Promise<void>((r) => { resolveFinal = r }),
        resolve: () => {},
      }
      expect(managed.isProcessing).toBe(false)

      const selected = (sm as unknown as {
        collectSessionsNeedingFinalPersist(): Array<{ id: string }>
      }).collectSessionsNeedingFinalPersist()
      expect(selected.map((m) => m.id)).toContain(sessionId)

      // And it really is written: release the finaliser so shutdown proceeds.
      ;(managed.messages as unknown[]).push({
        id: 'mid-final',
        role: 'assistant',
        content: 'assembled during shutdown',
        timestamp: Date.now(),
      })
      setTimeout(() => {
        managed.turnFinalization = undefined
        resolveFinal()
      }, 20)
      await sm.flushAllSessions()

      expect(readFileSync(getSessionFilePath(root, sessionId), 'utf-8')).toContain(
        'assembled during shutdown',
      )
    }, 20000)
  })

  describe('handoff interrupts release the finalisation deferred', () => {
    it('does not leave shutdown waiting when a turn pauses instead of finishing', async () => {
      // Plan submission and auth requests are HANDOFF interrupts: control moves
      // to the UI, `isProcessing` goes false, and `onProcessingStopped` is never
      // reached — the turn is paused, not finished. The deferred is created
      // whenever processing starts, so those paths have to release it or
      // shutdown blocks on a promise nothing will ever settle, burns its whole
      // bound, and then reports a stuck turn that is not stuck.
      const sessionId = 'sess_handoff'
      const managed = seedManaged(sessionId, { messageQueue: [] })

      turns().setProcessing(managed, true)
      expect(managed.turnFinalization).toBeDefined()

      // A stop with nothing following it says so, and is released on the spot.
      turns().setProcessing(managed, false, 'no-tail')
      expect(managed.turnFinalization).toBeUndefined()

      // Resolves promptly, and cleanly — not after the drain bound, and not as
      // a stuck turn.
      const started = Date.now()
      await sm.flushAllSessions()
      expect(Date.now() - started).toBeLessThan(2000)
    }, 20000)

    it('holds the plan handoff open across its tail, and the plan lands', async () => {
      // The regression this exists for: releasing the deferred from
      // `setProcessing(false)` released it at the START of the handoff's tail.
      // The plan handoff's tail is browser release, then the complete event,
      // then the persist that records the plan — so a shutdown landing inside
      // it resumed, closed the queue, and the plan never reached disk while the
      // quit reported success.
      const sessionId = 'sess_plan_handoff'
      const managed = seedManaged(sessionId, { messageQueue: [] })
      const visuals = holdBrowserRelease()
      managed.agent = { interruptForHandoff: () => {} }

      turns().setProcessing(managed, true)
      ;(managed.messages as unknown[]).push({
        id: 'plan-1',
        role: 'plan',
        content: 'the plan submitted while shutdown waited',
        timestamp: Date.now(),
      })

      // Parks at the browser release, with the flag already down.
      void turns().completePlanSubmissionHandoff(managed)
      await new Promise((r) => setTimeout(r, 20))
      expect(managed.isProcessing).toBe(false)
      expect(managed.turnFinalization).toBeDefined()

      let settled = false
      const shutdown = sm.flushAllSessions().then(() => { settled = true })
      await new Promise((r) => setTimeout(r, 80))

      // The owner still holds it, so the queue is still open.
      expect(settled).toBe(false)
      expect(sessionPersistenceQueue.isClosing).toBe(false)

      visuals.release()
      await shutdown

      expect(settled).toBe(true)
      expect(readFileSync(getSessionFilePath(root, sessionId), 'utf-8')).toContain(
        'the plan submitted while shutdown waited',
      )
    }, 20000)

    it('releases the auth handoff after its persist, and the pending request lands', async () => {
      // The auth handoff's tail is synchronous, so what it has to get right is
      // the release: held past the persist, and actually released afterwards.
      // A forgotten `finally` here is invisible until a quit, which then waits
      // out its entire drain bound and reports a stuck turn that is not stuck.
      const sessionId = 'sess_auth_handoff'
      const managed = seedManaged(sessionId, { messageQueue: [] })
      holdBrowserRelease()  // never released: the auth tail must not await it
      managed.agent = { interruptForHandoff: () => {} }

      turns().setProcessing(managed, true)
      const authMessage = {
        id: 'auth-1',
        role: 'auth-request',
        content: 'Sign in to Linear',
        timestamp: Date.now(),
        authRequestId: 'req_1',
        authStatus: 'pending',
      }
      ;(managed.messages as unknown[]).push(authMessage)
      turns().completeAuthRequestHandoff(
        managed,
        { requestId: 'req_1', type: 'oauth', sourceSlug: 'linear', sourceName: 'Linear' },
        authMessage,
      )

      expect(managed.isProcessing).toBe(false)
      expect(managed.turnFinalization).toBeUndefined()

      const started = Date.now()
      await sm.flushAllSessions()
      expect(Date.now() - started).toBeLessThan(2000)
      expect(readFileSync(getSessionFilePath(root, sessionId), 'utf-8')).toContain('Sign in to Linear')
    }, 20000)

    it('a stale owner cannot resolve the turn that replaced it', () => {
      // Turns are serial per session; their tails are not. An owner whose turn
      // has already been superseded must release NOTHING — resolving the live
      // deferred would tell shutdown that the new turn is finalised while it is
      // still assembling state.
      const sessionId = 'sess_stale_owner'
      const managed = seedManaged(sessionId, { messageQueue: [] })

      turns().setProcessing(managed, true)
      const firstPromise = (managed.turnFinalization as { promise: Promise<void> }).promise
      let firstSettled = false
      void firstPromise.then(() => { firstSettled = true })

      // The first turn stops with a tail still in flight — its owner has not
      // released yet.
      const stale = turns().claimTurnFinalization(sessionId)
      turns().setProcessing(managed, false, stale)
      expect(managed.turnFinalization).toBeDefined()

      // The successor starts before that tail finishes.
      turns().setProcessing(managed, true)
      const successor = managed.turnFinalization
      expect(successor).not.toBe(undefined)

      stale.release()
      expect(managed.turnFinalization).toBe(successor)

      // And the superseded deferred was settled rather than orphaned: shutdown
      // may hold a reference to it, and nothing else can ever answer it.
      return Promise.resolve().then(() => {
        expect(firstSettled).toBe(true)
        // The successor's own owner does release it.
        turns().claimTurnFinalization(sessionId).release()
        expect(managed.turnFinalization).toBeUndefined()
      })
    })
  })

  describe('a cancelled final receipt is never accepted', () => {
    it('re-snapshots after a supersession and commits the merged state', async () => {
      // The positive half. A supersession is a RETRY, not an acceptance: the
      // reconciliation has merged the external edit into managed state, so the
      // next snapshot carries both its change and ours. Accepting the cancelled
      // receipt instead would report success on bytes nobody wrote.
      const sessionId = 'sess_retry_merges'
      const managed = seedManaged(sessionId, {
        messageQueue: [{ message: 'queued', messageId: 'q1' }],
      })
      ;(managed.messages as unknown[]).push({
        id: 'ours-1',
        role: 'assistant',
        content: 'our final state',
        timestamp: Date.now(),
      })

      const file = getSessionFilePath(root, sessionId)
      let superseded = false
      disposeHooks = installSingletonCommitHooksForTesting({
        afterRename: (key) => {
          if (superseded || key !== sessionWriteKey(root, sessionId)) return
          superseded = true
          // A watcher reconciliation lands mid-commit, carrying an external
          // edit to a field only the merge can preserve.
          const header = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>
          sessionPersistenceQueue.supersedePendingWrites(key, {
            ...header,
            permissionMode: 'safe',
          } as never)
        },
      })

      // Resolves: the retry commits.
      await sm.flushAllSessions()
      disposeHooks?.()
      disposeHooks = undefined

      expect(superseded).toBe(true)
      const contents = readFileSync(file, 'utf-8')
      const header = JSON.parse(contents.split('\n')[0]!) as Record<string, unknown>
      // Both survive: our final state AND the external edit it collided with.
      expect(contents).toContain('our final state')
      expect(header.permissionMode).toBe('safe')
    }, 20000)

    it('rejects rather than reporting success when the replacement write cannot land', async () => {
      // The hole in "a supersession is fine, the replacement carries it": the
      // replacement can FAIL. Here the reconciliation supersedes the final
      // write and then the session file's directory is made unwritable, so
      // nothing can commit. Shutdown must not report success over a session
      // that was never written.
      const sessionId = 'sess_replacement_fails'
      // Queued work, so the session qualifies for a final write at all — an
      // idle one is deliberately skipped, which is a different behaviour and
      // not what this test is about.
      const managed = seedManaged(sessionId, {
        messageQueue: [{ message: 'queued', messageId: 'q1' }],
      })
      ;(managed.messages as unknown[]).push({
        id: 'never-landed',
        role: 'assistant',
        content: 'state that cannot be written',
        timestamp: Date.now(),
      })

      const file = getSessionFilePath(root, sessionId)
      let sabotaged = false
      disposeHooks = installSingletonCommitHooksForTesting({
        afterRename: (key) => {
          if (sabotaged || key !== sessionWriteKey(root, sessionId)) return
          sabotaged = true
          // Supersede the final write, then make every later write fail: a
          // DIRECTORY where the temp file goes gives EISDIR.
          sessionPersistenceQueue.supersedePendingWrites(key)
          mkdirSync(file + '.tmp', { recursive: true })
        },
      })

      await expect(sm.flushAllSessions()).rejects.toThrow(/not clean/)
      disposeHooks?.()
      disposeHooks = undefined

      expect(sabotaged).toBe(true)
      // Cleanup so afterEach can remove the root.
      rmSync(file + '.tmp', { recursive: true, force: true })
    }, 20000)

    it('waits for a send admitted before the freeze, and that send refuses without mutating', async () => {
      // The entry refusal answers "may this send START", and a send already
      // past it is invisible to shutdown: `sendMessage` awaits the stored-plan
      // clear and the message hydration before it touches anything. A quit
      // landing in that window found nothing to wait for, the send resumed into
      // a closing queue, pushed a user message that could no longer be written,
      // and ACKed it to the client. Held hydration reproduces exactly that.
      const sessionId = 'sess_admitted_send'
      const managed = seedManaged(sessionId, { messageQueue: [] })

      let releaseLoad!: () => void
      const loadHeld = new Promise<void>((r) => { releaseLoad = r })
      ;(sm as unknown as {
        ensureMessagesLoaded(m: unknown): Promise<void>
      }).ensureMessagesLoaded = async () => { await loadHeld }

      let acked = false
      const send = sm.sendMessage(
        sessionId, 'a message that must not be half-accepted',
        undefined, undefined, undefined, undefined, undefined,
        () => { acked = true },
      ).then(() => 'resolved').catch((e: unknown) => e)
      await new Promise((r) => setTimeout(r, 20))

      let settled = false
      const shutdown = sm.flushAllSessions().then(() => { settled = true })
      await new Promise((r) => setTimeout(r, 80))

      // Shutdown is waiting on the admission: the queue is still OPEN, so the
      // send can still finish honestly either way.
      expect(settled).toBe(false)
      expect(sessionPersistenceQueue.isClosing).toBe(false)

      releaseLoad()
      const outcome = await send
      expect(String(outcome)).toMatch(/shutting down/)
      // Nothing was mutated and nothing was promised.
      expect((managed.messages as Array<{ content?: string }>).some(
        (m) => m.content === 'a message that must not be half-accepted',
      )).toBe(false)
      expect(acked).toBe(false)

      await shutdown
      expect(settled).toBe(true)
      expect(readFileSync(getSessionFilePath(root, sessionId), 'utf-8')).not.toContain(
        'a message that must not be half-accepted',
      )
    }, 20000)

    it('hands ownership from the admission to the turn with no gap', () => {
      // The handover is the one instant where a session could fall between the
      // two things shutdown looks at. Release the admission first and there is
      // a moment where the send no longer counts and the turn does not yet — a
      // candidate scan landing there reads an idle session and writes nothing.
      const sessionId = 'sess_admission_transfer'
      const managed = seedManaged(sessionId, { messageQueue: [] })

      const admission = turns().admitSend(sessionId)
      expect(turns().sendAdmissions.size).toBe(1)

      turns().beginTurnFromAdmittedSend(managed, admission)

      // The turn is watching now, and the admission is spent — not the other
      // way round, and not both at once.
      expect(managed.turnFinalization).toBeDefined()
      expect(turns().sendAdmissions.size).toBe(0)
      // The consequence that matters: shutdown still sees work to write.
      expect(turns().collectSessionsNeedingFinalPersist().map((m) => m.id)).toContain(sessionId)
    })

    it('refuses to report a clean shutdown when an IDLE session\'s drained write fails', async () => {
      // The session shutdown deliberately does NOT give a final checked write:
      // it is idle, so the write already queued IS its latest state and the
      // drain carries it. That decision is right, and it left a hole — the
      // drain's own failures had no reader. An ordinary write has no receipt
      // holder, `write` catches its own errors, and the queue went quiescent,
      // so quit reported success over a session that never reached disk.
      const sessionId = 'sess_idle_write_fails'
      const managed = seedManaged(sessionId, { messageQueue: [] })
      ;(managed.messages as unknown[]).push({
        id: 'idle-edit',
        role: 'assistant',
        content: 'an edit that cannot be written',
        timestamp: Date.now(),
      })

      // Idle, with one ordinary write pending — and a DIRECTORY where its temp
      // file goes, so the drain's attempt fails with EISDIR.
      const file = getSessionFilePath(root, sessionId)
      ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
      mkdirSync(file + '.tmp', { recursive: true })

      await expect(sm.flushAllSessions()).rejects.toThrow(/failed during the drain/)

      rmSync(file + '.tmp', { recursive: true, force: true })
    }, 20000)
  })
})
