/**
 * SUV-0064 — Page callback acceptance, against the REAL SessionManager.
 *
 * The executor and RPC suites use fakes that model the primitive's contract.
 * These tests exercise the actual `sendMessage` path, because every defect this
 * file guards against lives in that method's *ordering* — which mutations
 * happen before the guard, and how much runs between the guard and the commit.
 * A fake cannot get that wrong, so a fake cannot prove it right.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getPendingPlanExecution,
  getSessionFilePath,
  setPendingPlanExecution,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const WORKSPACE_ID = 'ws_callback'
const SESSION_ID = 'sess_callback_target'
const BODY = 'Refresh the quarterly numbers.'

describe('tryDeliverPageCallback (real SessionManager)', () => {
  let root: string
  let sm: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'page-callback-accept-'))
    mkdirSync(join(root, 'statuses'), { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seed(over: Record<string, unknown> = {}) {
    const filePath = getSessionFilePath(root, SESSION_ID)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: SESSION_ID,
      workspaceRootPath: root,
      name: 'Quarterly review',
      sessionStatus: 'todo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    } as unknown as StoredSession)

    const managed = createManagedSession(
      { id: SESSION_ID, name: 'Quarterly review', sessionStatus: 'todo', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Callback WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = []
    Object.assign(managed, over)
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)
    return managed as unknown as {
      messages: Array<{ role: string; content: string }>
      isProcessing: boolean
      isArchived?: boolean
      sessionStatus?: string
      lastSentOptions?: Record<string, unknown>
    }
  }

  /**
   * Real pending-plan state, written through the storage API the product uses.
   *
   * An earlier version of this wrote an invented `*.pending-plan.json` path and
   * asserted it still existed — which proved nothing, because
   * `clearStoredPendingPlanExecution` never touches such a file. The state
   * actually lives on `pendingPlanExecution` inside the session record, so the
   * only assertion worth making reads it back through `getPendingPlanExecution`.
   */
  async function seedPendingPlan(managed: Record<string, unknown>): Promise<void> {
    await setPendingPlanExecution(root, SESSION_ID, 'plans/do-the-thing.md', 'draft text')
    // Mirror it onto the managed session as well.
    //
    // `headerToMetadata` strips `pendingPlanExecution` before
    // `createManagedSession`, and `persistSession` rebuilds the header from
    // managed state via `pickSessionFields` — so ANY persist drops a field that
    // only exists on disk. That is a pre-existing product behavior affecting
    // every writer, not something this feature introduced, and fixing it is a
    // separate change. Seeding both sides keeps this test measuring what it is
    // about — whether a callback CLEARS the plan — instead of re-measuring that
    // unrelated gap.
    managed.pendingPlanExecution = {
      planPath: 'plans/do-the-thing.md',
      draftInputSnapshot: 'draft text',
      awaitingCompaction: true,
      executionDispatched: false,
    }
    // Fail loudly here rather than let the real assertion below pass vacuously
    // against state that was never written.
    expect(getPendingPlanExecution(root, SESSION_ID)?.planPath).toBe('plans/do-the-thing.md')
  }

  it('delivers and commits the message', async () => {
    const managed = seed()
    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    expect(outcome).toMatchObject({ ok: true })
    const delivered = managed.messages.filter((m) => m.role === 'user')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.content).toBe(BODY)
  })

  it('refuses a cross-workspace target without touching the session', async () => {
    const managed = seed()
    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: 'ws_other' })

    expect(outcome).toMatchObject({ ok: false, code: 'session-not-found' })
    expect(managed.messages).toHaveLength(0)
  })

  it('refuses a busy target and leaves no message', async () => {
    const managed = seed({ isProcessing: true })
    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    expect(outcome).toMatchObject({ ok: false, code: 'session-busy' })
    expect(managed.messages).toHaveLength(0)
  })

  it('refuses an archived target and leaves no message', async () => {
    const managed = seed({ isArchived: true })
    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    expect(outcome).toMatchObject({ ok: false, code: 'session-closed' })
    expect(managed.messages).toHaveLength(0)
  })

  it('refuses when already aborted, with no message and no mutation', async () => {
    const managed = seed()
    const controller = new AbortController()
    controller.abort()

    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, {
      workspaceId: WORKSPACE_ID,
      signal: controller.signal,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'cancelled' })
    expect(managed.messages).toHaveLength(0)
  })

  /**
   * The defect this exists for: `sendMessage` clears pending plan execution
   * before it decides anything, so a callback that was about to be refused
   * still destroyed a plan the user had not answered yet.
   */
  it('never clears pending plan execution — not on refusal, not on delivery', async () => {
    for (const [state, expected] of [
      [{ isProcessing: true }, 'session-busy'],
      [{ isArchived: true }, 'session-closed'],
      [{}, null],
    ] as const) {
      root = mkdtempSync(join(tmpdir(), 'page-callback-plan-'))
      mkdirSync(join(root, 'statuses'), { recursive: true })
      sm = new SessionManager()
      const managed = seed(state as Record<string, unknown>) as unknown as Record<string, unknown>
      await seedPendingPlan(managed)

      const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })
      if (expected) expect(outcome).toMatchObject({ ok: false, code: expected })
      else expect(outcome).toMatchObject({ ok: true })

      // A page's button is not the user moving on. The plan survives on BOTH
      // paths — a refused callback obviously must not destroy it, and a
      // delivered one must not either: the user is still deciding about that
      // plan, and nothing they can see did this.
      const survived = getPendingPlanExecution(root, SESSION_ID)
      expect(survived).not.toBeNull()
      expect(survived!.planPath).toBe('plans/do-the-thing.md')
      expect(survived!.draftInputSnapshot).toBe('draft text')
    }
  })

  it('a NON-callback send still clears pending plan execution', () => {
    // The control for the test above. Without it, "the plan survived" would
    // pass just as happily if the clearing call had been deleted outright, and
    // the assertion would be about nothing. A user's own send is the caller
    // that legitimately means "I have moved on".
    const source = readFileSync(join(import.meta.dir, 'SessionManager.ts'), 'utf-8')
    expect(source).toContain('await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)')
  })

  /**
   * Two callbacks racing one idle session. `isProcessing` cannot separate them:
   * a turn does not start until well after the message is pushed, so both see
   * an idle session, both pass the guard, and both commit — two page-authored
   * messages into one session, neither aware of the other.
   */
  it('serialises concurrent callbacks to the same session', async () => {
    const managed = seed()

    const [first, second] = await Promise.all([
      sm.tryDeliverPageCallback(SESSION_ID, 'first', { workspaceId: WORKSPACE_ID }),
      sm.tryDeliverPageCallback(SESSION_ID, 'second', { workspaceId: WORKSPACE_ID }),
    ])

    const outcomes = [first, second]
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    const refused = outcomes.find((o) => !o.ok)!
    // Reported as busy, because from the loser's side that is what it is — a
    // turn is about to start — and distinguishing it would leak one page's
    // activity to another.
    expect(refused).toMatchObject({ ok: false, code: 'session-busy' })
    expect(managed.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('holds the reservation past the caller\'s answer, until the send settles', async () => {
    seed()
    const held = (sm as unknown as { pageCallbackReservations: Set<string> }).pageCallbackReservations

    // The caller is answered at durability. On a session's FIRST message
    // `sendMessage` then flushes again for title generation before
    // `setProcessing`, so a reservation released when the caller returns leaves
    // a window with `isProcessing` still false — and a second callback could
    // commit into it. The reservation must therefore outlive the answer.
    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })
    expect(outcome.ok).toBe(true)

    // Either still reserved, or already processing — never neither, which is
    // the state that admits an overlapping turn.
    const managed = (sm as unknown as { sessions: Map<string, { isProcessing: boolean }> }).sessions.get(SESSION_ID)!
    expect(held.has(SESSION_ID) || managed.isProcessing).toBe(true)
  })

  it('releases the reservation so a later callback can still be delivered', async () => {
    const managed = seed()

    await sm.tryDeliverPageCallback(SESSION_ID, 'first', { workspaceId: WORKSPACE_ID })

    // The reservation now outlives the caller's answer and is released when the
    // SEND settles, so let that settle before asserting release.
    await new Promise((r) => setTimeout(r, 50))

    // A delivery starts a turn, so the session is legitimately busy afterwards
    // — that is `session-busy` doing its job, not a leak. Clear it to isolate
    // the property under test: whether the RESERVATION was released.
    ;(managed as unknown as Record<string, unknown>).isProcessing = false

    // A reservation that leaked would make the session permanently un-callable,
    // which fails closed but is still a bug: the page's button stops working
    // with no way for the user to tell why.
    const later = await sm.tryDeliverPageCallback(SESSION_ID, 'second', { workspaceId: WORKSPACE_ID })

    expect(later).toMatchObject({ ok: true })
    expect(managed.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('releases the reservation after a REFUSED callback too', async () => {
    const managed = seed({ isArchived: true })
    await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    // The refusal path never reserved, so nothing should be held. Un-archive
    // and the next callback must work.
    ;(managed as unknown as Record<string, unknown>).isArchived = false
    await expect(sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ ok: true })
  })

  it('does not wait for the whole turn — it resolves once the message is durable', async () => {
    seed()
    // `sendMessage` does not return until the agent turn completes. If this
    // primitive waited for that, every callback would be as slow as the turn it
    // started, the broker would hold its mutating queue slot throughout, and
    // its deadline could not help — the caller would be blocked on work that
    // had already succeeded. Durability is the last thing this promises.
    const started = Date.now()
    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })
    expect(outcome.ok).toBe(true)
    // Generous bound: the assertion is "does not await a turn", not a benchmark.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('counts overlapping ordinary sends instead of sharing one flag', async () => {
    // Two user sends for one session share a key. With a Set, whichever
    // finished first deleted the shared entry while the other was still
    // pre-handoff, and a callback could commit alongside the survivor — the
    // exact overlap the announcement exists to prevent.
    const counts = (sm as unknown as { ordinarySendsInFlight: Map<string, number> }).ordinarySendsInFlight
    const announce = (sm as unknown as { announceOrdinarySend(id: string): void }).announceOrdinarySend.bind(sm)
    const withdraw = (sm as unknown as { withdrawOrdinarySend(id: string): void }).withdrawOrdinarySend.bind(sm)

    announce(SESSION_ID)
    announce(SESSION_ID)
    expect(counts.get(SESSION_ID)).toBe(2)

    withdraw(SESSION_ID)
    // One send finished; the other has not, so the session is still announced
    // and a callback must still stand down.
    expect(counts.has(SESSION_ID)).toBe(true)

    withdraw(SESSION_ID)
    expect(counts.has(SESSION_ID)).toBe(false)
    // Over-withdrawing must not go negative or resurrect an entry.
    withdraw(SESSION_ID)
    expect(counts.has(SESSION_ID)).toBe(false)
  })

  it('stands down for an announced ordinary send', async () => {
    seed()
    ;(sm as unknown as { announceOrdinarySend(id: string): void }).announceOrdinarySend(SESSION_ID)

    // A page yields to a person. The reverse never happens: nothing consults
    // this set on a user's behalf, so no user send is ever delayed by it.
    await expect(sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ ok: false, code: 'session-busy' })
  })

  it('signals commit before it resolves, and reports durability separately', async () => {
    seed()
    const events: string[] = []

    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, {
      workspaceId: WORKSPACE_ID,
      onCommitted: () => events.push('committed'),
    })

    // Commit is phase one and must have already fired by the time the caller
    // gets an answer — that ordering is what lets the broker stop treating the
    // action as cancellable before it can possibly be cancelled.
    expect(events).toEqual(['committed'])
    expect(outcome.ok).toBe(true)
    // Phase two is reported, not assumed. In this harness the flush fails (no
    // session platform), which is exactly the case worth distinguishing: the
    // message is real and live, but it is not on disk.
    expect(outcome).toHaveProperty('durable')
  })

  it('never blocks a callback to a DIFFERENT session', async () => {
    // The reservation is per session, not global: one page's in-flight callback
    // must not make every other session un-callable.
    seed()
    const otherId = 'sess_callback_other'
    const other = createManagedSession(
      { id: otherId, name: 'Other', sessionStatus: 'todo', createdAt: Date.now() },
      { id: WORKSPACE_ID, name: 'Callback WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    other.messagesLoaded = true
    other.messages = []
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(otherId, other)

    const [a, b] = await Promise.all([
      sm.tryDeliverPageCallback(SESSION_ID, 'one', { workspaceId: WORKSPACE_ID }),
      sm.tryDeliverPageCallback(otherId, 'two', { workspaceId: WORKSPACE_ID }),
    ])
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true })
  })

  it('does not retry a Page callback turn after an auth failure', async () => {
    const managed = seed() as unknown as Record<string, unknown>
    await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    // The retry path resends `lastSentMessage` verbatim after refreshing the
    // token. For a callback that would re-deliver page-authored text with NO
    // grant validation, NO activation ticket and NO consent — the entire
    // authorization chain is upstream of `sendMessage` and is not re-run.
    expect(managed.lastSentWasPageCallback).toBe(true)
    const retried = (sm as unknown as {
      attemptAuthRetry(id: string, m: unknown, ws: string): boolean
    }).attemptAuthRetry(SESSION_ID, managed, WORKSPACE_ID)
    expect(retried).toBe(false)
  })

  it('never leaves the internal delivery seam on replayable options', async () => {
    const managed = seed()
    await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    // `lastSentOptions` is replayed verbatim by the auth-retry path. A closure
    // surviving onto it would either be dropped by serialization (silently
    // disabling the guard) or re-run against a world that has moved on.
    expect(managed.lastSentOptions?.pageCallback).toBeUndefined()
    expect(JSON.stringify(managed.lastSentOptions ?? {})).not.toContain('pageCallback')
  })

  /**
   * An abort that lands after the commit must not unsay a delivered message.
   * The commit hook fires before `flushSession`, so this is the window that
   * would otherwise audit real work as a timeout.
   */
  it('reports success for an abort that lands after the commit', async () => {
    const managed = seed()
    const controller = new AbortController()

    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, {
      workspaceId: WORKSPACE_ID,
      signal: controller.signal,
    })
    controller.abort()

    expect(outcome).toMatchObject({ ok: true })
    expect(managed.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  /**
   * The adjacency itself, pinned against the source.
   *
   * Every behavioral test above passes just as happily with an `await` inserted
   * between the guard and the push — the window it opens is a race, and races
   * do not fail deterministically. So the structural property is asserted
   * directly: whatever else changes in `sendMessage`, nothing may yield between
   * the veto and the commit.
   */
  it('has no await between the delivery guard and the message commit', () => {
    const source = readFileSync(join(import.meta.dir, 'SessionManager.ts'), 'utf-8')

    const guardAt = source.indexOf('const vetoed = pageCallback?.guard()')
    const commitAt = source.indexOf('pageCallback?.markCommitted()')
    expect(guardAt).toBeGreaterThan(-1)
    expect(commitAt).toBeGreaterThan(guardAt)

    // The mid-stream branch sits between the two textually but is unreachable
    // for a callback: the guard refuses `session-busy`, so `isProcessing` is
    // false by the time control gets here. Excising it by brace-matching keeps
    // the assertion about the path a callback ACTUALLY takes — and keeps it
    // honest, because a slice that quietly ignored a reachable branch would
    // pass while the window was wide open.
    const branchAt = source.indexOf('if (managed.isProcessing) {', guardAt)
    expect(branchAt).toBeGreaterThan(guardAt)
    expect(branchAt).toBeLessThan(commitAt)

    let depth = 0
    let branchEnd = -1
    for (let i = source.indexOf('{', branchAt); i < commitAt; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) { branchEnd = i + 1; break }
      }
    }
    expect(branchEnd).toBeGreaterThan(branchAt)

    const reachable = source.slice(guardAt, branchAt) + source.slice(branchEnd, commitAt)
    // Comments discuss awaits by name; strip them before looking for real ones.
    const code = reachable
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')

    expect(code).not.toMatch(/\bawait\b/)
    expect(code).not.toMatch(/\byield\b/)

    // And the branch really is unreachable for a callback, which is the premise
    // the excision rests on: the guard refuses busy before control gets here.
    const guards = readFileSync(join(import.meta.dir, 'page-callback-guards.ts'), 'utf-8')
    expect(guards).toContain("if (target.isProcessing) return 'session-busy'")
  })

  /**
   * The same property on the other side of the guard: for the callback path,
   * nothing may mutate session state before the veto runs.
   */
  it('performs no state mutation before the delivery guard on the callback path', () => {
    const source = readFileSync(join(import.meta.dir, 'SessionManager.ts'), 'utf-8')
    const sendAt = source.indexOf('  private async sendMessageInner(')
    const guardAt = source.indexOf('const vetoed = pageCallback?.guard()')
    expect(sendAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(sendAt)

    const preamble = source.slice(sendAt, guardAt)

    // Brace-match the `if (!pageCallback)` block, the same way the adjacency
    // test matches the mid-stream branch. A `lastIndexOf` search would only
    // prove the branch opens somewhere earlier in the file — it would keep
    // passing with every mutation moved out after the closing brace, which is
    // exactly the regression this is meant to catch.
    const branchAt = preamble.indexOf('if (!pageCallback) {')
    expect(branchAt).toBeGreaterThan(-1)

    let depth = 0
    let branchEnd = -1
    for (let i = preamble.indexOf('{', branchAt); i < preamble.length; i++) {
      if (preamble[i] === '{') depth++
      else if (preamble[i] === '}') {
        depth--
        if (depth === 0) { branchEnd = i + 1; break }
      }
    }
    expect(branchEnd).toBeGreaterThan(branchAt)

    const insideBranch = preamble.slice(branchAt, branchEnd)
    const outsideBranch = preamble.slice(0, branchAt) + preamble.slice(branchEnd)

    // Each of these mutates: pins the browser host, claims the retry slot, or
    // deletes a stored plan. All three must sit INSIDE the non-callback branch
    // and nowhere else before the guard.
    for (const mutation of [
      'this.setLastMessageClientId(',
      'claimAutoRetryPending(',
      'clearStoredPendingPlanExecution(',
    ]) {
      expect(insideBranch).toContain(mutation)
      expect(outsideBranch).not.toContain(mutation)
    }

    // And the callback path's one permitted await really is the only one.
    const callbackReachable = outsideBranch
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(callbackReachable.match(/\bawait\b/g) ?? []).toHaveLength(1)
    expect(callbackReachable).toContain('await this.ensureMessagesLoaded(managed)')
  })
})
