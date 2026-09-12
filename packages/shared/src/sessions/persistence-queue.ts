import { writeFile, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
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

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
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
  generation: number
  receipt: Promise<SessionWriteReceipt>
}

class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
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
  private tails = new Map<string, Promise<void>>()
  /** Highest generation enqueued per session. */
  private generations = new Map<string, number>()
  /** Highest generation successfully written per session. */
  private writtenGeneration = new Map<string, number>()
  private receiptWaiters = new Map<string, ReceiptWaiter[]>()
  /**
   * Highest generation cancelled per session — a watermark, not a flag.
   *
   * `cancel` drops the PENDING entry, but a write already on the tail is past
   * that point: it can finish and rename its temp file over a session the
   * caller has deleted, recreating state that was meant to be gone.
   *
   * A boolean cannot express this correctly, and the first version of it was
   * wrong in a way worth recording. `enqueue` cleared the flag so a cancel
   * could not mute the session forever — but that let a re-enqueue UN-cancel a
   * write already in flight: the stale write reached its pre-commit check, saw
   * the flag cleared by the newer enqueue, and committed over it.
   *
   * A watermark is immune to that. Cancellation attaches to the generations
   * that existed when it was called, so a later enqueue is simply a higher
   * generation and is unaffected, with nothing to clear and no window in which
   * clearing it is wrong. Generations therefore stay monotonic for the life of
   * the process and are never reset.
   */
  private cancelledThrough = new Map<string, number>()
  /**
   * Test seam: awaited at each commit boundary so a suite can land a cancel
   * inside a write deterministically.
   *
   * Real filesystem writes take measurable time and a cancel genuinely can
   * arrive mid-commit, but an in-memory test's writes settle far too fast to
   * hit those windows by timing. Without a seam the guards above would be
   * untestable — and an untested guard is one nobody can tell is still working.
   * Unset in production, where it costs one optional-chain per boundary.
   */
  commitHooks?: {
    beforeUnlink?: (sessionId: string) => void | Promise<void>
    beforeRename?: (sessionId: string) => void | Promise<void>
    afterRename?: (sessionId: string) => void | Promise<void>
  }
  /**
   * Last write failure per session, cleared on the next success.
   *
   * `write` deliberately swallows its errors so the fire-and-forget callers
   * that make up almost all of this queue's traffic keep working — but that
   * also meant `flush` resolved happily after a failed write, and a caller who
   * needed to *know* had no way to ask. This is how they ask.
   */
  private lastWriteFailure = new Map<string, string>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): number {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const generation = (this.generations.get(session.id) ?? 0) + 1
    this.generations.set(session.id, generation)

    const timer = setTimeout(() => {
      // Onto the tail like every other write, so the debounced path cannot race
      // a flush for the same `.tmp`.
      void this.runOnTail(session.id)
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer, generation })
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
    const generation = this.enqueue(session)
    return { generation, receipt: this.receiptFor(session.id, generation) }
  }

  /** Resolve once `generation` (or later) has been written, or has failed. */
  private receiptFor(sessionId: string, generation: number): Promise<SessionWriteReceipt> {
    // Cancelled generations are TERMINAL and answer immediately, rather than
    // parking a waiter that nothing would settle: `write` returns early when
    // there is no pending entry, which is exactly the state `cancel` leaves
    // behind.
    //
    // Unreachable through the public API today, and deliberately kept anyway —
    // same standing as the backstop twenty lines below. What makes it
    // unreachable is arithmetic in a different method: `enqueue` mints
    // `generations.get(id) + 1` and `cancel` sets the watermark to
    // `generations.get(id)`, so a freshly minted generation is always strictly
    // above it. No black-box test can reach this branch, and none pretends to;
    // it is here because the invariant — never report success for a cancelled
    // generation — should survive someone changing that arithmetic.
    if ((this.cancelledThrough.get(sessionId) ?? 0) >= generation) {
      return Promise.resolve({ ok: false, error: 'session write cancelled' })
    }
    const written = this.writtenGeneration.get(sessionId) ?? 0
    if (written >= generation) {
      const prior = this.lastWriteFailure.get(sessionId)
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
    if (!this.pending.has(sessionId) && !this.tails.has(sessionId)) {
      const prior = this.lastWriteFailure.get(sessionId)
      return Promise.resolve(
        prior ? { ok: false, error: prior } : { ok: false, error: 'session write cancelled' },
      )
    }

    return new Promise<SessionWriteReceipt>((settle) => {
      const waiters = this.receiptWaiters.get(sessionId) ?? []
      waiters.push({ generation, settle })
      this.receiptWaiters.set(sessionId, waiters)
    })
  }

  /**
   * Run the pending write for a session on its serialised tail.
   *
   * Chained with `.then(fn, fn)` so one failed write does not strand every
   * later write for that session behind a rejected promise.
   */
  private runOnTail(sessionId: string): Promise<void> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const next = previous.then(
      () => this.write(sessionId).then(() => undefined),
      () => this.write(sessionId).then(() => undefined),
    )
    this.tails.set(sessionId, next)
    void next.finally(() => {
      // Only if still ours: a later write may already own the tail.
      if (this.tails.get(sessionId) === next) {
        this.tails.delete(sessionId)
        this.retireIfQuiescent(sessionId)
      }
    })
    return next
  }

  /**
   * Drop a session's bookkeeping once nothing can still refer to it.
   *
   * These maps are keyed by session id and would otherwise grow for the life of
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
  private retireIfQuiescent(sessionId: string): void {
    if (this.pending.has(sessionId)) return
    if (this.tails.has(sessionId)) return
    if (this.receiptWaiters.get(sessionId)?.length) return
    // An unresolved write failure outlives quiescence. Retiring it turns "the
    // last write failed" into "nothing is outstanding, all good" — a durability
    // claim built out of deleted evidence. It clears on the next successful
    // write, and retirement proceeds then.
    //
    // Honest scope: this guard has no live reader as of the removal of the
    // parameterless `flushChecked`, which used to ask about durability after
    // quiescence and was the caller this protected. Every receipt now belongs
    // to a generation minted by `enqueueChecked`, and that path leaves a
    // pending entry, so it settles from `write`'s own failure handling rather
    // than from this map. The guard stays because deleting a record of failure
    // is the wrong default for the next reader, not because one exists today;
    // `retirement-keeps-failure-evidence` pins it as state, not as behaviour.
    //
    // The cost is one map entry per session whose last write failed and which
    // is never written again — bounded by real write failures, not by traffic.
    if (this.lastWriteFailure.has(sessionId)) return

    this.generations.delete(sessionId)
    this.writtenGeneration.delete(sessionId)
    this.cancelledThrough.delete(sessionId)
    this.lastWriteFailure.delete(sessionId)
    // `lastWrittenHeaderSignature` is deliberately NOT retired here. It is not
    // generation bookkeeping — it is the live baseline for "did somebody else
    // change this header since we last wrote it", and it has to outlive
    // quiescence because that is exactly when an external edit happens. Drop it
    // and two things break at once: the next write sees no previous signature,
    // concludes nothing external changed, and clobbers the other writer's
    // metadata; and `ConfigWatcher` loses its self-echo baseline and treats our
    // own write as a foreign change. It is removed only on explicit cancel,
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
  private settleReceipts(sessionId: string, generation: number, receipt: SessionWriteReceipt): void {
    const waiters = this.receiptWaiters.get(sessionId)
    if (!waiters?.length) return
    const remaining: ReceiptWaiter[] = []
    for (const waiter of waiters) {
      if (waiter.generation <= generation) waiter.settle(receipt)
      else remaining.push(waiter)
    }
    if (remaining.length) this.receiptWaiters.set(sessionId, remaining)
    else this.receiptWaiters.delete(sessionId)
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string): Promise<boolean> {
    const entry = this.pending.get(sessionId)
    if (!entry) return true

    this.pending.delete(sessionId)
    const { generation } = entry

    // Cancelled between enqueue and execution: do not write at all.
    if ((this.cancelledThrough.get(sessionId) ?? 0) >= generation) {
      debug(`[PersistenceQueue] Skipped cancelled write for session ${sessionId}`)
      this.writtenGeneration.set(sessionId, Math.max(this.writtenGeneration.get(sessionId) ?? 0, generation))
      this.settleReceipts(sessionId, generation, { ok: false, error: 'session write cancelled' })
      return false
    }

    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

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
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
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
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

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
       * Cleanup happens BEFORE the receipt is settled, so "cancelled" can never
       * be reported while the artifact it describes might still exist. And it
       * happens before the tail releases, so later generations — which are
       * serialised behind this one — start from a clean slate rather than
       * racing this cleanup.
       */
      const abandonIfCancelled = async (committed: boolean): Promise<boolean> => {
        if ((this.cancelledThrough.get(sessionId) ?? 0) < generation) return false
        try { await unlink(tmpFile) } catch { /* may not exist */ }
        if (committed) {
          // The rename already happened: remove what it produced.
          try { await unlink(filePath) } catch { /* may not exist */ }
        }
        debug(`[PersistenceQueue] Abandoned cancelled write for session ${sessionId} (committed=${committed})`)
        this.writtenGeneration.set(sessionId, Math.max(this.writtenGeneration.get(sessionId) ?? 0, generation))
        this.settleReceipts(sessionId, generation, { ok: false, error: 'session write cancelled' })
        return true
      }

      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await this.commitHooks?.beforeUnlink?.(sessionId)
      if (await abandonIfCancelled(false)) return false

      // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
      try { await unlink(filePath) } catch { /* ignore if doesn't exist */ }
      await this.commitHooks?.beforeRename?.(sessionId)
      if (await abandonIfCancelled(false)) return false

      await rename(tmpFile, filePath)
      await this.commitHooks?.afterRename?.(sessionId)
      if (await abandonIfCancelled(true)) return false

      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
      this.lastWriteFailure.delete(sessionId)
      this.writtenGeneration.set(sessionId, Math.max(this.writtenGeneration.get(sessionId) ?? 0, generation))
      this.settleReceipts(sessionId, generation, { ok: true })
      return true
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
      // Recorded, not thrown. Existing callers are fire-and-forget and must not
      // start failing; a receipt is the opt-in way to learn about this.
      const message = error instanceof Error ? error.message : String(error)
      this.lastWriteFailure.set(sessionId, message)
      // Marked attempted either way, so a waiter learns the outcome promptly
      // instead of hanging until some later write happens to supersede it.
      // Failure is an answer; silence is not.
      this.writtenGeneration.set(sessionId, Math.max(this.writtenGeneration.get(sessionId) ?? 0, generation))
      this.settleReceipts(sessionId, generation, { ok: false, error: message })
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
  async flush(sessionId: string): Promise<void> {
    if (!this.pending.has(sessionId) && !this.tails.has(sessionId)) return
    const entry = this.pending.get(sessionId)
    if (entry) clearTimeout(entry.timer)
    await this.runOnTail(sessionId)
  }

  /**
   * Drive a session's tail now, so a held handle settles without waiting out
   * the debounce.
   *
   * Deliberately says nothing about the OUTCOME. The caller already holds a
   * receipt for the write it cares about; any success/failure this returned
   * would be an answer about "the latest write", and that ambiguity is what
   * made the previous parameterless `flushChecked` unsound — after a cancel it
   * had no way to know which generation was meant and defaulted to optimism.
   *
   * The returned promise is the tail: a caller that needs the write to be
   * FINISHED rather than merely decided can wait on it. The receipt answers
   * "did my bytes land"; the tail additionally covers the cleanup an abandoned
   * write does on its way out, which settles just after the receipt.
   */
  driveChecked(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) clearTimeout(entry.timer)
    return this.runOnTail(sessionId)
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    // Set regardless of whether anything was pending: the write that matters
    // here is the one already on the tail, which `pending` no longer holds.
    // Everything enqueued up to now is cancelled; anything enqueued after is
    // a higher generation and unaffected.
    this.cancelledThrough.set(sessionId, this.generations.get(sessionId) ?? 0)

    // Waiters first. Anything holding a receipt for a cancelled generation must
    // be told rather than left hanging, and telling them is also what makes the
    // session eligible for retirement below — the order is load-bearing, not
    // cosmetic.
    this.settleReceipts(sessionId, Number.MAX_SAFE_INTEGER, { ok: false, error: 'session write cancelled' })
    this.lastWrittenHeaderSignature.delete(sessionId)
    this.lastWriteFailure.delete(sessionId)

    // Then drop the bookkeeping, but only if nothing is still in flight.
    // Deleted sessions are the common case here and would otherwise leave an
    // entry in every map for the life of the process; a session with a live
    // tail retires when that tail drains instead.
    this.retireIfQuiescent(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = [...this.pending.keys()]
    await Promise.all(sessionIds.map(id => this.flush(id)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
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
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
