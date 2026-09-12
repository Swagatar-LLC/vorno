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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    const managed = { autoRetryTimer: setTimeout(() => { fired = true }, 30), autoRetryPending: { committed: false } }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('retry-session', managed)

    await sm.flushAllSessions()

    expect(managed.autoRetryTimer).toBeUndefined()
    expect(managed.autoRetryPending).toBeUndefined()
    // And it genuinely does not fire afterwards.
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toBe(false)
  })

  it('cancels the forced turn-cleanup timer, so a quit inside its window writes nothing', async () => {
    // The other per-session producer, and the subtler one: the 5s safety timer
    // that forces turn cleanup when a stopped generator does not drain calls
    // `onProcessingStopped`, which persists. A quit landing inside that window
    // would let it fire against a frozen queue — a refused write, and an exit
    // without the finalised turn while the flush reported quiescence.
    let fired = false
    const managed = {
      forceStopCleanupTimer: setTimeout(() => { fired = true }, 30),
      stopRequested: true,
      isProcessing: true,
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('stuck-session', managed)

    await sm.flushAllSessions()

    expect(managed.forceStopCleanupTimer).toBeUndefined()
    await new Promise((r) => setTimeout(r, 60))
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
})
