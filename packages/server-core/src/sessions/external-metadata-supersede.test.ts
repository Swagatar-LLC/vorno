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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSessionFilePath,
  sessionPersistenceQueue,
  sessionWriteKey,
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
      afterRename: (hookKey) => {
        // The hook hands back the QUEUE's key, not a session id — they are
        // different things, and comparing them would silently never match.
        if (applied || hookKey !== sessionWriteKey(root, SESSION_ID)) return
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

  it('lands an external label edit even when a stale write commits over it', async () => {
    // The window a supersede alone cannot close. A write that read its header
    // before the edit, and renames after the watcher saw it, commits a pre-edit
    // snapshot over the edit — and supersede correctly keeps that file, so disk
    // no longer holds the edit and the baseline matches the stale file. `labels`
    // is one of the five fields this reconciliation does not copy into memory,
    // so the observed header is the only surviving copy.
    const managed = seed()
    const file = getSessionFilePath(root, SESSION_ID)
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    // The edit has to touch BOTH a field the reconciliation tracks and one it
    // does not, and the second one has to be genuinely merge-only.
    //
    // Without the tracked field, `applyExternalSessionMetadata` returns
    // `changed: false` and never calls supersede at all. And `labels` — the
    // first choice here — turned out to be the WRONG second field: the
    // reconciliation copies it into the managed session, so the next write
    // persists it from memory and the assertion holds with the fix removed.
    // Only `permissionMode`, `hasUnread` and `lastReadMessageId` are carried by
    // the merge alone. `name` makes the branch run; `lastReadMessageId` is what
    // can only survive via the observed header.
    const externalHeader = () => {
      const lines = readFileSync(file, 'utf-8').split('\n')
      const header = JSON.parse(lines[0]!) as Record<string, unknown>
      header.name = 'Renamed elsewhere'
      header.lastReadMessageId = 'external-only'
      writeFileSync(file, [JSON.stringify(header), ...lines.slice(1)].join('\n'))
      return header
    }

    let observed: Record<string, unknown> | undefined
    let superseded = false
    sessionPersistenceQueue.commitHooks = {
      // The edit lands after the in-flight write computed its header.
      beforeUnlink: () => { if (!observed) observed = externalHeader() },
      // The watcher sees it while that write is mid-commit.
      afterRename: () => {
        if (!observed) return
        const header = observed
        observed = undefined
        superseded = applyExternal(header)
      },
    }
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    sessionPersistenceQueue.commitHooks = undefined

    // Fail loudly rather than let the assertions below pass without the path
    // under test ever having run.
    expect(superseded).toBe(true)

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    const after = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>
    expect(after.lastReadMessageId).toBe('external-only')
    expect(after.name).toBe('Renamed elsewhere')
    expect(existsSync(file)).toBe(true)
  })

  it('supersedes a PURE merge-only edit that changes nothing in memory', async () => {
    // The supersede used to sit inside `if (changed)`, and `changed` only tracks
    // fields this reconciliation mirrors into memory. An edit touching only
    // `permissionMode` left it false — so no supersede, nothing held, and the
    // in-flight stale write committed straight over the edit.
    //
    // It has to be mid-commit to prove anything. With an idle queue the ordinary
    // disk merge recovers the edit on its own, so the assertions hold with the
    // fix removed — which is exactly how the first version of this test passed.
    const managed = seed()
    const file = getSessionFilePath(root, SESSION_ID)
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    const externalHeader = () => {
      const lines = readFileSync(file, 'utf-8').split('\n')
      const header = JSON.parse(lines[0]!) as Record<string, unknown>
      header.permissionMode = 'safe'
      writeFileSync(file, [JSON.stringify(header), ...lines.slice(1)].join('\n'))
      return header
    }

    let observed: Record<string, unknown> | undefined
    let changedReported: boolean | undefined
    sessionPersistenceQueue.commitHooks = {
      beforeUnlink: () => { if (!observed) observed = externalHeader() },
      afterRename: () => {
        if (!observed) return
        const header = observed
        observed = undefined
        changedReported = applyExternal(header)
      },
    }
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    sessionPersistenceQueue.commitHooks = undefined

    // Nothing this method mirrors moved, so it reports no in-memory change —
    // and it must have superseded anyway.
    expect(changedReported).toBe(false)

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    const after = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>
    expect(after.permissionMode).toBe('safe')
  })

  it('does not strip the header-signature baseline the next write needs', async () => {
    const managed = seed()
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    const before = sessionPersistenceQueue.getLastWrittenSignature(sessionWriteKey(root, SESSION_ID))
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
    expect(sessionPersistenceQueue.getLastWrittenSignature(sessionWriteKey(root, SESSION_ID))).toBeDefined()
  })
})
