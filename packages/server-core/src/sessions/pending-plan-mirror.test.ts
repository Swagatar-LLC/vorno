/**
 * SUV-0066 — pending-plan state has a real managed lifetime, and its draft text
 * never reaches the wire.
 *
 * Two defects meet in this field, and they pull in opposite directions.
 *
 * `headerToMetadata` used to strip `pendingPlanExecution` on the way from disk
 * to the managed session. But `createManagedSession` builds the in-memory
 * session from that shape and `persistSession` rebuilds the header from the
 * in-memory session, so the field existed only on disk — and the next persist
 * from ANY writer silently deleted it. Letting it through the projection is
 * what gives it a lifetime; the four owners below then keep the mirror in step,
 * because a stale mirror is the same bug pointing the other way.
 *
 * Letting it through makes it reachable from `pickSessionFields`, which is
 * spread into every wire `Session`. It carries `draftInputSnapshot` — text the
 * user typed and did not send — so `managedToSession` has to omit it, or every
 * session-list push broadcasts unsent user text to every connected client.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getSessionFilePath,
  listSessions as listStoredSessions,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_pending_plan'
const SESSION_ID = 'sess_pending_plan'
const PLAN_PATH = '/plans/adopt-the-thing.md'
const DRAFT = 'the half-typed sentence the user never sent'

describe('pending plan execution mirror', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pending-plan-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    sessionPersistenceQueue.commitHooks = undefined
    rmSync(root, { recursive: true, force: true })
  })

  function seed() {
    const filePath = getSessionFilePath(root, SESSION_ID)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: SESSION_ID,
      workspaceRootPath: root,
      name: 'Planning session',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'transcript' }],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id: SESSION_ID, name: 'Planning session', sessionStatus: 'todo', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Plan WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'transcript' }]
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)
    return managed
  }

  /** The header as it actually sits on disk, not as we believe we wrote it. */
  function diskHeader(): Record<string, unknown> {
    const contents = readFileSync(getSessionFilePath(root, SESSION_ID), 'utf-8')
    return JSON.parse(contents.split('\n')[0]!) as Record<string, unknown>
  }

  /**
   * An ordinary persist by any writer — the thing that used to destroy this
   * field. Not a pending-plan call: the point is that a write which knows
   * nothing about plans must carry the state anyway.
   */
  async function unrelatedPersist(managed: unknown) {
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
  }

  it('reaches memory through the cold-load projection, so a restart keeps it', async () => {
    // The defect at its origin, and the only test here that exercises
    // `headerToMetadata`. The four owner methods below seed the mirror from a
    // fresh disk read, so they are green even with the projection stripping the
    // field — which is exactly how this went unnoticed. The path that cannot
    // route around the projection is app start: `listSessions` reads headers
    // into `SessionMetadata` and `createManagedSession` builds the managed
    // session from that. Strip the field there and a session that had a pending
    // plan when the app closed loses it on the first write after it reopens.
    const filePath = getSessionFilePath(root, SESSION_ID)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: SESSION_ID,
      workspaceRootPath: root,
      name: 'Planning session',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{ role: 'user', content: 'transcript' }],
      pendingPlanExecution: {
        planPath: PLAN_PATH,
        draftInputSnapshot: DRAFT,
        awaitingCompaction: true,
        executionDispatched: false,
      },
    } as unknown as StoredSession)

    const meta = listStoredSessions(root).find((s) => s.id === SESSION_ID)
    expect(meta).toBeDefined()
    // The projection carried it. This is the assertion the strip breaks.
    expect(meta!.pendingPlanExecution?.planPath).toBe(PLAN_PATH)

    const managed = createManagedSession(
      meta as never,
      { id: WORKSPACE_ID, name: 'Plan WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = [{ role: 'user', content: 'transcript' }]
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)

    expect((managed.pendingPlanExecution as { planPath?: string } | undefined)?.planPath).toBe(PLAN_PATH)

    // And the first write after the restart keeps it rather than deleting it.
    await unrelatedPersist(managed)
    expect((diskHeader().pendingPlanExecution as Record<string, unknown>).planPath).toBe(PLAN_PATH)
  })

  it('survives an unrelated persist instead of being dropped by it', async () => {
    const managed = seed()
    await sm.setPendingPlanExecution(SESSION_ID, PLAN_PATH, DRAFT)

    // The write that used to delete it: it rebuilds the header from managed
    // state, so before the mirror existed this call wrote the field away.
    await unrelatedPersist(managed)

    const pending = diskHeader().pendingPlanExecution as Record<string, unknown> | undefined
    expect(pending).toBeDefined()
    expect(pending!.planPath).toBe(PLAN_PATH)
    expect(pending!.draftInputSnapshot).toBe(DRAFT)
    // And the reader agrees with disk, so the mirror is not merely present but
    // in step with what was stored.
    expect(sm.getPendingPlanExecution(SESSION_ID)?.planPath).toBe(PLAN_PATH)
  })

  it('carries a completed compaction rather than reviving awaitingCompaction', async () => {
    const managed = seed()
    await sm.setPendingPlanExecution(SESSION_ID, PLAN_PATH, DRAFT)
    await sm.markCompactionComplete(SESSION_ID)

    // A stale mirror writes the OLD value back here, which would un-complete a
    // compaction that had finished and leave reload recovery waiting forever.
    await unrelatedPersist(managed)

    const pending = diskHeader().pendingPlanExecution as Record<string, unknown>
    expect(pending.awaitingCompaction).toBe(false)
  })

  it('carries a dispatched flag, so recovery cannot double-submit the plan', async () => {
    const managed = seed()
    await sm.setPendingPlanExecution(SESSION_ID, PLAN_PATH)
    await sm.markPendingPlanExecutionDispatched(SESSION_ID)

    await unrelatedPersist(managed)

    expect((diskHeader().pendingPlanExecution as Record<string, unknown>).executionDispatched).toBe(true)
  })

  it('does not write a dismissed plan back after it is cleared', async () => {
    const managed = seed()
    await sm.setPendingPlanExecution(SESSION_ID, PLAN_PATH, DRAFT)
    await unrelatedPersist(managed)
    expect(diskHeader().pendingPlanExecution).toBeDefined()

    await sm.clearPendingPlanExecution(SESSION_ID)
    // The other half of the mirror rule. Clearing only on disk leaves the
    // managed copy holding the plan, and this persist restores it — the user
    // dismisses a plan and it comes back.
    await unrelatedPersist(managed)

    expect(diskHeader().pendingPlanExecution).toBeUndefined()
    expect(sm.getPendingPlanExecution(SESSION_ID)).toBeNull()
  })

  it('keeps the unsent draft out of every wire projection', async () => {
    seed()
    await sm.setPendingPlanExecution(SESSION_ID, PLAN_PATH, DRAFT)

    // Both doors onto the wire: the list push and the single-session fetch.
    const listed = sm.getSessions(WORKSPACE_ID).find((s) => s.id === SESSION_ID)
    const fetched = await sm.getSession(SESSION_ID)

    expect(listed).toBeDefined()
    expect(fetched).toBeTruthy()
    // The field is absent, not merely empty: `pickSessionFields` takes it
    // automatically now that it lives on the managed session, so the omission
    // has to be an action rather than a hope.
    expect('pendingPlanExecution' in (listed as object)).toBe(false)
    expect('pendingPlanExecution' in (fetched as object)).toBe(false)
    // The draft text itself appears nowhere in either payload, whatever shape a
    // future field might smuggle it in under.
    expect(JSON.stringify(listed)).not.toContain(DRAFT)
    expect(JSON.stringify(fetched)).not.toContain(DRAFT)

    // It is still readable through the deliberate door, so the omission has not
    // broken the recovery path this state exists for.
    expect(sm.getPendingPlanExecution(SESSION_ID)?.draftInputSnapshot).toBe(DRAFT)
  })
})
