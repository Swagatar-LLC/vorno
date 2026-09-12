/**
 * SUV-0066 — `markAllSessionsRead` reports partial failure honestly.
 *
 * It flips `hasUnread` in memory for every eligible session FIRST, then writes.
 * That ordering makes the failure path the interesting one: by the time a write
 * rejects, the badge state is already changed, so bailing out without emitting
 * the summary leaves the UI showing counts that memory disagrees with.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { getSessionFilePath, writeSessionJsonl, type StoredSession } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_mark_read'

describe('markAllSessionsRead', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mark-read-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seed(id: string) {
    const filePath = getSessionFilePath(root, id)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id,
      workspaceRootPath: root,
      name: id,
      sessionStatus: 'todo',
      hasUnread: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id, name: id, sessionStatus: 'todo', hasUnread: true, createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'hi' }]
    managed.hasUnread = true
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  /** Count summary emissions without needing a real event sink. */
  function countSummaries(): () => number {
    let emitted = 0
    ;(sm as unknown as { emitUnreadSummaryChanged(): void }).emitUnreadSummaryChanged = () => { emitted++ }
    return () => emitted
  }

  it('marks every session read and emits the summary once', async () => {
    const a = seed('ok-a')
    const b = seed('ok-b')
    const summaries = countSummaries()

    await sm.markAllSessionsRead(WORKSPACE_ID)

    expect(a.hasUnread).toBe(false)
    expect(b.hasUnread).toBe(false)
    expect(summaries()).toBe(1)
  })

  it('still saves the good sessions, emits the summary, and names the failures', async () => {
    // One session made unwritable — a DIRECTORY where its temp file goes gives
    // EISDIR on every attempt — while the others are fine.
    const good = seed('good-1')
    seed('broken-1')
    const alsoGood = seed('good-2')
    mkdirSync(getSessionFilePath(root, 'broken-1') + '.tmp', { recursive: true })
    const summaries = countSummaries()

    // Reports a PARTIAL result, naming what failed rather than stopping at the
    // first rejection and reporting one of however many there were.
    await expect(sm.markAllSessionsRead(WORKSPACE_ID)).rejects.toThrow(/broken-1/)

    // The sessions that could be saved were saved: `Promise.all` would have
    // rejected while these were still in flight.
    expect(good.hasUnread).toBe(false)
    expect(alsoGood.hasUnread).toBe(false)

    // And the one that could NOT be saved reads unread again. The clear at the
    // top of the method is optimistic; disk still says unread, so leaving
    // memory saying read would broadcast a badge no restart agrees with — the
    // count would silently reappear next launch with nothing to explain it.
    const broken = (sm as unknown as { sessions: Map<string, { hasUnread?: boolean }> })
      .sessions.get('broken-1')!
    expect(broken.hasUnread).toBe(true)

    // And the badge event fired anyway — the in-memory flags changed before any
    // write ran, so suppressing it on the error path is what leaves the UI
    // disagreeing with memory.
    expect(summaries()).toBe(1)

    rmSync(getSessionFilePath(root, 'broken-1') + '.tmp', { recursive: true, force: true })
  })

  it('does not clobber a read that succeeded while the batch was running', async () => {
    // The rollback runs after an await, so it must not blindly assert "unread".
    // A user can open a session mid-batch; that read saves successfully, and
    // re-marking it unread would resurrect a badge for something they just
    // read. So the rollback asks the FILE what is true instead of assuming.
    const racer = seed('raced-1')
    mkdirSync(getSessionFilePath(root, 'raced-1') + '.tmp', { recursive: true })

    // The batch's write for this session will fail. Meanwhile the session is
    // genuinely read and that state reaches disk — simulated by writing the
    // header directly, which is what a successful concurrent save leaves.
    const filePath = getSessionFilePath(root, 'raced-1')
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    header.hasUnread = false
    writeFileSync(filePath, [JSON.stringify(header), ...lines.slice(1)].join('\n'))

    await expect(sm.markAllSessionsRead(WORKSPACE_ID)).rejects.toThrow(/raced-1/)

    // Disk says read, so memory says read — the failed write is reported, but
    // it does not overwrite a newer truth.
    expect(racer.hasUnread).toBe(false)

    rmSync(getSessionFilePath(root, 'raced-1') + '.tmp', { recursive: true, force: true })
  })
})
