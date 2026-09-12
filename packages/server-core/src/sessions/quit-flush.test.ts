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
  setSingletonCommitHooksForTesting,
  sessionWriteKey,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_quit'
const SESSION_ID = 'sess_quit'

describe('quit flushes sessions that are mid-commit', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quit-flush-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    // Shared module singleton — a leaked hook fires inside every later suite.
    setSingletonCommitHooksForTesting(undefined)
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
    setSingletonCommitHooksForTesting({
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
})
