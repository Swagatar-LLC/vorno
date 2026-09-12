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
})
