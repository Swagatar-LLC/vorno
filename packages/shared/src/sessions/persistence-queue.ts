import { writeFile, rename, unlink } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
  /** Monotonic per session. A receipt is satisfied by this generation or later. */
  generation: number
}

/** A caller waiting to learn whether its snapshot reached disk. */
interface ReceiptWaiter {
  generation: number
  settle: (receipt: SessionWriteReceipt) => void
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataFields(header: SessionHeader): HeaderMetadataSignature {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return signature
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  return JSON.stringify(getHeaderMetadataFields(header))
}

/**
 * The seven metadata fields an external writer and this process both own.
 *
 * Named once so the merge, the signature, and the observation cannot drift out
 * of agreement about which fields are in play.
 */
const EXTERNAL_METADATA_FIELDS = [
  'name',
  'labels',
  'isFlagged',
  'sessionStatus',
  'permissionMode',
  'hasUnread',
  'lastReadMessageId',
] as const satisfies readonly (keyof HeaderMetadataSignature)[]

/**
 * Decide every externally-owned metadata field, in one place.
 *
 * Three sources can have an opinion, and the ranking is applied PER FIELD
 * because authority is per field. Asking "did disk diverge at all" and, if so,
 * taking every field from disk discards a retained observation that is the only
 * surviving copy of a *different* field, just because some unrelated field had
 * changed on disk since.
 *
 * For each field, in order:
 *
 * 1. **The app**, if it moved the field since the observation was taken. A held
 *    observation is a memory, and a memory must not beat an edit the user made
 *    afterwards — otherwise the session renames itself back a beat after they
 *    renamed it.
 * 2. **Disk**, if disk's value for *this* field differs from what we last wrote.
 *    That is an external writer changing this field, it is happening now, and it
 *    outranks anything remembered.
 * 3. **The observation**, if it holds this field. Disk showing our own value
 *    here is exactly the case the observation exists for: a stale write already
 *    committed over the edit, so the memory is the only copy left.
 * 4. **Local**, unchanged — nobody external has an opinion.
 *
 * With no observation, rule 1 never fires and the result is the long-standing
 * "preserve what an external writer changed, keep our own updates otherwise"
 * behaviour, now decided field by field rather than wholesale.
 */
function resolveExternalMetadata({
  local,
  disk,
  observation,
  lastWritten,
}: {
  local: SessionHeader
  disk?: SessionHeader
  observation?: ExternalObservation
  lastWritten?: HeaderMetadataSignature
}): SessionHeader {
  if (!disk && !observation) return local

  const outgoing = getHeaderMetadataFields(local)
  const baseline = observation?.localAtObservation
  const diskFields = disk ? getHeaderMetadataFields(disk) : undefined
  const resolved: SessionHeader = { ...local }
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

  for (const field of EXTERNAL_METADATA_FIELDS) {
    // 1. The app moved it since we looked — it wins over both other sources.
    if (baseline !== undefined && !same(outgoing[field], baseline[field])) continue

    // 2. Disk changed THIS field since our last write.
    if (diskFields && lastWritten !== undefined && !same(diskFields[field], lastWritten[field])) {
      ;(resolved as unknown as Record<string, unknown>)[field] = diskFields[field]
      continue
    }

    // 3. The observation is the surviving copy of this field.
    if (observation) {
      ;(resolved as unknown as Record<string, unknown>)[field] = observation.external[field]
      continue
    }

    // 4. Disk with no baseline to compare against: fall back to preserving it
    // wholesale, which is what this queue did before per-field comparison was
    // possible. Reachable only when we have never written this session.
    if (diskFields && lastWritten === undefined) {
      ;(resolved as unknown as Record<string, unknown>)[field] = diskFields[field]
    }
  }
  return resolved
}

/**
 * How far cancellation reaches, and how far it is allowed to go.
 *
 * `discardCommitted` is the difference between the two callers of this
 * mechanism, and conflating them destroys live data:
 *
 * - **Deletion** (`cancelForDeletion`) must remove the artifact even if the
 *   rename already committed, or a deleted session reappears on disk.
 * - **Supersede** (`supersedePendingWrites`) must NEVER remove it. Its caller
 *   is reacting to an external metadata edit and is about to write merged fresh
 *   state; unlinking there deletes a live session's file, and leaves it absent
 *   until the replacement write lands.
 *
 * Sticky by design: once a session is being deleted, a later supersede cannot
 * downgrade the intent back to "keep the file", because nothing un-deletes a
 * session. `through` is likewise monotonic. Both directions of ordering are
 * therefore safe without the callers having to know about each other.
 */
type CancellationWatermark = { through: number; discardCommitted: boolean }

/**
 * The identity every piece of this queue's per-session state is filed under.
 *
 * **A bare session id is not unique.** Ids are minted per workspace, and a
 * copied or restored workspace keeps the ids it came with, so two live
 * workspaces can hold the same id. Every map here used to be keyed by that id
 * alone, which made two different sessions one entry: workspace A's deletion
 * raised the watermark on workspace B's in-flight write and — because deletion
 * carries `discardCommitted` — unlinked B's committed file. A live session's
 * transcript, deleted by an unrelated workspace.
 *
 * A JSON tuple rather than the session's file path, deliberately. The path
 * looks canonical and is not injective: `getSessionFilePath` interpolates the
 * id into the path, so a root of `/w` with id `a/sessions/b` and a root of
 * `/w/sessions/a` with id `b` produce the same string. A tuple cannot alias,
 * because JSON escaping keeps the two components separable.
 *
 * The root is `resolve`d first so that `/w`, `/w/`, and `/w/x/..` are one key
 * rather than three writers racing over one file — the opposite failure from
 * the one above, and just as real.
 *
 * Branded so the compiler rejects a bare `sessionId` at every call site. When
 * this was introduced it found all of them; that is the only reason to believe
 * none were missed. Note that `packages/shared/tests/` is outside the
 * typechecked `src/` and the brand does **not** reach it.
 */
export type SessionWriteKey = string & { readonly __sessionWriteKey: unique symbol }

/** Build the canonical, injective key for a session's persistence state. */
export function sessionWriteKey(workspaceRootPath: string, sessionId: string): SessionWriteKey {
  return JSON.stringify([resolve(workspaceRootPath), sessionId]) as SessionWriteKey
}

/**
 * What an external writer was seen to have, and what WE had at that moment.
 *
 * The second half is what makes the observation safe to hold. Applying a
 * remembered external value unconditionally would let it win over an in-app
 * change made *after* the observation — the user renames a session a moment
 * after a watcher event, and the older remote name silently reappears. Keeping
 * the local value as it stood at observation time turns that into an answerable
 * question, per field: if the outgoing value still matches what we had when we
 * looked, nothing local has happened and the external value applies; if it has
 * moved, the app changed it since and the app wins.
 *
 * `localAtObservation` is undefined when this process has never written the
 * session, in which case there is no evidence of a local change and the
 * external value applies.
 */
type ExternalObservation = {
  external: HeaderMetadataSignature
  localAtObservation?: HeaderMetadataSignature
  observedAt: number
}

/**
 * How long an unlanded observation is honoured.
 *
 * It is cleared by the write that commits it, but a session that is never
 * written again would otherwise hold one for the life of the process. The bound
 * is time rather than count because the risk is staleness, not volume: beyond
 * this the on-disk state has long since settled and re-reading it is the better
 * answer. Generous on purpose — the window it exists to cover is milliseconds.
 */
const OBSERVATION_MAX_AGE_MS = 5 * 60_000

/** Outcome of a checked persist. `ok:false` carries the reason for the audit. */
export type SessionWriteReceipt = { ok: true } | { ok: false; error: string }

/**
 * A claim on one specific enqueued snapshot.
 *
 * The generation is the point. A parameterless "is the latest write done yet"
 * cannot be answered truthfully once bookkeeping has been retired — it has to
 * reconstruct which generation the caller meant, and after a cancel there is
 * nothing left to reconstruct from, so it guesses optimistically. Holding a
 * handle removes the guess: the caller asks about the write it actually made.
 */
export interface SessionWriteHandle {
  /**
   * The state this write belongs to. Retained so a holder can drive or flush
   * its own write without reconstructing the key — and without the chance of
   * reconstructing a DIFFERENT one.
   */
  key: SessionWriteKey
  generation: number
  receipt: Promise<SessionWriteReceipt>
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<SessionWriteKey, PendingWrite>()
  /**
   * Per-session write tail. EVERY write — debounced, flushed, or checked —
   * chains onto it, so two writes for one session can never be in flight at
   * once.
   *
   * They share a single `.tmp` path, so concurrency there is not a fairness
   * question but a correctness one: interleaved writers can rename a partially
   * written temp file over a good session, and the loser's bytes vanish with no
   * error anywhere. Serialising is what makes "the newest enqueued state wins"
   * true rather than probable.
   */
  private tails = new Map<SessionWriteKey, Promise<void>>()
  /** Highest generation enqueued per session. */
  private generations = new Map<SessionWriteKey, number>()
  /** Highest generation successfully written per session. */
  private writtenGeneration = new Map<SessionWriteKey, number>()
  private receiptWaiters = new Map<SessionWriteKey, ReceiptWaiter[]>()
  /**
   * Highest generation cancelled per session — a watermark, not a flag.
   *
   * Cancelling drops the PENDING entry, but a write already on the tail is past
   * that point: it can finish and rename its temp file over a session the
   * caller has deleted, recreating state that was meant to be gone.
   *
   * A boolean cannot express this correctly, and the reason is worth recording.
   * A flag has to be cleared by `enqueue`, or a cancel mutes the session
   * forever — but clearing it lets a re-enqueue UN-cancel a write already in
   * flight: the stale write reaches its pre-commit check, sees the flag cleared
   * by the newer enqueue, and commits over it.
   *
   * A watermark is immune to that. Cancellation attaches to the generations
   * that existed when it was called, so a later enqueue is simply a higher
   * generation and is unaffected, with nothing to clear and no window in which
   * clearing it is wrong. Generations therefore stay monotonic for the life of
   * the process and are never reset.
   *
   * It carries an INTENT as well as a generation, because "stop these writes"
   * has two meanings and only one of them may remove the session's file. See
   * `CancellationWatermark`.
   */
  private cancelledThrough = new Map<SessionWriteKey, CancellationWatermark>()
  /**
   * Test seam: awaited at each commit boundary so a suite can land a cancel
   * inside a write deterministically.
   *
   * Real filesystem writes take measurable time and a cancel genuinely can
   * arrive mid-commit, but an in-memory test's writes settle far too fast to
   * hit those windows by timing. Without a seam the guards above would be
   * untestable — and an untested guard is one nobody can tell is still working.
   * Unset in production, where it costs one optional-chain per boundary.
   *
   * **It is a public mutable field on a module singleton, which is a real if
   * small hazard, and the alternatives were worse.** Anything in-process can set
   * it, and because the hooks are awaited, a hostile or buggy one can stall
   * every session write. It has no wire representation and nothing serialises to
   * it, so the exposure is to code already running in the host, which can call
   * `unlink` directly anyway. Constructor injection was rejected because the
   * singleton is constructed at module scope before any test can reach it; a
   * subclass was rejected because the guards must be exercised on the exact
   * instance the product uses. Suites that set it MUST clear it in `afterEach` —
   * a leaked hook fires inside every later suite's writes. Tightening this to a
   * build-stripped seam is a recorded residual on SUV-0066, not a silent
   * acceptance.
   */
  commitHooks?: {
    beforeUnlink?: (key: SessionWriteKey) => void | Promise<void>
    beforeRename?: (key: SessionWriteKey) => void | Promise<void>
    afterRename?: (key: SessionWriteKey) => void | Promise<void>
  }
  /**
   * Last write failure per session, cleared on the next success.
   *
   * `write` deliberately swallows its errors so the fire-and-forget callers
   * that make up almost all of this queue's traffic keep working — but that
   * also meant `flush` resolved happily after a failed write, and a caller who
   * needed to *know* had no way to ask. This is how they ask.
   */
  private lastWriteFailure = new Map<SessionWriteKey, string>()
  private lastWrittenHeaderSignature = new Map<SessionWriteKey, string>()
  /**
   * The same thing as `lastWrittenHeaderSignature`, kept as fields rather than
   * a string, because an observation has to ask per-field questions the
   * signature can only answer as a whole. Written and cleared together with it.
   */
  private lastWrittenMetadata = new Map<SessionWriteKey, HeaderMetadataSignature>()
  /**
   * Metadata an external writer was OBSERVED to have, held until a write lands
   * it.
   *
   * Recovering an external edit by re-reading disk is not sound, because disk is
   * exactly what can be lost: a write that read its header before the edge and
   * renames after the watcher saw it commits a pre-edit snapshot over the edit,
   * and — since supersede correctly keeps that file — the baseline then equals
   * the stale file's own signature, so the next write detects no divergence at
   * all. The edit at that point exists only in what the watcher read.
   *
   * So the observation travels with `supersedePendingWrites` instead of being
   * re-derived. Cleared only when a write actually commits it; an abandoned
   * write must not consume it.
   */
  private pendingExternalMetadata = new Map<SessionWriteKey, ExternalObservation>()
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): number {
    const key = sessionWriteKey(session.workspaceRootPath, session.id)
    const existing = this.pending.get(key)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)

