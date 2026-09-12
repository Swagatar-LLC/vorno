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

class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
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
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      // Tracked like the flush-driven writes are. Without this a checked flush
      // arriving while a debounced write was mid-I/O saw no pending entry, found
      // no in-progress write, and reported success before the bytes had landed.
      const running = this.write(session.id).then(() => undefined)
      this.writeInProgress.set(session.id, running)
      void running.finally(() => {
        if (this.writeInProgress.get(session.id) === running) {
          this.writeInProgress.delete(session.id)
        }
      })
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string): Promise<boolean> {
    const entry = this.pending.get(sessionId)
    if (!entry) return true

    this.pending.delete(sessionId)

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
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
      try { await unlink(filePath) } catch { /* ignore if doesn't exist */ }
      await rename(tmpFile, filePath)
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
      this.lastWriteFailure.delete(sessionId)
      return true
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
      // Recorded, not thrown. Existing callers are fire-and-forget and must not
      // start failing; `flushChecked` is the opt-in way to learn about this.
      this.lastWriteFailure.set(sessionId, error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)

      // Wait for any in-progress write to complete first
      const inProgress = this.writeInProgress.get(sessionId)
      if (inProgress) {
        await inProgress
      }

      // Start new write and track it
      const writePromise = this.write(sessionId).then(() => undefined)
      this.writeInProgress.set(sessionId, writePromise)

      try {
        await writePromise
      } finally {
        // Only if it is still ours. A debounced write can replace the tracked
        // promise while this one settles, and an unconditional delete would
        // untrack the NEWER write — after which a checked flush sees no pending
        // and no in-flight work and reports success over bytes still being
        // written. Same rule the timer cleanup follows.
        if (this.writeInProgress.get(sessionId) === writePromise) {
          this.writeInProgress.delete(sessionId)
        }
      }
    }
  }

  /**
   * Flush, and report whether the bytes actually reached disk.
   *
   * `flush` cannot answer that question: `write` catches its own errors so the
   * fire-and-forget callers keep working, so a failed write is indistinguishable
   * from a successful one to anyone awaiting it. A caller that tells a user
   * "delivered and saved" needs the difference, and guessing in the optimistic
   * direction is the one answer it must never give.
   *
   * Deliberately additive: `flush` is untouched and every existing caller keeps
   * its best-effort behaviour.
   */
  async flushChecked(sessionId: string): Promise<SessionWriteReceipt> {
    const entry = this.pending.get(sessionId)
    if (!entry) {
      // Nothing QUEUED is not the same as nothing happening: `write` removes
      // its pending entry before it touches the filesystem, so a write can be
      // mid-I/O with the queue already empty. Reporting success here would tell
      // the caller its bytes were on disk while they were still in flight — and
      // if that write then fails, the claim was simply false.
      const inProgress = this.writeInProgress.get(sessionId)
      if (inProgress) await inProgress

      // Either everything is on disk, or the last attempt failed and nobody has
      // succeeded since — which still means this state is not durable.
      const prior = this.lastWriteFailure.get(sessionId)
      return prior ? { ok: false, error: prior } : { ok: true }
    }

    clearTimeout(entry.timer)
    const inProgress = this.writeInProgress.get(sessionId)
    if (inProgress) await inProgress

    const writePromise = this.write(sessionId)
    const tracked = writePromise.then(() => undefined)
    this.writeInProgress.set(sessionId, tracked)
    try {
      const wrote = await writePromise
      if (wrote) return { ok: true }
      return { ok: false, error: this.lastWriteFailure.get(sessionId) ?? 'session write failed' }
    } finally {
      // Only if it is still ours — see the note in `flush`. Untracking a newer
      // write here is exactly how a later checked flush comes to report success
      // over work that has not finished.
      if (this.writeInProgress.get(sessionId) === tracked) {
        this.writeInProgress.delete(sessionId)
      }
    }
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
    this.lastWrittenHeaderSignature.delete(sessionId)
    this.lastWriteFailure.delete(sessionId)
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
