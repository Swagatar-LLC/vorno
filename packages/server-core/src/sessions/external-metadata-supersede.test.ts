/**
 * SUV-0066 — the external-metadata reconciliation path must SUPERSEDE, never
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
  getHeaderMetadataSignature,
  getSessionFilePath,
  sessionPersistenceQueue,
  sessionWriteKey,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { installSingletonCommitHooksForTesting } from '@craft-agent/shared/sessions/internal'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_external'
const SESSION_ID = 'sess_external_edit'

describe('external metadata reconciliation', () => {
  let root: string
  /** Disposer for this suite's own hooks; never clears another owner's. */
  let disposeHooks: (() => void) | undefined
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'external-meta-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    // Shared module singleton — a leaked hook would fire inside every other
    // suite's writes.
    disposeHooks?.()
    disposeHooks = undefined
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
    disposeHooks = installSingletonCommitHooksForTesting({
      afterRename: (hookKey: string) => {
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
    })

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    expect(applied).toBe(true)

    // The moment that matters: the file is still here. The deletion variant
    // unlinks it at exactly this point, for a session nobody deleted.
    expect(existsSync(file)).toBe(true)

    disposeHooks?.()
    await sm.flushSession(SESSION_ID)
    expect(existsSync(file)).toBe(true)
    // And the transcript is intact, not merely the path.
    expect(readFileSync(file, 'utf-8')).toContain('real transcript content')
  })

  it('lands an external label edit even when a stale write commits over it', async () => {
    // The window a supersede alone cannot close. A write that read its header
    // before the edit, and renames after the watcher saw it, commits a pre-edit
    // snapshot over the edit — and supersede correctly keeps that file, so disk
    // no longer holds the edit and the baseline matches the stale file. The
    // observed header is then the only surviving copy.
    const managed = seed()
    const file = getSessionFilePath(root, SESSION_ID)
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    // The edit has to touch BOTH a field the reconciliation tracks and one it
    // does not, and the second one has to be genuinely merge-only.
    //
    // Picking that second field has now been got wrong twice, so it is worth
    // stating how to check it. `applyExternalSessionMetadata` copies SIX of the
    // seven merged fields into the managed session — `name`, `labels`,
    // `isFlagged`, `sessionStatus`, `lastReadMessageId`, `hasUnread` — so for
    // any of those the next write persists the value from memory and the
    // assertion holds with the merge removed, proving nothing. `labels` was the
    // first wrong choice; `lastReadMessageId` was the second, and it only
    // became wrong when read-state mirroring was added to that method.
    //
    // Exactly ONE field is merge-only: `permissionMode`, deliberately not
    // mirrored because it is a declared-intent mutation with its own event.
    // `name` makes the `changed` branch run; `permissionMode` is what can only
    // survive via the observed header. Verified by disabling the observation
    // mechanism and watching this test fail.
    const externalHeader = () => {
      const lines = readFileSync(file, 'utf-8').split('\n')
      const header = JSON.parse(lines[0]!) as Record<string, unknown>
      header.name = 'Renamed elsewhere'
      header.permissionMode = 'safe'
      writeFileSync(file, [JSON.stringify(header), ...lines.slice(1)].join('\n'))
      return header
    }

    let observed: Record<string, unknown> | undefined
    let superseded = false
    disposeHooks = installSingletonCommitHooksForTesting({
      // The edit lands after the in-flight write computed its header.
      beforeUnlink: () => { if (!observed) observed = externalHeader() },
      // The watcher sees it while that write is mid-commit.
      afterRename: () => {
        if (!observed) return
        const header = observed
        observed = undefined
        superseded = applyExternal(header)
      },
    })
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    disposeHooks?.()

    // Fail loudly rather than let the assertions below pass without the path
    // under test ever having run.
    expect(superseded).toBe(true)

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    const after = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>
    expect(after.permissionMode).toBe('safe')
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
    disposeHooks = installSingletonCommitHooksForTesting({
      beforeUnlink: () => { if (!observed) observed = externalHeader() },
      afterRename: () => {
        if (!observed) return
        const header = observed
        observed = undefined
        changedReported = applyExternal(header)
      },
    })
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    disposeHooks?.()

    // Nothing this method mirrors moved, so it reports no in-memory change —
    // and it must have superseded anyway.
    expect(changedReported).toBe(false)

    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    const after = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>
    expect(after.permissionMode).toBe('safe')
  })

  it('absorbs a foreign header in one write, and our own echo stops there', async () => {
    // The supersede decision no longer waits for `changed`, so an edit to a
    // session this process has never written now reads as diverged — there is
    // no baseline to compare against. That is the right answer, and the risk it
    // introduces is a ping-pong: two running copies of the app each treating
    // the other's write as divergence and writing again forever.
    //
    // It converges because our write ADOPTS the external values for all seven
    // merged fields, so our new baseline equals theirs and their echo of our
    // write compares equal. Only those seven fields are in the signature, so
    // message counts and timestamps drifting apart cannot restart it.
    const managed = seed()
    const file = getSessionFilePath(root, SESSION_ID)
    const header = () => JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!) as Record<string, unknown>

    // `permissionMode` on purpose. `name` would prove much less: this method
    // copies it into the managed session, so the outgoing header carries it
    // whether or not the merge works, and the assertion would pass with the
    // merge removed. `permissionMode` is deliberately NOT mirrored, so the only
    // route by which it can reach disk is the observation the supersede holds.
    expect(sessionPersistenceQueue.getLastWrittenSignature(sessionWriteKey(root, SESSION_ID))).toBeUndefined()
    const lines = readFileSync(file, 'utf-8').split('\n')
    const foreign = { ...header(), name: 'Renamed by the other instance', permissionMode: 'safe' }
    writeFileSync(file, [JSON.stringify(foreign), ...lines.slice(1)].join('\n'))

    applyExternal(foreign)
    await sm.flushSession(SESSION_ID)

    // Absorbed, including the field nothing copies into memory.
    expect(header().name).toBe('Renamed by the other instance')
    expect(header().permissionMode).toBe('safe')

    // And the loop closes: our own write, seen through the watcher, is no
    // longer divergence. `getLastWrittenSignature` is exactly what the watcher
    // path compares against, so this is the real termination condition.
    const baseline = sessionPersistenceQueue.getLastWrittenSignature(sessionWriteKey(root, SESSION_ID))
    expect(baseline).toBeDefined()
    expect(getHeaderMetadataSignature(header() as never)).toBe(baseline!)
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
    // this path exists to absorb — `permissionMode` is carried by the merge
    // alone, so it has nothing else to fall back on.
    expect(sessionPersistenceQueue.getLastWrittenSignature(sessionWriteKey(root, SESSION_ID))).toBeDefined()
  })
})