    const timer = setTimeout(() => {
      // Onto the tail like every other write, so the debounced path cannot race
      // a flush for the same `.tmp`.
      void this.runOnTail(key)
    }, this.debounceMs)

    this.pending.set(key, { data: session, timer, generation })
    return generation
  }

  /**
   * Enqueue and hand back a receipt for THIS snapshot.
   *
   * `flush` cannot report durability: `write` catches its own errors so the
   * fire-and-forget callers that make up nearly all of this queue's traffic
   * keep working, which leaves a failed write indistinguishable from a
   * successful one to anyone awaiting it. A caller that tells a user
   * "delivered and saved" needs the difference, and guessing optimistically is
   * the one answer it must never give.
   *
   * The receipt is tied to a GENERATION, not to a moment. A later write
   * satisfies it — a newer snapshot contains this one — while an older write
   * completing does not, so the answer cannot be borrowed from somebody else's
   * success, and a caller waits on its own bytes rather than on whatever
   * happened to be in the queue.
   *
   * Deliberately additive: `flush` and `enqueue` are untouched and every
   * existing caller keeps its best-effort behaviour.
   */
  enqueueChecked(session: StoredSession): SessionWriteHandle {
    const key = sessionWriteKey(session.workspaceRootPath, session.id)
    const generation = this.enqueue(session)
    return { key, generation, receipt: this.receiptFor(key, generation) }
  }

  /** Resolve once `generation` (or later) has been written, or has failed. */
  private receiptFor(key: SessionWriteKey, generation: number): Promise<SessionWriteReceipt> {
    // Cancelled generations are TERMINAL and answer immediately, rather than
    // parking a waiter that nothing would settle: `write` returns early when
    // there is no pending entry, which is exactly the state a cancel leaves
    // behind.
    //
    // Unreachable through the public API today, and deliberately kept anyway —
    // same standing as the backstop twenty lines below. What makes it
    // unreachable is arithmetic in a different method: `enqueue` mints
    // `generations.get(key) + 1` and the cancel path sets the watermark to
    // `generations.get(key)`, so a freshly minted generation is always strictly
    // above it. No black-box test can reach this branch, and none pretends to;
    // it is here because the invariant — never report success for a cancelled
    // generation — should survive someone changing that arithmetic.
    if ((this.cancelledThrough.get(key)?.through ?? 0) >= generation) {
      return Promise.resolve({ ok: false, error: 'session write cancelled' })
    }
    const written = this.writtenGeneration.get(key) ?? 0
    if (written >= generation) {
      const prior = this.lastWriteFailure.get(key)
      return Promise.resolve(prior ? { ok: false, error: prior } : { ok: true })
    }

    // A waiter is only ever registered for work that something will finish.
    //
    // With nothing pending and no tail running, this generation's snapshot is
    // gone — `write` returns early when there is no pending entry, and does so
    // without settling anything, so a waiter parked here would never be
    // answered by anybody. That is not a slow reply; it is a caller stuck for
    // the life of the process.
    //
    // A structural backstop rather than a live path: the public API cannot
    // currently reach this state (a cancel is caught by the watermark check
    // above, and every other route leaves either a pending entry or a tail).
    // It is here because the cost of being wrong is a permanent hang, and the
    // invariant — never park on work nothing will finish — should hold by
    // construction rather than by audit of the callers.
    if (!this.pending.has(key) && !this.tails.has(key)) {
      const prior = this.lastWriteFailure.get(key)
      return Promise.resolve(
        prior ? { ok: false, error: prior } : { ok: false, error: 'session write cancelled' },
      )
    }

    return new Promise<SessionWriteReceipt>((settle) => {
      const waiters = this.receiptWaiters.get(key) ?? []
      waiters.push({ generation, settle })
      this.receiptWaiters.set(key, waiters)
    })
  }

  /**
   * Run the pending write for a session on its serialised tail.
   *
   * Chained with `.then(fn, fn)` so one failed write does not strand every
   * later write for that session behind a rejected promise.
   */
  private runOnTail(key: SessionWriteKey): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(
      () => this.write(key).then(() => undefined),
      () => this.write(key).then(() => undefined),
    )
    this.tails.set(key, next)
    void next.finally(() => {
      // Only if still ours: a later write may already own the tail.
      if (this.tails.get(key) === next) {
        this.tails.delete(key)
        this.retireIfQuiescent(key)
      }
    })
    return next
  }

  /**
   * Drop a session's bookkeeping once nothing can still refer to it.
   *
   * These maps are keyed per session and would otherwise grow for the life of
   * the process — one entry per session ever written, including every deleted
   * one. Retirement is only safe when the tail has drained, nothing is pending,
   * and nobody is waiting on a receipt; otherwise a later write would find its
   * generation reset under an older cancellation watermark, or a waiter would
   * be orphaned.
   *
   * Generations and the watermark go together or not at all: keeping one
   * without the other is precisely the inconsistency that would let a fresh
   * write be silently treated as cancelled.
   *
   * A session with an unresolved write failure is never retired — see below.
   */
  private retireIfQuiescent(key: SessionWriteKey): void {
    if (this.pending.has(key)) return
    if (this.tails.has(key)) return
    if (this.receiptWaiters.get(key)?.length) return
    // An unresolved write failure outlives quiescence. Retiring it turns "the
    // last write failed" into "nothing is outstanding, all good" — a durability
    // claim built out of deleted evidence. It clears on the next successful
    // write, and retirement proceeds then.
    //
    // Honest scope: this guard has no live reader. Every receipt belongs to a
    // generation minted by `enqueueChecked`, and that path leaves a pending
    // entry, so it settles from `write`'s own failure handling rather than from
    // this map. The guard stays because deleting a record of failure is the
    // wrong default for the next reader, not because one exists today;
    // `retirement-keeps-failure-evidence` pins it as state, not as behaviour.
    //
    // The cost is one map entry per session whose last write failed and which
    // is never written again — bounded by real write failures, not by traffic.
    if (this.lastWriteFailure.has(key)) return
    // No guard for `pendingExternalMetadata`, deliberately. Retirement below
    // does not touch that map, so an undischarged observation already survives
    // a sweep; blocking on it would only pin the generation maps open for a
    // session that may never be written again. Retiring generations under an
    // outstanding observation is harmless — the next enqueue simply starts at
    // generation 1 with a zero watermark, and the observation still applies to
    // it. (A guard here was written first, then removed: injecting its removal
    // changed no test, because it never had an effect to remove.)

    this.generations.delete(key)
    this.writtenGeneration.delete(key)
    this.cancelledThrough.delete(key)
    this.lastWriteFailure.delete(key)
    // `lastWrittenHeaderSignature` is deliberately NOT retired here. It is not
    // generation bookkeeping — it is the live baseline for "did somebody else
    // change this header since we last wrote it", and it has to outlive
    // quiescence because that is exactly when an external edit happens. Drop it
    // and two things break at once: the next write sees no previous signature,
    // concludes nothing external changed, and clobbers the other writer's
    // metadata; and `ConfigWatcher` loses its self-echo baseline and treats our
    // own write as a foreign change. It is removed only on explicit deletion,
    // where the session itself is going away.
  }

  /** Per-session bookkeeping sizes, for tests that assert nothing leaks. */
  diagnostics(): Record<string, number> {
    return {
      pending: this.pending.size,
      tails: this.tails.size,
      generations: this.generations.size,
      writtenGeneration: this.writtenGeneration.size,
      cancelledThrough: this.cancelledThrough.size,
      receiptWaiters: this.receiptWaiters.size,
      lastWriteFailure: this.lastWriteFailure.size,
      lastWrittenHeaderSignature: this.lastWrittenHeaderSignature.size,
    }
  }

  /** Settle every receipt this write satisfies, successfully or otherwise. */
  private settleReceipts(key: SessionWriteKey, generation: number, receipt: SessionWriteReceipt): void {
    const waiters = this.receiptWaiters.get(key)
    if (!waiters?.length) return
    const remaining: ReceiptWaiter[] = []
    for (const waiter of waiters) {
      if (waiter.generation <= generation) waiter.settle(receipt)
      else remaining.push(waiter)
    }
    if (remaining.length) this.receiptWaiters.set(key, remaining)
    else this.receiptWaiters.delete(key)
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(key: SessionWriteKey): Promise<boolean> {
    const entry = this.pending.get(key)
    if (!entry) return true

    this.pending.delete(key)
    const { generation } = entry

    // Cancelled between enqueue and execution: do not write at all. Nothing was
    // committed, so the intent does not matter here — there is no artifact to
    // keep or discard either way.
    if ((this.cancelledThrough.get(key)?.through ?? 0) >= generation) {
      debug(`[PersistenceQueue] Skipped cancelled write for ${entry.data.id}`)
      this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
      this.settleReceipts(key, generation, { ok: false, error: 'session write cancelled' })
      return false
    }

    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceRootPath)
      // The readable id, NOT the key: these build a filesystem path, and the key
      // is a JSON tuple. A blanket rename put the key here once and every write
      // silently landed in a directory named after its own key.
      ensureSessionDir(data.workspaceRootPath, data.id)

      const filePath = getSessionFilePath(data.workspaceRootPath, data.id)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      // An observed external edit is applied FIRST, so the header we intend to
      // write already carries it and the disk comparison below runs against the
      // truth rather than against local state that never heard about it. Disk
      // can still win on top: a newer external change is still a newer external
      // change.
      // An observation older than the bound is dropped rather than applied: by
      // then the on-disk state has long since settled, and re-reading it below
      // is the better answer than replaying something remembered.
      const held = this.pendingExternalMetadata.get(key)
      const observedExternal =
        held && Date.now() - held.observedAt <= OBSERVATION_MAX_AGE_MS ? held : undefined
      if (held && !observedExternal) {
        this.pendingExternalMetadata.delete(key)
        debug(`[PersistenceQueue] Dropped stale external observation for ${data.id}`)
      }
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(key)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig

      // ONE merge point, deliberately.
      //
      // Applying the observation first and then merging the whole external
      // header over the result silently reverses the observation's per-field
      // decision and restores a value the app had since changed. Two merges
      // that can disagree about the same field is the defect; resolving every
      // field in one place is the fix.
      const header = resolveExternalMetadata({
        local: localHeader,
        disk: hasExternalMetadataChange ? diskHeader : undefined,
        observation: observedExternal,
        lastWritten: this.lastWrittenMetadata.get(key),
      })

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${data.id} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(key, finalSignature)
      this.lastWrittenMetadata.set(key, getHeaderMetadataFields(header))

      const tmpFile = filePath + '.tmp'

      /**
       * Abandon this generation if it has been cancelled, leaving NOTHING of it
       * behind.
       *
       * Re-asked after every awaited step, because each one is a window: a
       * cancel can land while the data is being written, between the unlink and
       * the rename, or after the rename has already committed. The last case is
       * the one a single pre-commit check misses entirely — the bytes are on
       * disk for a session the caller has deleted.
       *
       * The post-rename case is also the only one that depends on WHY the write
       * was cancelled: removing the committed file is right for a deletion and
       * catastrophic for a supersede. The intent rides on the watermark rather
       * than being inferred here.
       *
       * Cleanup happens BEFORE the receipt is settled, so "cancelled" can never
       * be reported while the artifact it describes might still exist. And it
       * happens before the tail releases, so later generations — which are
       * serialised behind this one — start from a clean slate rather than
       * racing this cleanup.
       */
      const abandonIfCancelled = async (committed: boolean): Promise<boolean> => {
        const watermark = this.cancelledThrough.get(key)
        if ((watermark?.through ?? 0) < generation) return false
        // The temp file is this generation's private scratch space and is
        // always ours to remove, under either intent.
        try { await unlink(tmpFile) } catch { /* may not exist */ }
        if (committed && watermark?.discardCommitted) {
          // Deletion only. The rename already happened, so remove what it
          // produced — otherwise a session the caller deleted stays on disk.
          //
          // Emphatically NOT done for a supersede: there the file is a LIVE
          // session's, the caller is about to write merged fresh state over it,
          // and unlinking would delete real data and leave the session absent
          // from disk until the replacement write lands.
          try { await unlink(filePath) } catch { /* may not exist */ }
        }
        debug(`[PersistenceQueue] Abandoned cancelled write for session ${data.id} (committed=${committed})`)
        this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
        this.settleReceipts(key, generation, { ok: false, error: 'session write cancelled' })
        return true
      }

      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await this.commitHooks?.beforeUnlink?.(key)
      if (await abandonIfCancelled(false)) return false

      // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
      try { await unlink(filePath) } catch { /* ignore if doesn't exist */ }
      await this.commitHooks?.beforeRename?.(key)
      if (await abandonIfCancelled(false)) return false

      await rename(tmpFile, filePath)
      await this.commitHooks?.afterRename?.(key)
      if (await abandonIfCancelled(true)) return false

      debug(`[PersistenceQueue] Wrote session ${data.id}`)
      // Landed, so the observation has been discharged. Deliberately NOT done
      // on the abandon paths: a write that never committed has not carried the
      // edit anywhere, and dropping it there would lose it for good.
      if (observedExternal && this.pendingExternalMetadata.get(key) === observedExternal) {
        this.pendingExternalMetadata.delete(key)
      }
      this.lastWriteFailure.delete(key)
      this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
      this.settleReceipts(key, generation, { ok: true })
      return true
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${entry.data.id}:`, error)
      // Recorded, not thrown. Existing callers are fire-and-forget and must not
      // start failing; a receipt is the opt-in way to learn about this.
      const message = error instanceof Error ? error.message : String(error)
      this.lastWriteFailure.set(key, message)
      // Marked attempted either way, so a waiter learns the outcome promptly
      // instead of hanging until some later write happens to supersede it.
      // Failure is an answer; silence is not.
      this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
      this.settleReceipts(key, generation, { ok: false, error: message })
      return false
    }
  }

  /**
   * Immediately flush a specific session, on its serialised tail.
   *
   * Whatever is already running for this session finishes first and this write
   * follows it — never alongside. They share one `.tmp` path, so concurrency
   * there is a correctness problem rather than a fairness one: interleaved
   * writers can rename a half-written temp file over a good session and lose
   * the loser's bytes with no error anywhere.
   */
  async flush(key: SessionWriteKey): Promise<void> {
    if (!this.pending.has(key) && !this.tails.has(key)) return
    const entry = this.pending.get(key)
    if (entry) clearTimeout(entry.timer)
    await this.runOnTail(key)
  }

  /**
   * Drive a session's tail now, so a held handle settles without waiting out
   * the debounce.
   *
   * Deliberately says nothing about the OUTCOME. The caller already holds a
   * receipt for the write it cares about; any success/failure this returned
   * would be an answer about "the latest write", and that ambiguity is what
   * makes a parameterless checked flush unsound — after a cancel it has no way
   * to know which generation was meant and defaults to optimism.
   *
   * The returned promise is the tail: a caller that needs the write to be
   * FINISHED rather than merely decided can wait on it. The receipt answers
   * "did my bytes land"; the tail additionally covers the cleanup an abandoned
   * write does on its way out, which settles just after the receipt.
   */
  driveChecked(key: SessionWriteKey): Promise<void> {
    const entry = this.pending.get(key)
    if (entry) clearTimeout(entry.timer)
    return this.runOnTail(key)
  }

  /**
   * Stop every write enqueued so far, because the session is being DELETED.
   *
   * Discards the artifact even if the rename has already committed, and drops
   * the header-signature baseline along with it — there is no session left for
   * that baseline to describe.
   */
  cancelForDeletion(key: SessionWriteKey): void {
    this.stopPendingWrites(key, { discardCommitted: true })
    // Safe here and only here: the session is gone, so no later write can need
    // this baseline to detect an external edit.
    this.lastWrittenHeaderSignature.delete(key)
    this.lastWrittenMetadata.delete(key)
    this.lastWriteFailure.delete(key)
    this.pendingExternalMetadata.delete(key)
    // Drop the bookkeeping, but only if nothing is still in flight. Deleted
    // sessions would otherwise leave an entry in every map for the life of the
    // process; a session with a live tail retires when that tail drains.
    this.retireIfQuiescent(key)
  }

  /**
   * Stop stale writes from committing over fresher state, WITHOUT touching the
   * session's file.
   *
   * The caller has just absorbed an external metadata edit and is about to
   * persist the merged result. What it needs is for in-flight writes carrying
   * pre-edit state to lose; what it must never get is the session's file
   * removed, because the session is live.
   *
   * The header-signature baseline is deliberately KEPT. It is the input to
   * `write`'s external-change detection (`hasExternalMetadataChange` requires a
   * previous signature), and that detection is the only thing that preserves
   * `permissionMode`, `hasUnread` and `lastReadMessageId` — three of the seven
   * merged metadata fields, and the only ones `applyExternalSessionMetadata`
   * does not copy into memory itself. (`labels`, `isFlagged`, `sessionStatus`
   * and `name` it does copy, so those survive without the merge.) Dropping the
   * baseline here would make the very next write silently clobber the external
   * edit this call exists to protect.
   */
  supersedePendingWrites(key: SessionWriteKey, observedHeader?: SessionHeader): void {
    this.stopPendingWrites(key, { discardCommitted: false })
    // Hold what the caller actually saw, AND what we had when it saw it. The
    // second half is what stops a remembered external value from beating an
    // in-app change made after the observation — see `ExternalObservation`.
    //
    // Newest observation wins: it is the more recent view of the same external
    // writer, and it re-baselines against whatever we have written since.
    if (observedHeader) {
      this.pendingExternalMetadata.set(key, {
        external: getHeaderMetadataFields(observedHeader),
        localAtObservation: this.lastWrittenMetadata.get(key),
        observedAt: Date.now(),
      })
    }
    // No retirement sweep and no baseline drop: this session is live, is about
    // to be written again, and its baseline is load-bearing for that write.
  }

  /**
   * Shared core of both intents: raise the watermark and settle anything
   * waiting on the generations it now covers.
   */
  private stopPendingWrites(key: SessionWriteKey, { discardCommitted }: { discardCommitted: boolean }): void {
    const entry = this.pending.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(key)
      debug(`[PersistenceQueue] Cancelled pending write for session ${entry.data.id}`)
    }
    // Set regardless of whether anything was pending: the write that matters
    // here is the one already on the tail, which `pending` no longer holds.
    // Everything enqueued up to now is cancelled; anything enqueued after is
    // a higher generation and unaffected.
    //
    // Both fields climb and never fall, so the two callers cannot undo each
    // other in either order: a supersede arriving after a deletion leaves the
    // session deleted.
    //
    // The two halves have different standing, and saying so is the honest
    // version. `discardCommitted`'s OR is LIVE — both orderings are exercised
    // (`a supersede arriving after a deletion…` and its mirror), and dropping
    // it lets a watcher event rescue a deleted session's file. The `Math.max`
    // on `through` is a STRUCTURAL BACKSTOP with no reachable path today:
    // `generations` only ever shrinks in `retireIfQuiescent`, which deletes
    // `cancelledThrough` in the same breath, so there is no state in which a
    // lower generation count meets a surviving watermark. Removing it changes
    // no test, and it stays because the invariant should hold by construction
    // rather than by that adjacency continuing to be true.
    const previous = this.cancelledThrough.get(key)
    this.cancelledThrough.set(key, {
      through: Math.max(previous?.through ?? 0, this.generations.get(key) ?? 0),
      discardCommitted: (previous?.discardCommitted ?? false) || discardCommitted,
    })

    // Anything holding a receipt for a cancelled generation must be told rather
    // than left hanging, and telling them is also what makes the session
    // eligible for retirement — the order is load-bearing, not cosmetic.
    this.settleReceipts(key, Number.MAX_SAFE_INTEGER, { ok: false, error: 'session write cancelled' })
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const keys = [...this.pending.keys()]
    await Promise.all(keys.map(key => this.flush(key)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(key: SessionWriteKey): boolean {
    return this.pending.has(key)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(key: SessionWriteKey): string | undefined {
    return this.lastWrittenHeaderSignature.get(key)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, resolveExternalMetadata }
