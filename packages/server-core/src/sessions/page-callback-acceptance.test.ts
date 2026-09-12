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
import { listSessions } from '@craft-agent/shared/sessions'
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
  /**
   * Real pending-plan state, written through the storage API the product uses
   * and left ONLY where the product leaves it — on the stored record.
   *
   * An earlier version also mirrored it onto the managed session. That state is
   * impossible: `headerToMetadata` strips `pendingPlanExecution` before
   * `createManagedSession`, so no managed session in the product ever carries
   * it, and a test that invents one is validating fiction. The hydration at the
   * callback's commit is what has to make the write preserve it.
   */
  async function seedPendingPlan(): Promise<void> {
    await setPendingPlanExecution(root, SESSION_ID, 'plans/do-the-thing.md', 'draft text')
    // Fail loudly here rather than let the real assertion below pass vacuously
    // against state that was never written.
    expect(getPendingPlanExecution(root, SESSION_ID)?.planPath).toBe('plans/do-the-thing.md')
  }

  /**
   * Replace the managed session with one built from real `listSessions`
   * metadata — the startup path. If `headerToMetadata` strips a field, it is
   * missing here, which is the whole point.
   */
  function hydrateFromDisk(): Record<string, unknown> {
    const meta = listSessions(root).find((m) => m.id === SESSION_ID)!
    expect(meta).toBeDefined()
    const managed = createManagedSession(
      meta as never,
      { id: WORKSPACE_ID, name: 'Callback WS', rootPath: root, createdAt: Date.now() } as never,
    ) as unknown as Record<string, unknown>
    managed.messagesLoaded = true
    managed.messages = []
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(SESSION_ID, managed)
    return managed
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
   * The defect this exists for: `sendMessage` cleared pending plan execution
   * before it decided anything, so a callback about to be REFUSED still
   * destroyed a plan the user had not answered.
   *
   * Getting real coverage of it is fiddly, and an earlier version of this test
   * did not have any. It seeded a plan, called with an already-busy session,
   * and asserted survival — but `tryDeliverPageCallback` early-outs on that
   * state and never enters `sendMessage` at all, so the clearing code was never
   * reached. The delivery case was masked differently: `persistSession` writes
   * managed state back, restoring the field even when the clear had run. Both
   * passed with the defect injected.
   *
   * So this drives a refusal at the GUARD — inside `sendMessage`, past the
   * point the clear would have executed — by making the session read idle at
   * the synchronous early-out and busy at the guard.
   */
  it('never clears pending plan execution when the guard refuses inside sendMessage', async () => {
    const managed = seed() as unknown as Record<string, unknown>
    await seedPendingPlan()

    // Make the session read idle at the synchronous early-out and busy at the
    // guard. That is precisely the state change the guard exists to catch, and
    // modelling it with an accessor is deterministic — a timer cannot be made
    // to land inside `ensureMessagesLoaded`, whose only await here is a
    // microtask.
    let reads = 0
    Object.defineProperty(managed, 'isProcessing', {
      configurable: true,
      get() { reads += 1; return reads > 1 },
    })

    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    // Refused INSIDE `sendMessage`, past the point the clearing code sits in
    // the preamble — which is what makes the assertion below meaningful.
    expect(reads).toBeGreaterThan(1)
    expect(outcome).toMatchObject({ ok: false, code: 'session-busy' })

    // A page's button is not the user moving on: the plan the user has not
    // answered survives a callback that was refused on its way through.
    const survived = getPendingPlanExecution(root, SESSION_ID)
    expect(survived).not.toBeNull()
    expect(survived!.planPath).toBe('plans/do-the-thing.md')
    expect(survived!.draftInputSnapshot).toBe('draft text')
  })

  /**
   * The delivery path, from the representation the product actually produces.
   *
   * This previously had no honest assertion available: `persistSession`
   * rebuilds the header from managed state, and `headerToMetadata` strips
   * `pendingPlanExecution` on the way in, so a delivered callback's write
   * destroyed a plan the user had not answered — not by clearing it, but by
   * writing a record that had never heard of it. Mirroring the field onto
   * managed made the old test pass by inventing a state the product cannot
   * reach. The fix hydrates it at the commit instead, so the assertion below is
   * about real behaviour.
   */
  it('preserves a pending plan across a callback turn and its later persists', async () => {
    seed()
    await seedPendingPlan()
    // Rebuild the managed session the way STARTUP does — from `listSessions`
    // metadata — so the mirror has to survive `headerToMetadata` rather than
    // being handed to it. Setting the field directly would bypass the very
    // projection that used to drop it.
    const managed = hydrateFromDisk()

    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })
    expect(outcome).toMatchObject({ ok: true })
    expect(getPendingPlanExecution(root, SESSION_ID)).not.toBeNull()

    // A callback turn writes more than once — title, labels, SDK id, token
    // usage. Every one of those rebuilds the header from managed state, so a
    // mirror that only survived the FIRST write would still lose the plan.
    ;(managed as unknown as { name: string }).name = 'a generated title'
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)
    ;(managed as unknown as { labels: string[] }).labels = ['triage']
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    const survived = getPendingPlanExecution(root, SESSION_ID)
    expect(survived).not.toBeNull()
    expect(survived!.planPath).toBe('plans/do-the-thing.md')
    expect(survived!.draftInputSnapshot).toBe('draft text')
  })

  it('keeps the mirror in step when compaction completes', async () => {
    seed()
    await seedPendingPlan()
    const managed = hydrateFromDisk()
    expect((managed.pendingPlanExecution as { awaitingCompaction: boolean }).awaitingCompaction).toBe(true)

    await sm.markCompactionComplete(SESSION_ID)

    // Every owner of this state updates disk and mirror together. A stale
    // mirror here would have a later persist write `awaitingCompaction: true`
    // back — un-completing a compaction that had finished, and sending reload
    // recovery back to waiting for something that already happened.
    expect((managed.pendingPlanExecution as { awaitingCompaction: boolean }).awaitingCompaction).toBe(false)

    ;(managed as unknown as { name: string }).name = 'later write'
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    expect(getPendingPlanExecution(root, SESSION_ID)?.awaitingCompaction).toBe(false)
  })

  it('keeps a dismissed plan absent across later persists', async () => {
    seed()
    await seedPendingPlan()
    const managed = hydrateFromDisk()

    // The user dismisses it through the owning API, which must clear BOTH — or
    // the next persist writes the dismissed plan straight back and offers to
    // resume work the user already moved past.
    await sm.clearPendingPlanExecution(SESSION_ID)
    expect(getPendingPlanExecution(root, SESSION_ID)).toBeNull()
    expect(managed.pendingPlanExecution).toBeUndefined()

    ;(managed as unknown as { name: string }).name = 'later write'
    ;(sm as unknown as { persistSession(m: unknown): void }).persistSession(managed)
    await sm.flushSession(SESSION_ID)

    expect(getPendingPlanExecution(root, SESSION_ID)).toBeNull()
  })

  it('reports durable:false when the write fails, and never claims otherwise', async () => {
    seed()

    // The queue catches its own write errors, so an unchecked flush resolves
    // just as happily after a failed write. Without the checked receipt the
    // page would be told its message was saved while the disk said otherwise.
    const original = (sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked
    ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = async () => ({
      ok: false, error: 'ENOSPC: no space left on device',
    })

    try {
      const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })
      // Delivered — the message is really in the transcript — but explicitly
      // not durable. Both halves matter: claiming failure would be as wrong as
      // claiming durability.
      expect(outcome).toMatchObject({ ok: true, durable: false })
    } finally {
      ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = original
    }
  })

  it('reports durable:true only when the write really succeeded', async () => {
    seed()
    const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })

    expect(outcome).toMatchObject({ ok: true, durable: true })
    // And the message is genuinely on disk, not merely reported as such.
    const reloaded = readFileSync(getSessionFilePath(root, SESSION_ID), 'utf-8')
    expect(reloaded).toContain(BODY)
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

  it('keeps refusing until every overlapping announcement is withdrawn', async () => {
    seed()
    const announce = (sm as unknown as { announceOrdinarySend(id: string): void }).announceOrdinarySend.bind(sm)
    const withdraw = (sm as unknown as { withdrawOrdinarySend(id: string): void }).withdrawOrdinarySend.bind(sm)

    // Two user sends outstanding. One finishing must not clear the
    // announcement for the other — with a flag it did, and a callback then
    // committed alongside the survivor.
    announce(SESSION_ID)
    announce(SESSION_ID)
    withdraw(SESSION_ID)

    await expect(sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ ok: false, code: 'session-busy' })

    // Only when the second withdraws is the session free for a callback.
    withdraw(SESSION_ID)
    await expect(sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ ok: true })
  })

  it('clears the accepted-turn marker when the send throws BEFORE the handover', async () => {
    const managed = seed() as unknown as Record<string, unknown>

    // Inject the throw where it actually matters: between the commit and the
    // `isProcessing` handover. The harness's own failure happens *after* the
    // handover, which already clears the marker — so using it would prove
    // nothing. `flushSession` sits squarely in the window.
    const original = (sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked
    ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = async () => {
      throw new Error('disk gone')
    }

    try {
      const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })
      // Committed, but never flushed — so delivered and explicitly not durable.
      expect(outcome).toMatchObject({ ok: true, durable: false })
    } finally {
      ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = original
    }
    await new Promise((r) => setTimeout(r, 50))

    // A marker left set with `isProcessing` false is the worst residue
    // available: every later user message queues behind a turn that will never
    // start, and the session goes quiet with no error the user can see.
    expect(managed.pageCallbackTurnPendingToken).toBeUndefined()
  })

  /**
   * User priority is a rule about WHEN, not a blanket precedence.
   *
   * Before a callback commits, the user wins and the callback stands down.
   * After it commits there is an accepted turn to be behind, so the user's
   * message queues rather than committing alongside it — otherwise two turns
   * start in one session.
   */
  it('queues a real user send that interleaves after a callback has committed', async () => {
    const managed = seed() as unknown as Record<string, unknown> & {
      messages: Array<{ role: string; content: string }>
      messageQueue: Array<{ message: string }>
      pageCallbackTurnPendingToken?: symbol
    }

    // Hold the callback inside its flush so the interleaving is real: the
    // callback has committed, its turn has not started, and the user send
    // arrives in exactly that window. Setting the marker by hand and then
    // sending would prove nothing about the ordering the product produces.
    let releaseFlush!: () => void
    const flushing = new Promise<void>((resolve) => { releaseFlush = resolve })
    const original = (sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked
    ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = async () => {
      await flushing
      return { ok: true as const }
    }

    const callback = sm.tryDeliverPageCallback(SESSION_ID, 'from the page', { workspaceId: WORKSPACE_ID })

    // Wait for the real commit — the marker is set at the push, before the flush.
    for (let i = 0; i < 50 && managed.pageCallbackTurnPendingToken === undefined; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(managed.pageCallbackTurnPendingToken).toBeDefined()
    expect(managed.isProcessing).toBe(false)

    // A genuine user send, in the gap, through the ordinary path.
    const userSend = sm.sendMessage(SESSION_ID, 'from the user').catch(() => {})

    // Let it get past its own preamble awaits and reach the branch decision
    // WHILE the flush is still held. Releasing first would let the callback's
    // turn start, and the send would then queue on `isProcessing` — passing
    // this test without the marker ever being consulted.
    await new Promise((r) => setTimeout(r, 30))
    expect(managed.isProcessing).toBe(false)

    releaseFlush()
    await callback
    await userSend
    ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = original

    // The user is never dropped — both messages exist — but the user's is
    // queued behind the accepted turn rather than committing alongside it.
    const users = managed.messages.filter((m) => m.role === 'user')
    expect(users.map((m) => m.content)).toContain('from the page')
    expect(users.map((m) => m.content)).toContain('from the user')
    // Specifically THAT message queued — a length check would pass on anything
    // happening to be in the queue, including the callback's own turn.
    expect(managed.messageQueue.map((e) => e.message)).toContain('from the user')
  })

  it('a stale reservation owner cannot release its successor', () => {
    const reserve = (sm as unknown as { reservePageCallback(id: string, t: symbol): symbol }).reservePageCallback.bind(sm)
    const release = (sm as unknown as { releasePageCallback(id: string, t: symbol): void }).releasePageCallback.bind(sm)
    const held = (sm as unknown as { pageCallbackReservations: Map<string, symbol> }).pageCallbackReservations

    const first = Symbol('A')
    const second = Symbol('B')
    reserve(SESSION_ID, first)
    // B takes over while A is still settling — A's deferred release must not
    // clear it, or the next send sees an idle session and commits alongside B.
    reserve(SESSION_ID, second)

    release(SESSION_ID, first)
    expect(held.get(SESSION_ID)).toBe(second)

    release(SESSION_ID, second)
    expect(held.has(SESSION_ID)).toBe(false)
  })

  it('resolves promptly with durable:false rather than waiting out the turn', async () => {
    seed()
    const original = (sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked
    ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = async () => ({
      ok: false, error: 'ENOSPC: no space left on device',
    })

    // Make everything AFTER the receipt slow, so "resolved at the receipt" and
    // "resolved when the send settled" are distinguishable rather than both
    // being instant in this harness. It has to be an ASYNC hold: a synchronous
    // spin blocks the event loop, so the already-resolved promise could not run
    // either way and the measurement would prove nothing.
    const smAny = sm as unknown as { getOrCreateAgent(...a: unknown[]): Promise<unknown> }
    const originalGetAgent = smAny.getOrCreateAgent.bind(sm)
    smAny.getOrCreateAgent = async () => {
      await new Promise((r) => setTimeout(r, 300))
      throw new Error('no agent in this harness')
    }

    try {
      const started = Date.now()
      const outcome = await sm.tryDeliverPageCallback(SESSION_ID, BODY, { workspaceId: WORKSPACE_ID })
      // A write failure is an answer, and it has to come back at the moment it
      // is known. Resolving only on success left the caller to discover a disk
      // error by timing out, which makes it look like a slow turn — and lets
      // the broker's deadline record a timeout over a delivered message.
      expect(outcome).toMatchObject({ ok: true, durable: false })
      expect(Date.now() - started).toBeLessThan(250)
    } finally {
      smAny.getOrCreateAgent = originalGetAgent
      ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = original
    }
  })

  it('queues a user send without claiming an interruption that never happened', async () => {
    const managed = seed() as unknown as Record<string, unknown> & {
      messageQueue: Array<{ message: string }>
      wasInterrupted?: boolean
      pageCallbackTurnPendingToken?: symbol
    }

    let releaseFlush!: () => void
    const flushing = new Promise<void>((resolve) => { releaseFlush = resolve })
    const original = (sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked
    ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = async () => {
      await flushing
      return { ok: true as const }
    }

    const callback = sm.tryDeliverPageCallback(SESSION_ID, 'from the page', { workspaceId: WORKSPACE_ID })
    for (let i = 0; i < 50 && managed.pageCallbackTurnPendingToken === undefined; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const userSend = sm.sendMessage(SESSION_ID, 'from the user').catch(() => {})
    await new Promise((r) => setTimeout(r, 30))

    releaseFlush()
    await callback
    await userSend
    ;(sm as unknown as { flushSessionChecked: unknown }).flushSessionChecked = original

    expect(managed.messageQueue.map((e) => e.message)).toContain('from the user')
    // No turn was running, so nothing was interrupted. Claiming otherwise makes
    // the replayed turn inject "your previous response was interrupted" in
    // front of a turn that had not started.
    expect(managed.wasInterrupted).toBeFalsy()
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
    const commitAt = source.indexOf('pageCallback.markCommitted()')
    expect(guardAt).toBeGreaterThan(-1)
    expect(commitAt).toBeGreaterThan(guardAt)

    // The mid-stream branch sits between the two textually but is unreachable
    // for a callback: the guard refuses `session-busy`, so `isProcessing` is
    // false by the time control gets here. Excising it by brace-matching keeps
    // the assertion about the path a callback ACTUALLY takes — and keeps it
    // honest, because a slice that quietly ignored a reachable branch would
    // pass while the window was wide open.
    const branchAt = source.indexOf('if (managed.isProcessing || managed.pageCallbackTurnPending', guardAt)
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
