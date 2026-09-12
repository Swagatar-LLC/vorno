/**
 * SUV-0064 — the external-metadata reconciliation path must SUPERSEDE, never
 * cancel-for-deletion.
 *
 * `applyExternalSessionMetadata` stops pending writes so a stale one cannot
 * revert the edit it just absorbed. Both intents stop pending writes; only one
 * of them is allowed to remove the session's file, and this path is a LIVE
 * session. Getting it wrong deletes a real transcript — and because the
 * replacement write is debounced, leaves the session absent from disk in the
 * meantime.
 *
 * Tested through `SessionManager` rather than the queue so the binding itself
 * is covered: a queue-level test would pass no matter which method this caller
 * reached for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSessionFilePath,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_external'
const SESSION_ID = 'sess_external_edit'

describe('external metadata reconciliation', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'external-meta-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    // Shared module singleton — a leaked hook would fire inside every other
    // suite's writes.
    sessionPersistenceQueue.commitHooks = undefined
    rmSync(root, { recursive: true, force: true })
  })

  function seed() {
    const filePath = getSessionFilePath(root, SESSION_ID)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: SESSION_ID,
      workspaceRootPath: root,
      name: 'Original name',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'real transcript content' }],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id: SESSION_ID, name: 'Original name', sessionStatus: 'todo', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'External WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'real transcript content' }]
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)
    return managed
  }

  function applyExternal(header: Record<string, unknown>): boolean {
    return (
      sm as unknown as {
        applyExternalSessionMetadata(m: unknown, h: unknown): boolean
      }
    ).applyExternalSessionMetadata(
      (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(SESSION_ID),
      header,
    )
  }

  it('keeps the session file on disk when an external rename lands mid-commit', async () => {
    const managed = seed()
    const file = getSessionFilePath(root, SESSION_ID)

    // The external edit has to arrive INSIDE a write, after its rename has
    // committed — that is the only window in which the two intents behave
    // differently. An edit arriving while the queue is idle leaves nothing to
    // abandon, so it would pass under either variant and prove nothing.
    let applied = false
    sessionPersistenceQueue.commitHooks = {
      afterRename: (id) => {
        if (applied || id !== SESSION_ID) return
        applied = true
        applyExternal({
          id: SESSION_ID,
          name: 'Renamed elsewhere',
          sessionStatus: 'todo',
          createdAt: Date.now(),
        })
      },
    }

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    expect(applied).toBe(true)

    // The moment that matters: the file is still here. The deletion variant
    // unlinks it at exactly this point, for a session nobody deleted.
    expect(existsSync(file)).toBe(true)

    sessionPersistenceQueue.commitHooks = undefined
    await sm.flushSession(SESSION_ID)
    expect(existsSync(file)).toBe(true)
    // And the transcript is intact, not merely the path.
    expect(readFileSync(file, 'utf-8')).toContain('real transcript content')
  })

  it('does not strip the header-signature baseline the next write needs', async () => {
    const managed = seed()
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    const before = sessionPersistenceQueue.getLastWrittenSignature(SESSION_ID)
    expect(before).toBeDefined()

    applyExternal({
      id: SESSION_ID,
      name: 'Renamed elsewhere',
      sessionStatus: 'todo',
      createdAt: Date.now(),
    })

    // The deletion variant drops this. Without it, `write`'s external-change
    // detection goes dark and the next write clobbers exactly the kind of edit
    // this path exists to absorb — `labels`, `isFlagged`, `permissionMode`,
    // `hasUnread` and `lastReadMessageId` are carried by the merge alone.
    expect(sessionPersistenceQueue.getLastWrittenSignature(SESSION_ID)).toBeDefined()
  })
})
