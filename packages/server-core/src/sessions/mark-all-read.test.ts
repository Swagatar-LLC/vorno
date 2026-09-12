/**
 * SUV-0066 — `markAllSessionsRead` reports partial failure honestly.
 *
 * It flips `hasUnread` in memory for every eligible session FIRST, then writes.
 * That ordering makes the failure path the interesting one: by the time a write
 * rejects, the badge state is already changed, so bailing out without emitting
 * the summary leaves the UI showing counts that memory disagrees with.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

    // And the badge event fired anyway — the in-memory flags changed before any
    // write ran, so suppressing it on the error path is what leaves the UI
    // disagreeing with memory.
    expect(summaries()).toBe(1)

    rmSync(getSessionFilePath(root, 'broken-1') + '.tmp', { recursive: true, force: true })
  })
})
