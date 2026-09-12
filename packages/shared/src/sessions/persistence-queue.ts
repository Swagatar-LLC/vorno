/**
 * Session persistence: one serialised, workspace-qualified write path per
 * session, with receipts for the callers that need to know a write landed.
 *
 * Four invariants shape everything below. They are stated here ONCE and
 * referenced by name at the sites that rely on them, rather than re-argued at
 * each one.
 *
 * **I1 — one tail per key.** Every write for a session goes through a single
 * serialised chain. They share one `.tmp` path, so concurrency there is a
 * correctness problem and not a fairness one: interleaved writers can rename a
 * half-written temp file over a good session, and the loser's bytes vanish with
 * no error anywhere. Serialising is what makes "the newest enqueued state wins"
 * true rather than merely probable.
 *
 * **I2 — "stop these writes" has two meanings.** A DELETION must discard the
 * artifact even after the rename committed, or a deleted session reappears on
 * disk. A SUPERSEDE must never remove it: its caller has absorbed an external
 * metadata edit and is about to write merged state, so the session is live and
 * unlinking deletes a real transcript. Conflating them destroys user data, and
 * the distinction has to survive both orderings and every commit boundary —
 * including the one where we have already unlinked the target ourselves.
 *
 * **I3 — "what is on disk" and "what a watcher should ignore" are different
 * questions.** `ConfigWatcher` has to recognise the fs events fired during our
 * own unlink and rename, which means publishing a signature BEFORE the bytes
 * land. That value must never become "what we last committed": left standing
 * after a write that failed, the next write reads the untouched file as an
 * external edit and the merge hands disk the win, silently reverting the app's
 * own unsaved change. Hence two fields — `inFlightSignature` for echo
 * suppression, `committedMetadata` promoted only by a successful rename.
 *
 * **I4 — a receipt attests its own bytes.** Never a later write's success:
 * that assumes the newer snapshot contained the older one, which is true of
 * today's callers and is not something a durability answer may rest on. So a
 * checked snapshot is never coalesced into, and its receipt settles on its
 * exact generation. `ok: true` means committed — written and renamed without
 * error — and explicitly NOT power-loss durable; see {@link SessionWriteReceipt}.
 */
import { writeFile, rename, unlink } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { sanitizeSessionId } from './validation.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
  /** Monotonic per session. A receipt is settled by THIS generation alone. */
  generation: number
  /**
   * Whether somebody holds a receipt against this exact snapshot.
   *
   * A checked entry is never coalesced into, because its receipt is a claim
   * about ITS bytes. An ordinary entry has no such claim, so a newer ordinary
   * write may still replace it wholesale — that coalescing is why this queue
   * exists, and it is preserved for the traffic that makes up almost all of it.
   */
  checked: boolean
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

/**
 * Takes the shared shape rather than `SessionHeader`, so the same extraction
 * serves a header and a `StoredSession` snapshot. The seven fields are named
 * identically on both, and the observation baseline needs it off a snapshot.
 */
function getHeaderMetadataFields(header: HeaderMetadataSignature): HeaderMetadataSignature {
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
 * How far cancellation reaches, per intent (I2).
 *
 * **Two watermarks rather than one plus a flag.** A single sticky
 * `discardCommitted` boolean was wrong in a way no test caught: it described
 * the session rather than a generation, so once any deletion had happened the
 * "discard the artifact" intent applied to every later generation too. A
 * session deleted, re-enqueued, and then superseded would have had that
 * supersede unlink a live file, because the flag was still set from the
 * deletion several generations earlier.
 *
 * Keyed by intent, each generation gets the answer that belongs to it: a
 * generation is cancelled if either watermark covers it, and its artifact is
 * discarded only if the DELETION watermark does. Both climb and never fall, so
 * the two callers still cannot undo each other in either order — a supersede
 * after a deletion cannot un-delete, and a deletion after a supersede still
 * discards — without the intent bleeding forward onto unrelated work.
 */
type CancellationWatermark = { deleteThrough: number; supersedeThrough: number }

/**
 * Which cancellation a generation fell under.
 *
 * The deletion watermark wins when both cover it, matching the stickiness rule:
 * nothing un-deletes a session, so a supersede arriving afterwards must not
 * downgrade the answer to one a caller would retry.
 */
function cancellationReasonFor(
  watermark: CancellationWatermark | undefined,
  generation: number,
): 'deleted' | 'superseded' {
  return (watermark?.deleteThrough ?? 0) >= generation ? 'deleted' : 'superseded'
}

/** The highest generation cancelled under either intent. */
function cancelledThroughGeneration(watermark?: CancellationWatermark): number {
  return Math.max(watermark?.deleteThrough ?? 0, watermark?.supersedeThrough ?? 0)
}

/**
 * How far a write has got, for the cancellation check.
 *
 * Named rather than a boolean because the three stages do not differ by degree:
 * what a cancellation may safely do is different at each one, and the middle
 * stage is the surprising one. `intact` — the session's file is untouched, so
 * walking away leaves it exactly as it was. `target-removed` — we have unlinked
 * it ourselves for Windows, so walking away leaves NOTHING. `committed` — the
 * rename has happened and the bytes are live.
 */
type WriteStage = 'intact' | 'target-removed' | 'committed'

/**
 * Commit-boundary callbacks, for tests that need a cancel to land mid-write.
 *
 * Exported so a suite can build its own queue with them; there is deliberately
 * no way to attach them to an existing queue.
 */
export interface SessionCommitHooks {
  beforeUnlink?: (key: SessionWriteKey) => void | Promise<void>
  beforeRename?: (key: SessionWriteKey) => void | Promise<void>
  afterRename?: (key: SessionWriteKey) => void | Promise<void>
}

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
 * A JSON tuple rather than the session's file path, deliberately. A single
 * interpolated path is not injective over its inputs: `getSessionFilePath`
 * splices the id in, so root `/w` + id `a/sessions/b` and root `/w/sessions/a`
 * + id `b` produce the same string. A tuple keeps the two components separable,
 * because JSON escaping survives round-tripping.
 *
 * **Both components are canonicalised the way the FILE PATH canonicalises
 * them**, which is the half that is easy to miss. `getSessionPath` runs the id
 * through `sanitizeSessionId` (a `basename`) as path-traversal defence, so
 * `nested/same` and `same` name the SAME file — and keying on the raw id gave
 * them two keys, two tails, and two writers racing over one `.tmp`, which is
 * precisely the lost-bytes race this key exists to prevent, arrived at from the
 * other direction. The id therefore goes through the same canonicaliser the
 * path uses; there is one of it, and both callers use it. The root is
 * `resolve`d, so `/w`, `/w/`, and `/w/x/..` are one key.
 *
 * **What "injective" means here, exactly.** The key is injective over the pair
 * (`resolve`d root STRING, sanitised id) — it is string identity, NOT filesystem
 * identity, and the difference is a real if narrow gap:
 *
 * - **Case.** On a case-insensitive volume (macOS by default, Windows)
 *   `/Users/x/w` and `/Users/x/W` resolve to different strings and the same
 *   directory, so they yield two keys over one artifact.
 * - **Links.** There is no `realpath`, so a symlinked or bind-mounted root is a
 *   different string for the same file.
 *
 * Accepted as a residual rather than fixed here. Both require hitting the same
 * workspace through two different spellings in one process, which nothing in
 * the product does — roots come from stored workspace config, not from user
 * input at write time — and the fix is not free: `realpath` is a syscall per
 * key on a hot path and fails for a root that does not exist yet, while
 * case-folding correctly is locale-dependent. If it ever needs closing, do it
 * by canonicalising the root ONCE where a workspace is loaded, not per write.
 * Recorded on SUV-0066.
 *
 * Two DIFFERENT roots still give different keys even when the ids canonicalise
 * to the same thing — the point is to match the artifact, and those are two.
 *
 * Branded so the compiler rejects a bare `sessionId` at every call site. When
 * this was introduced it found all of them; that is the only reason to believe
 * none were missed. Note that `packages/shared/tests/` is outside the
 * typechecked `src/` and the brand does **not** reach it.
 */
export type SessionWriteKey = string & { readonly __sessionWriteKey: unique symbol }

/**
 * Build the key for a session's persistence state.
 *
 * Injective over (`resolve`d root string, sanitised id) — see the type's note
 * on why that is string identity rather than filesystem identity.
 */
export function sessionWriteKey(workspaceRootPath: string, sessionId: string): SessionWriteKey {
  // `sanitizeSessionId` is the SAME canonicaliser `getSessionPath` applies, and
  // that is the whole requirement: the key must identify the file, not the
  // string the caller happened to pass.
  return JSON.stringify([resolve(workspaceRootPath), sanitizeSessionId(sessionId)]) as SessionWriteKey
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
 * `localAtObservation` is undefined when this process has never enqueued or
 * written the session, in which case there is no evidence of a local change and
 * the external value applies.
 *
 * **What holding this is load-bearing FOR.** Not "preserving name and labels
 * after a watcher event" — `applyExternalSessionMetadata` mirrors those into
 * the managed session itself, so the next outgoing header carries them without
 * any help from here. It matters for the fields that method deliberately does
 * NOT mirror: today exactly `permissionMode`. For those the observation is the
 * only surviving copy once a stale write has committed pre-edit state over the
 * file, because supersede correctly keeps that file and the baseline then
 * matches it, so nothing downstream can detect the divergence.
 *
 * The per-field later-local rule is what keeps that safe: the comparison above
 * runs field by field, so an in-app change made AFTER the observation wins that
 * field while the observation still supplies the fields the app has not touched.
 * Dropping the whole observation on any local change would lose the external
 * edit it exists to carry; applying all of it unconditionally would revert the
 * user's newer edit.
 */
type ExternalObservation = {
  external: HeaderMetadataSignature
  localAtObservation?: HeaderMetadataSignature
}

/**
 * When a held observation is released — and why it is NOT on a timer.
 *
 * An observation is the ONLY surviving copy of an external metadata edit in the
 * stale-write race: the write that lost the race committed pre-edit state over
 * it, and supersede correctly keeps that file, so disk no longer holds the edit
 * and the baseline matches the stale file. Re-reading disk cannot recover it.
 *
 * An age-based drop therefore does not bound anything worth bounding — it
 * DISCARDS USER DATA on a timer, silently, and only for the sessions unlucky
 * enough to be idle. A previous revision honoured observations for five
 * minutes; the number was arbitrary and the failure it caused was real.
 *
 * So an observation is released on exactly two events, both of which mean it
 * has done its job or has no job left:
 *
 * 1. The write that COMMITS it succeeds — the edit is on disk, so the memory is
 *    redundant.
 * 2. The session is explicitly deleted (`cancelForDeletion`) — there is nothing
 *    left for the edit to describe.
 *
 * Normally short-lived: the only caller, `applyExternalSessionMetadata`,
 * supersedes and then immediately persists, so event 1 follows within a
 * debounce interval. What is left is one small record per session that received
 * an external edit, was never successfully written again, and was never
 * deleted — bounded by that anomaly rather than by traffic, and visible in
 * `diagnostics()` so a leak test can watch it.
 */

/**
 * How many times `flushAll` will re-take the union before giving up.
 *
 * Quit must not hang on a producer that keeps enqueueing, but it also must not
 * abandon real writes. A normal quit converges in one or two rounds.
 */
const FLUSH_ALL_MAX_ROUNDS = 50

/**
 * Outcome of a checked persist. `ok:false` carries the reason for the audit.
 *
 * **`ok: true` means COMMITTED, not power-loss durable, and the distinction is
 * deliberate rather than sloppy.** It means this snapshot's bytes were written
 * to a temp file and renamed over the session file without error, so any reader
 * now sees them and no partial state is visible. It does **not** mean the data
 * would survive a power cut or a kernel panic in the seconds afterwards: there
 * is no `fsync` on the temp file or on the parent directory, so the bytes and
 * the directory entry may still be in the page cache.
 *
 * Adding those fsyncs was considered and rejected for now: this queue carries
 * every session state change in the app, debounced but constant, and two syncs
 * per write is a real cost to pay for a guarantee no current caller asks for —
 * the callers that hold receipts want to know the write SUCCEEDED, not that it
 * survives unplugging the machine. Recorded as a residual on SUV-0066 so the
 * next person reads a stated limit instead of inferring a guarantee from the
 * word "durable".
 */
export type SessionWriteReceipt =
  | { ok: true }
  /**
   * `reason` exists because not every `ok: false` means the same thing to a
   * caller, and shutdown is where the difference bites.
   *
   * - `superseded` — something newer replaced this snapshot. The write did not
   *   land and did not need to: the replacement is what should be on disk, and
   *   for a caller holding a patch the right move is to REAPPLY it against the
   *   merged state rather than to fail. A shutdown that treated this as a
   *   failure would abort over a supersede doing its job.
   * - `deleted` — the session itself is gone. Distinct from `superseded`
   *   precisely because retrying is the WRONG answer here: re-writing would
   *   resurrect a session the user deleted. Callers must not retry.
   * - `refused` — the queue is closing and would not accept the work at all.
   *   Nothing was attempted.
   * - `failed` — the write was attempted and the filesystem said no. The only
   *   one that means data may have been lost.
   *
   * `superseded` and `deleted` were one value until a caller needed to retry
   * one and never the other; collapsing them again would make "retry a
   * cancelled write" mean "recreate a deleted session".
   */
  | { ok: false; error: string; reason: 'superseded' | 'deleted' | 'refused' | 'failed' }

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
  /**
   * Queued writes per session, oldest first.
   *
   * A LIST rather than a single coalescing slot, because of I4: a replaced
   * snapshot never reaches disk, so with one slot an ordinary `persistSession`
   * landing between a checked enqueue and its write took its place and the
   * receipt reported success for bytes nobody wrote.
   *
   * Ordinary writes still coalesce into the trailing entry, so the common case
   * costs what it always did — back-to-back changes for one session collapse to
   * one write. A checked entry ends the run.
   */
  private queued = new Map<SessionWriteKey, PendingWrite[]>()
  /**
   * Per-session write tail. EVERY write — debounced, flushed, or checked —
   * chains onto it, so two writes for one session are never in flight at once.
   * This is I1.
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
   * Awaited at each commit boundary so a suite can land a cancel inside a write
   * deterministically. Supplied at construction; there is no setter.
   *
   * Real filesystem writes take measurable time and a cancel genuinely can
   * arrive mid-commit, but an in-memory test's writes settle far too fast to hit
   * those windows by timing. Without a seam the cancellation guards would be
   * untestable — and an untested guard is one nobody can tell is still working.
   *
   * **What this does and does not buy, stated precisely**, because the previous
   * version of this comment overclaimed on all three counts:
   *
   * - `readonly` is a TYPESCRIPT constraint. It is erased at runtime, so this
   *   is not "never reassignable" — compiled JS can still assign to it. What it
   *   removes is the typed, discoverable API that invited it.
   * - The production singleton is NOT constructed without hooks. It is
   *   constructed WITH delegating hooks that forward to a module-scoped holder,
   *   which is how the few SessionManager-level suites reach a commit boundary.
   * - The seam is therefore NARROWED, not absent:
   *   `installSingletonCommitHooksForTesting` exists, off the package barrel and
   *   behind a test-runner guard, and returns a token-scoped disposer. See its
   *   own comment for the contract and for why it cannot be removed outright.
   *
   * The honest summary: an instance a test constructs needs no mutable surface
   * at all, and the shared one has a single named, throwing, greppable entry
   * point instead of an assignable property. Tightening further is a recorded
   * residual on SUV-0066.
   */
  private readonly commitHooks?: SessionCommitHooks
  /**
   * Last write failure per session, cleared on the next success.
   *
   * `write` deliberately swallows its errors so the fire-and-forget callers
   * that make up almost all of this queue's traffic keep working — but that
   * also meant `flush` resolved happily after a failed write, and a caller who
   * needed to *know* had no way to ask. This is how they ask.
   */
  private lastWriteFailure = new Map<SessionWriteKey, string>()
  /**
   * The ONE baseline: the metadata of the header we last COMMITTED, per session.
   *
   * There used to be two of these — a signature string and the same seven
   * fields — set together and read separately, which is two things to keep in
   * agreement for no gain. The signature is derived on demand instead.
   *
   * Only a successful rename writes this. That is the fix for a defect worth
   * naming: it used to be assigned BEFORE the write (see `inFlightSignature`),
   * which made it a claim about bytes that might never land. Left standing
   * after a failed or abandoned write, the next write read the untouched file
   * on disk as an external edit, and the merge handed disk the win — so one
   * failed write silently reverted the app's own unsaved change. Promoting only
   * on success removes the whole speculative-then-roll-back dance.
   */
  private committedMetadata = new Map<SessionWriteKey, HeaderMetadataSignature>()
  /**
   * The signature of a header currently being written, for fs.watch echo
   * suppression ONLY.
   *
   * `ConfigWatcher` sees events during the unlink and the rename, and has to
   * recognise them as ours or it treats our own write as a foreign change and
   * reverts in-memory metadata on idle sessions. That requires publishing the
   * signature BEFORE the bytes land — which is exactly what must not be allowed
   * to contaminate the committed baseline.
   *
   * So the two concerns are two fields. This one is set before the write and
   * cleared on every exit path, successful or not; the committed baseline is
   * promoted only by a successful rename. Nothing reads this as "what is on
   * disk".
   */
  private inFlightSignature = new Map<SessionWriteKey, string>()
  private lastEnqueuedMetadata = new Map<SessionWriteKey, HeaderMetadataSignature>()
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
  /**
   * Once true, no new work is accepted and the queue is draining for shutdown.
   *
   * Without this, "flushed everything" was never actually true: `flushAll`
   * could drain the union it found while a producer kept enqueueing behind it,
   * so quit either looped against a moving target or returned with work still
   * arriving. Freezing intake first is what makes quiescence a reachable state
   * rather than a coincidence.
   *
   * Refusal is explicit and reported — an enqueue after this point returns a
   * failed receipt rather than being silently dropped, because a caller that
   * believes it saved something is worse off than one that is told it did not.
   */
  private closing = false
  /**
   * Writes that FAILED after the freeze landed, by key.
   *
   * Quiescence is not success, and that gap was load-bearing: `write` catches
   * its own errors so the fire-and-forget callers that make up nearly all of
   * this queue's traffic keep working, and an ORDINARY write has no receipt
   * holder to learn the outcome. So an idle session with one pending write that
   * failed during the drain left the queue empty, `flushAll` returned happily,
   * and the host logged a clean quit over state that never reached disk. The
   * checked final persists cannot cover it — those run BEFORE the freeze, and
   * this is about everything the drain itself carries.
   *
   * Keyed, not appended, because a failure is a claim about STATE rather than
   * about an attempt: a later write for the same session that commits clears it
   * (the bytes are on disk, so there is nothing left to report), and a
   * cancellation never records one at all — `deleted` is intentional and
   * `superseded` means a replacement is carrying the state.
   *
   * Read and cleared by `flushAll`, which is the one caller entitled to the
   * answer and the one place it can be reported.
   */
  private closingWriteFailures = new Map<SessionWriteKey, string>()
  private debounceMs: number

  constructor(debounceMs = 500, commitHooks?: SessionCommitHooks) {
    this.debounceMs = debounceMs
    this.commitHooks = commitHooks
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): number {
    return this.enqueueEntry(session, { checked: false, reconciliation: false })
  }

  /**
   * Enqueue the REPLACEMENT write that follows a supersede. Accepted during a
   * shutdown drain, when an ordinary write is not.
   *
   * The exception exists because a supersede and its replacement are two halves
   * of one operation. `applyExternalSessionMetadata` cancels the in-flight write
   * (so it cannot commit pre-edit state) and then persists the merged result. If
   * the first half is allowed and the second refused, the net effect of
   * absorbing an external edit is to DESTROY it: the write that would have
   * carried it is cancelled, nothing replaces it, and the stale file stands.
   * Freezing intake must not turn a reconciliation into data loss.
   *
   * Narrow on purpose. This is not "writes we like": it is the one path whose
   * refusal is worse than its acceptance, and it is bounded by the same drain
   * rounds as everything else — a watcher that keeps producing past them fails
   * the shutdown loudly rather than extending it forever.
   */
  enqueueReconciliation(session: StoredSession): number {
    return this.enqueueEntry(session, { checked: false, reconciliation: true })
  }

  /**
   * Shared by every entry point.
   *
   * `checked` decides whether the entry may be coalesced into (I4);
   * `reconciliation` decides whether it survives a shutdown freeze.
   */
  private enqueueEntry(
    session: StoredSession,
    { checked, reconciliation }: { checked: boolean; reconciliation: boolean },
  ): number {
    const key = sessionWriteKey(session.workspaceRootPath, session.id)
    if (this.closing && !reconciliation) {
      // Refused, not queued. Returning the current generation keeps the
      // signature honest for `enqueue`'s fire-and-forget callers; a checked
      // caller gets a failed receipt from `enqueueChecked` below, which is the
      // answer that matters.
      console.error(`[PersistenceQueue] Refused a write for ${session.id}: queue is closing`)
      return this.generations.get(key) ?? 0
    }
    const list = this.queued.get(key) ?? []
    const trailing = list[list.length - 1]

    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)

    const timer = setTimeout(() => {
      // Onto the tail like every other write, so the debounced path cannot race
      // a flush for the same `.tmp`.
      void this.runOnTail(key)
    }, this.debounceMs)

    // An ordinary write replaces a trailing ordinary one — the coalescing this
    // queue is for. It may NOT replace a checked one: somebody is waiting to
    // learn whether those exact bytes landed, and replacing them makes that
    // question unanswerable except by lying.
    if (!checked && trailing && !trailing.checked) {
      clearTimeout(trailing.timer)
      const replaced = trailing.generation
      list[list.length - 1] = { data: session, timer, generation, checked: false }
      // The replaced generation is gone and nothing will write it, so anything
      // waiting on it is told so HERE rather than left to a later write's
      // success. Unreachable today — only `enqueueChecked` hands out receipts
      // and those entries are never the ones replaced — and kept because
      // "a receipt may be answered by somebody else's write" is exactly the
      // assumption that produced false positives, and it should be untrue by
      // construction rather than by that pairing holding.
      this.settleReceipts(key, replaced, { ok: false, error: 'session write superseded', reason: 'superseded' })
    } else {
      list.push({ data: session, timer, generation, checked })
    }
    this.queued.set(key, list)
    // The newest local state we have been handed, for the observation baseline.
    // Recorded here rather than at commit time because a debounced write is
    // local state that already exists — see `lastEnqueuedMetadata`.
    this.lastEnqueuedMetadata.set(key, getHeaderMetadataFields(session))
    return generation
  }

  /**
   * Enqueue and hand back a receipt for THIS snapshot.
   *
   * `flush` cannot report whether a write committed: `write` catches its own errors so the
   * fire-and-forget callers that make up nearly all of this queue's traffic
   * keep working, which leaves a failed write indistinguishable from a
   * successful one to anyone awaiting it. A caller that tells a user
   * "delivered and saved" needs the difference, and guessing optimistically is
   * the one answer it must never give.
   *
   * The receipt is tied to THIS generation and no other — see I4. An earlier
   * revision let a later write satisfy it, on the reasoning that a newer
   * snapshot contains the older one; that is true of today's callers and is not
   * something a durability answer may rest on, and it reported success for
   * bytes nobody had written. A caller waits on its own bytes.
   *
   * Deliberately additive: `flush` and `enqueue` are untouched and every
   * existing caller keeps its best-effort behaviour.
   */
  enqueueChecked(session: StoredSession): SessionWriteHandle {
    const key = sessionWriteKey(session.workspaceRootPath, session.id)
    if (this.closing) {
      // Answered immediately and negatively. A receipt is a durability claim,
      // and the one claim it must never make is an optimistic one.
      return {
        key,
        generation: this.generations.get(key) ?? 0,
        receipt: Promise.resolve({ ok: false, error: 'session write refused: queue is closing', reason: 'refused' as const }),
      }
    }
    const generation = this.enqueueEntry(session, { checked: true, reconciliation: false })
    return { key, generation, receipt: this.receiptFor(key, generation) }
  }

  /**
   * Resolve once THIS generation has been written, has failed, or has been
   * cancelled — never on a later generation's outcome (I4). The `written >=`
   * shortcut below is an already-answered fast path, not a widening: it fires
   * only for a generation that was written before its receipt was asked for.
   */
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
    const preCancelled = this.cancelledThrough.get(key)
    if (cancelledThroughGeneration(preCancelled) >= generation) {
      const reason = cancellationReasonFor(preCancelled, generation)
      return Promise.resolve({ ok: false, error: `session write ${reason}`, reason })
    }
    const written = this.writtenGeneration.get(key) ?? 0
    if (written >= generation) {
      const prior = this.lastWriteFailure.get(key)
      return Promise.resolve(prior ? { ok: false, error: prior, reason: 'failed' as const } : { ok: true })
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
    if (!this.queued.has(key) && !this.tails.has(key)) {
      const prior = this.lastWriteFailure.get(key)
      return Promise.resolve<SessionWriteReceipt>(
        prior
          ? { ok: false, error: prior, reason: 'failed' }
          : { ok: false, error: 'session write superseded', reason: 'superseded' },
      )
    }

    return new Promise<SessionWriteReceipt>((settle) => {
      const waiters = this.receiptWaiters.get(key) ?? []
      waiters.push({ generation, settle })
      this.receiptWaiters.set(key, waiters)
    })
  }

  /**
   * Write every entry queued for this session, oldest first.
   *
   * A loop rather than one write per tail run, because a session can now hold
   * several entries: a checked write is not coalesced into, so an ordinary
   * write queues behind it instead of replacing it. One `flush` has to cover
   * all of them or it would return with work still outstanding.
   *
   * Re-reads the queue each time round, so an entry enqueued during a commit
   * is picked up by the same drain rather than waiting out its own debounce.
   */
  /** Stop every queued entry's debounce for this session; the caller drives them. */
  private clearQueuedTimers(key: SessionWriteKey): void {
    for (const entry of this.queued.get(key) ?? []) clearTimeout(entry.timer)
  }

  private async drainQueued(key: SessionWriteKey): Promise<void> {
    // Bounded to the work that existed when this drain BEGAN, deliberately. An
    // entry enqueued mid-drain — by a commit hook, or by a `persistSession`
    // that a watcher event triggered — is new work with its own debounce, and
    // sweeping it in here would move when it lands relative to the caller that
    // queued it. Not hypothetical: `applyExternalSessionMetadata` supersedes
    // and then persists from inside a commit boundary, and pulling that
    // replacement into the same drain made it consume the held observation one
    // write earlier than its caller expected, which wiped a merge-only field.
    //
    // Quit still catches late work: `flushAll` loops over a fresh union until a
    // round comes back empty, which is where "keep going until quiescent"
    // belongs.
    let remaining = this.queued.get(key)?.length ?? 0
    while (remaining-- > 0 && this.queued.get(key)?.length) {
      await this.write(key)
    }
  }

  /**
   * Run the queued writes for a session on its serialised tail.
   *
   * Chained with `.then(fn, fn)` so one failed write does not strand every
   * later write for that session behind a rejected promise.
   */
  private runOnTail(key: SessionWriteKey): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(
      () => this.drainQueued(key),
      () => this.drainQueued(key),
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
   */
  private retireIfQuiescent(key: SessionWriteKey): void {
    if (this.queued.has(key)) return
    if (this.tails.has(key)) return
    if (this.receiptWaiters.get(key)?.length) return
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
    // Retired WITH the generations, unlike the signature baseline below. It
    // describes local state that was waiting to be written, and at quiescence
    // there is none — every enqueued snapshot has been written or abandoned. An
    // observation taken later then baselines on the last committed metadata,
    // which at that point IS the newest local state.
    this.lastEnqueuedMetadata.delete(key)
    // `committedMetadata` is deliberately NOT retired here. It is not
    // generation bookkeeping — it is the live baseline for "did somebody else
    // change this header since we last wrote it", and it has to outlive
    // quiescence because that is exactly when an external edit happens. Drop it
    // and two things break at once: the next write sees no previous baseline,
    // concludes nothing external changed, and clobbers the other writer's
    // metadata; and `ConfigWatcher` loses its self-echo baseline and treats our
    // own write as a foreign change. It is removed only on explicit deletion,
    // where the session itself is going away.
    //
    // `inFlightSignature` is not retired here either, for the opposite reason:
    // by definition nothing is in flight at quiescence, so there is nothing to
    // retire. Every write clears its own on the way out.
  }

  /** Per-session bookkeeping sizes, for tests that assert nothing leaks. */
  diagnostics(): Record<string, number> {
    return {
      queued: this.queued.size,
      tails: this.tails.size,
      generations: this.generations.size,
      writtenGeneration: this.writtenGeneration.size,
      cancelledThrough: this.cancelledThrough.size,
      receiptWaiters: this.receiptWaiters.size,
      lastWriteFailure: this.lastWriteFailure.size,
      // Every per-key map appears here. A leak test can only assert on what
      // it can see, so an omitted map is a map nothing is watching — and
      // `lastEnqueuedMetadata` and `pendingExternalMetadata` in particular grow
      // on paths that do not have to end in a write.
      committedMetadata: this.committedMetadata.size,
      inFlightSignature: this.inFlightSignature.size,
      lastEnqueuedMetadata: this.lastEnqueuedMetadata.size,
      pendingExternalMetadata: this.pendingExternalMetadata.size,
    }
  }

  /**
   * Settle receipts, matching EXACTLY the generation that produced this outcome.
   *
   * Not "every generation at or below it". A receipt is a claim about one
   * snapshot's bytes, and borrowing a later write's success to answer it
   * assumes the later snapshot contained the earlier one — true for the callers
   * we have, and not something a durability answer may rest on. With each
   * checked snapshot now getting its own uncoalesced write, the exact question
   * always has an exact answer.
   *
   * Cancellation is the one range operation, and it passes `through` to cover
   * every generation the watermark reached.
   *
   * Honest standing: with checked snapshots no longer coalescable, `exact` and
   * the old `<=` are indistinguishable today. Entries are shifted oldest-first
   * and every settle site passes the entry's own generation, so a waiter for
   * generation M is always answered by M's own outcome before any later one
   * runs; the only route that skips a generation's write is cancellation, which
   * uses `through`. Switching this back to `<=` changes no test. It stays
   * because "a receipt may be answered by a LATER write's success" is the
   * assumption that produced the false positives in the first place, and it
   * should be untrue by construction rather than by the FIFO staying the way it
   * is.
   */
  private settleReceipts(
    key: SessionWriteKey,
    generation: number,
    receipt: SessionWriteReceipt,
    match: 'exact' | 'through' = 'exact',
  ): void {
    const waiters = this.receiptWaiters.get(key)
    if (!waiters?.length) return
    const remaining: ReceiptWaiter[] = []
    for (const waiter of waiters) {
      const covered = match === 'exact' ? waiter.generation === generation : waiter.generation <= generation
      if (covered) waiter.settle(receipt)
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
    const list = this.queued.get(key)
    const entry = list?.shift()
    if (!list || !entry) return true
    if (!list.length) this.queued.delete(key)
    const { generation } = entry

    // Cancelled between enqueue and execution: do not write at all. Nothing was
    // committed, so the intent does not matter here — there is no artifact to
    // keep or discard either way.
    if (cancelledThroughGeneration(this.cancelledThrough.get(key)) >= generation) {
      debug(`[PersistenceQueue] Skipped cancelled write for ${entry.data.id}`)
      this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
      const reason = cancellationReasonFor(this.cancelledThrough.get(key), generation)
      this.settleReceipts(key, generation, { ok: false, error: `session write ${reason}`, reason })
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
      const observedExternal = this.pendingExternalMetadata.get(key)
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const committedBaseline = this.committedMetadata.get(key)
      const previousSig = committedBaseline === undefined ? undefined : JSON.stringify(committedBaseline)
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
        lastWritten: committedBaseline,
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

      // Atomic write: write to .tmp then rename over the real file. If the
      // process crashes mid-write only the .tmp is corrupted — the original
      // session.jsonl remains intact.
      //
      // The signature published here is IN-FLIGHT only, for fs.watch echo
      // suppression — I3. Nothing may read it as "what is on disk"; the
      // committed baseline is promoted by the successful rename below, and by
      // nothing else.
      this.inFlightSignature.set(key, getHeaderMetadataSignature(header))

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
      const abandonIfCancelled = async (stage: WriteStage): Promise<boolean> => {
        const watermark = this.cancelledThrough.get(key)
        if (cancelledThroughGeneration(watermark) < generation) return false
        // THIS generation's intent, not the session's ever-set flags.
        const discardCommitted = (watermark?.deleteThrough ?? 0) >= generation

        // `target-removed` is the one stage where abandoning is not a safe
        // no-op, and it took a review to see it. By this point the target has
        // ALREADY been unlinked — by us, for Windows, where rename refuses an
        // existing destination. Deleting the replacement here and returning
        // therefore leaves the session with no file at all, which is exactly
        // the outcome a supersede exists to prevent, arrived at from the other
        // direction: the earlier fix stopped supersede unlinking a committed
        // file, and this one stops it walking away from a target it had already
        // removed. The replacement write is debounced and swallows its errors,
        // so the gap is not hypothetical — a crash inside it loses the session.
        //
        // So under a keep-the-file intent this stage does not abandon at all.
        // The rename completes, the stale bytes land, and the caller's merged
        // write replaces them a moment later. Stale-then-replaced is what this
        // path did before any cancellation check existed; absent is new damage.
        // The receipt still reports cancelled from the commit stage below, so
        // no caller is told these bytes were its own.
        //
        // A deletion still abandons here: the file is meant to be gone.
        if (stage === 'target-removed' && !discardCommitted) return false

        // The temp file is this generation's private scratch space and is
        // always ours to remove, under either intent.
        try { await unlink(tmpFile) } catch { /* may not exist */ }
        if (stage === 'committed' && discardCommitted) {
          // Deletion only. The rename already happened, so remove what it
          // produced — otherwise a session the caller deleted stays on disk.
          //
          // Emphatically NOT done for a supersede: there the file is a LIVE
          // session's, the caller is about to write merged fresh state over it,
          // and unlinking would delete real data and leave the session absent
          // from disk until the replacement write lands.
          try { await unlink(filePath) } catch { /* may not exist */ }
        }
        debug(`[PersistenceQueue] Abandoned cancelled write for session ${data.id} (stage=${stage})`)
        // Nothing to unwind. The committed baseline is only ever promoted by
        // a successful rename, so an abandoned generation never touched it —
        // that is the point of splitting the two fields, and it is why this
        // path no longer has to reason about whether its bytes reached disk.
        //
        // The in-flight echo value does have to go, or `getLastWrittenSignature`
        // keeps answering with a header nobody wrote.
        this.inFlightSignature.delete(key)
        // A deletion that unlinked the committed file takes the baseline with
        // it: there is no session left for it to describe.
        //
        // Honest standing: a STRUCTURAL BACKSTOP with no reachable path today,
        // labelled rather than claimed as tested. Promotion happens immediately
        // after the rename and therefore BEFORE the `afterRename` hook, and a
        // hook is the only way a cancel can land inside a commit — so
        // `cancelForDeletion`, which clears the baseline itself, always runs
        // after the promotion it would need to undo. Removing this line changes
        // no test. It stays because "a deleted session leaves no baseline" is
        // the kind of invariant that should not depend on that ordering
        // continuing to hold.
        if (stage === 'committed' && discardCommitted) this.committedMetadata.delete(key)
        this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
        const abandonReason = cancellationReasonFor(watermark, generation)
        this.settleReceipts(key, generation, { ok: false, error: `session write ${abandonReason}`, reason: abandonReason })
        return true
      }

      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await this.commitHooks?.beforeUnlink?.(key)
      if (await abandonIfCancelled('intact')) return false

      // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
      try { await unlink(filePath) } catch { /* ignore if doesn't exist */ }
      await this.commitHooks?.beforeRename?.(key)
      if (await abandonIfCancelled('target-removed')) return false

      await rename(tmpFile, filePath)
      // COMMITTED. The bytes are on disk, so this is the one place the baseline
      // advances — including when the cancellation check just below abandons
      // this generation under a keep-the-file intent, because that path leaves
      // these bytes in place and the baseline has to go on describing them.
      this.committedMetadata.set(key, getHeaderMetadataFields(header))
      this.inFlightSignature.delete(key)
      await this.commitHooks?.afterRename?.(key)
      if (await abandonIfCancelled('committed')) return false

      debug(`[PersistenceQueue] Wrote session ${data.id}`)
      // Landed, so the observation has been discharged. Deliberately NOT done
      // on the abandon paths: a write that never committed has not carried the
      // edit anywhere, and dropping it there would lose it for good.
      if (observedExternal && this.pendingExternalMetadata.get(key) === observedExternal) {
        this.pendingExternalMetadata.delete(key)
      }
      this.lastWriteFailure.delete(key)
      // This session's state IS on disk now, so an earlier failure in the same
      // drain has nothing left to report — see `closingWriteFailures`.
      this.closingWriteFailures.delete(key)
      this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
      this.settleReceipts(key, generation, { ok: true })
      return true
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${entry.data.id}:`, error)
      // Recorded, not thrown. Existing callers are fire-and-forget and must not
      // start failing; a receipt is the opt-in way to learn about this.
      const message = error instanceof Error ? error.message : String(error)
      // The write did not land, so the speculative baseline is a claim about
      // bytes that do not exist. Left standing, the NEXT write reads the
      // untouched file as an external edit and lets disk overwrite the local
      // state this one failed to save.
      // Never promoted, so there is nothing to undo — only the in-flight echo
      // value to withdraw.
      this.inFlightSignature.delete(key)
      this.lastWriteFailure.set(key, message)
      // A failure inside the shutdown drain is the one nobody else can see: the
      // receipt holders have already been answered by this point, and an
      // ordinary write has none. Recorded so `flushAll` can refuse to report a
      // clean shutdown over it.
      if (this.closing) this.closingWriteFailures.set(key, `${entry.data.id}: ${message}`)
      // Marked attempted either way, so a waiter learns the outcome promptly
      // instead of hanging until some later write happens to supersede it.
      // Failure is an answer; silence is not.
      this.writtenGeneration.set(key, Math.max(this.writtenGeneration.get(key) ?? 0, generation))
      this.settleReceipts(key, generation, { ok: false, error: message, reason: 'failed' })
      return false
    }
  }

  /**
   * Immediately flush a specific session, on its serialised tail (I1):
   * whatever is already running for it finishes first and this follows it,
   * never alongside.
   */
  async flush(key: SessionWriteKey): Promise<void> {
    if (!this.queued.has(key) && !this.tails.has(key)) return
    this.clearQueuedTimers(key)
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
    this.clearQueuedTimers(key)
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
    this.stopPendingWrites(key, 'delete')
    // Safe here and only here: the session is gone, so no later write can need
    // this baseline to detect an external edit.
    this.committedMetadata.delete(key)
    this.inFlightSignature.delete(key)
    this.lastEnqueuedMetadata.delete(key)
    this.lastWriteFailure.delete(key)
    this.pendingExternalMetadata.delete(key)
    // Drop the bookkeeping, but only if nothing is still in flight. Deleted
    // sessions would otherwise leave an entry in every map for the life of the
    // process; a session with a live tail retires when that tail drains.
    this.retireIfQuiescent(key)
  }

  /**
   * Stop stale writes from committing over fresher state, WITHOUT touching the
   * session's file (I2): in-flight writes carrying pre-edit state must lose,
   * and the live session's file must survive.
   *
   * The committed baseline is deliberately KEPT. It is the input to `write`'s
   * external-change detection (`hasExternalMetadataChange` needs a previous
   * baseline), and dropping it here would make the very next write see no
   * divergence, conclude nothing external changed, and clobber the edit this
   * call exists to protect.
   *
   * **Which fields actually depend on it, checked rather than assumed.** Of the
   * seven merged fields, `applyExternalSessionMetadata` copies SIX into the
   * managed session — `name`, `labels`, `isFlagged`, `sessionStatus`,
   * `lastReadMessageId`, `hasUnread` — so for those the outgoing header already
   * carries the external value and the merge is belt-and-braces. Exactly ONE is
   * not mirrored: **`permissionMode`**, deliberately, because it is a
   * declared-intent mutation with its own event and ADR-0021 emit rules. For
   * that field the merge is the ONLY route by which an external edit reaches
   * disk.
   *
   * An earlier version of this comment named three such fields. It was written
   * before read-state mirroring was added to that method and was never updated
   * — the two are now mirrored, and a test that picked `lastReadMessageId` as
   * its merge-only field was silently proving less than it claimed. Re-derive
   * this list from the method rather than trusting a comment, this one included.
   */
  supersedePendingWrites(key: SessionWriteKey, observedHeader?: SessionHeader): void {
    this.stopPendingWrites(key, 'supersede')
    // Hold what the caller actually saw, AND what we had when it saw it. The
    // second half is what stops a remembered external value from beating an
    // in-app change made after the observation — see `ExternalObservation`.
    //
    // Newest observation wins: it is the more recent view of the same external
    // writer, and it re-baselines against whatever we have written since.
    if (observedHeader) {
      this.pendingExternalMetadata.set(key, {
        external: getHeaderMetadataFields(observedHeader),
        // The newest local state, committed or merely enqueued — NOT the last
        // committed one. A debounced local change is local state that already
        // happened; baselining behind it makes it look like a post-observation
        // edit and lets it beat a newer external change. Falls back to the last
        // write for a session with nothing in the queue.
        localAtObservation: this.lastEnqueuedMetadata.get(key) ?? this.committedMetadata.get(key),
      })
    }
    // No retirement sweep and no baseline drop: this session is live, is about
    // to be written again, and its baseline is load-bearing for that write.
  }

  /**
   * Shared core of both intents: raise the watermark and settle anything
   * waiting on the generations it now covers.
   */
  private stopPendingWrites(key: SessionWriteKey, intent: 'delete' | 'supersede'): void {
    const queued = this.queued.get(key)
    if (queued?.length) {
      const id = queued[0]!.data.id
      this.clearQueuedTimers(key)
      this.queued.delete(key)
      debug(`[PersistenceQueue] Cancelled ${queued.length} pending write(s) for session ${id}`)
    }
    // Set regardless of whether anything was pending: the write that matters
    // here is the one already on the tail, which `pending` no longer holds.
    // Everything enqueued up to now is cancelled; anything enqueued after is
    // a higher generation and unaffected.
    //
    // Each intent raises only its OWN watermark, and only ever upward. That is
    // what keeps both orderings safe — a supersede after a deletion cannot
    // un-delete, a deletion after a supersede still discards — while confining
    // "discard the artifact" to the generations a deletion actually covered.
    // The flag this replaced described the session, so it leaked a deletion's
    // intent onto every later generation, including a supersede's.
    //
    // Honest standing of the two `Math.max` calls: they are STRUCTURAL
    // BACKSTOPS with no reachable path today, because `generations` only ever
    // shrinks in `retireIfQuiescent`, which deletes `cancelledThrough` in the
    // same breath — so no state exists where a lower generation count meets a
    // surviving watermark. They stay because the invariant should hold by
    // construction rather than by that adjacency continuing to be true.
    const previous = this.cancelledThrough.get(key)
    const reached = this.generations.get(key) ?? 0
    this.cancelledThrough.set(key, {
      deleteThrough: intent === 'delete'
        ? Math.max(previous?.deleteThrough ?? 0, reached)
        : (previous?.deleteThrough ?? 0),
      supersedeThrough: intent === 'supersede'
        ? Math.max(previous?.supersedeThrough ?? 0, reached)
        : (previous?.supersedeThrough ?? 0),
    })

    // Anything holding a receipt for a cancelled generation must be told rather
    // than left hanging, and telling them is also what makes the session
    // eligible for retirement — the order is load-bearing, not cosmetic.
    const broadcastReason = intent === 'delete' ? 'deleted' as const : 'superseded' as const
    this.settleReceipts(
      key,
      Number.MAX_SAFE_INTEGER,
      { ok: false, error: `session write ${broadcastReason}`, reason: broadcastReason },
      'through',
    )
  }

  /**
   * Close the queue and drain it. Call this on app quit.
   *
   * **Shutdown is a claim, and this method has to be able to fail.** The
   * previous version drained the union it found and then, if a bound was hit,
   * logged and returned normally — so a caller that awaited it and printed
   * "flushed all pending session writes" printed that whether or not anything
   * was still outstanding. A false success at shutdown is the worst kind: the
   * process exits, the writes are gone, and the log says otherwise.
   *
   * So it does two things in order, and either finishes or throws:
   *
   * 1. **Freezes ORDINARY intake** (`closing`). Draining while producers keep
   *    enqueueing is chasing a moving target; refusing new work first is what
   *    makes quiescence reachable at all. Refused callers are told — see
   *    `enqueueChecked`.
   *
   *    One path is exempt: `enqueueReconciliation`, the replacement write that
   *    follows a supersede. Refusing that half would make absorbing an external
   *    edit DESTROY it, because the supersede has already cancelled the write
   *    that would have carried it. It is drained like anything else, and it is
   *    bounded by the same rounds, so a watcher that keeps producing fails the
   *    shutdown rather than extending it forever.
   * 2. **Drains to true quiescence** — queued keys AND active tails, because a
   *    write already lifted onto its tail is precisely the one a quit must wait
   *    for: it may sit between the unlink and the rename, where the session has
   *    no file at all. Re-taken each round, because finishing one write can
   *    produce another (a commit hook, a watcher-triggered persist).
   *
   * The round bound exists so a pathological producer cannot hang quit forever.
   * Reaching it is a FAILURE and throws; it is not an escape hatch. A caller
   * that wants to exit anyway must catch it and say so, rather than inheriting
   * a success it did not get.
   *
   * Idempotent for the already-quiet case. Reopening is deliberately explicit —
   * see {@link reopenAfterFlushAll}; a normal process never reopens, it exits.
   */
  async flushAll(): Promise<void> {
    this.closing = true
    let quiescent = false
    for (let round = 0; round < FLUSH_ALL_MAX_ROUNDS; round++) {
      const keys = new Set([...this.queued.keys(), ...this.tails.keys()])
      if (!keys.size) { quiescent = true; break }
      await Promise.all([...keys].map(key => this.flush(key)))
    }

    // Two different ways a shutdown is unclean, reported TOGETHER. Throwing on
    // the first one found would hide the other, and they answer different
    // questions: whether the queue stopped, and whether what it drained landed.
    const problems: string[] = []
    if (!quiescent) {
      const stragglers = new Set([...this.queued.keys(), ...this.tails.keys()])
      if (stragglers.size) {
        problems.push(
          `did not reach quiescence: ${stragglers.size} session(s) still writing after ${FLUSH_ALL_MAX_ROUNDS} drain rounds`,
        )
      }
    }
    // Read AND cleared: the ledger answers for this shutdown, and a host that
    // catches the throw and reopens must not inherit it.
    const failed = [...this.closingWriteFailures.values()]
    this.closingWriteFailures.clear()
    if (failed.length) {
      problems.push(`${failed.length} session write(s) failed during the drain — ${failed.join('; ')}`)
    }
    if (problems.length) {
      throw new Error(`Session persistence ${problems.join(' | ')}`)
    }
  }

  /**
   * Re-open a closed queue.
   *
   * Exists for two callers and no others: a test process that shares this
   * singleton across suites (one suite exercising the quit path would otherwise
   * refuse every later suite's writes), and a host that genuinely aborts a
   * shutdown it had started. A real quit never calls this — it exits.
   */
  reopenAfterFlushAll(): void {
    this.closing = false
  }

  /** Whether intake is frozen for shutdown. */
  get isClosing(): boolean {
    return this.closing
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(key: SessionWriteKey): boolean {
    return this.queued.has(key)
  }

  /**
   * Whether this session has work QUEUED or IN FLIGHT.
   *
   * The question a shutdown actually needs: "is there already a write for this
   * session that the drain will carry?" If yes, the state is covered and
   * re-persisting it would rewrite a record that is already on its way. If no,
   * and nothing has changed in memory, there is nothing to write at all.
   *
   * `hasPending` alone cannot answer it — a write lifted onto its tail is no
   * longer queued but is very much outstanding.
   */
  hasPendingOrTail(key: SessionWriteKey): boolean {
    return this.queued.has(key) || this.tails.has(key)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(key: SessionWriteKey): string | undefined {
    // In-flight first: during a write, the echo the watcher is about to see is
    // the header being written, not the one before it. Once the write settles
    // the in-flight value is gone and the committed baseline answers — and on
    // the success path the two are identical anyway.
    const inFlight = this.inFlightSignature.get(key)
    if (inFlight !== undefined) return inFlight
    const committed = this.committedMetadata.get(key)
    return committed === undefined ? undefined : JSON.stringify(committed)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.queued.size
  }
}

/**
 * The commit hooks currently installed on the shared queue, plus the token that
 * owns them.
 *
 * A STACK of owners rather than a single slot, because "clear the hooks" is the
 * operation that goes wrong. An unconditional `set(undefined)` in one suite's
 * `afterEach` clears whatever is installed — including a later suite's hooks if
 * the first one's teardown runs late, which turns a leak into a silent loss of
 * the very seam the second suite depends on. Every install therefore captures
 * the owner it displaced and hands back a disposer that restores it, and a
 * disposer whose token is no longer current does NOTHING.
 */
type SingletonHookOwner = { token: symbol; hooks: SessionCommitHooks; previous?: SingletonHookOwner }
let singletonHookOwner: SingletonHookOwner | undefined

/**
 * Install commit hooks on the shared queue and return a disposer.
 *
 * **Test-only**, and off the package barrel — reach it through
 * `@craft-agent/shared/sessions/internal`.
 *
 * The seam exists at all because `storage.ts:saveSession` and `SessionManager`
 * must share ONE queue instance: they write the same files, and two instances
 * would mean two tails over one `.tmp`, which is the race this whole unit
 * exists to prevent (I1). So a SessionManager-level test cannot be handed its
 * own queue, and a shared instance is the only thing left to hook. Suites that
 * own their queue should construct it with hooks instead and never come here.
 *
 * Contract:
 *
 * - The returned disposer is the ONLY way to uninstall. It is idempotent, and
 *   it restores the owner this install displaced rather than clearing outright.
 * - A disposer that is no longer the current owner is a no-op, so a late
 *   teardown cannot strip a newer suite's hooks.
 * - Refuses outside a test runner, so a production process cannot be talked
 *   into stalling every session write through an awaited hook.
 */
export function installSingletonCommitHooksForTesting(hooks: SessionCommitHooks): () => void {
  // Runtime guard, not a type. `readonly` and naming conventions are erased or
  // ignorable; this is not.
  if (!isTestRunner()) {
    throw new Error('installSingletonCommitHooksForTesting is test-only and refuses to run outside a test runner')
  }
  const token = Symbol('singleton-commit-hooks')
  singletonHookOwner = { token, hooks, previous: singletonHookOwner }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // Unwind only if still ours. If a later install is on top, removing this
    // owner from the middle of the stack would be worse than leaving it: the
    // current hooks stay current either way, and the later disposer restores
    // what IT displaced.
    if (singletonHookOwner?.token === token) {
      singletonHookOwner = singletonHookOwner.previous
      return
    }
    // Not current: drop ourselves from the chain so the stack does not keep a
    // disposed owner that a later unwind could restore.
    for (let owner = singletonHookOwner; owner; owner = owner.previous) {
      if (owner.previous?.token === token) {
        owner.previous = owner.previous.previous
        return
      }
    }
  }
}

/**
 * The hooks currently installed on the shared queue, or undefined.
 *
 * Read-only, and exists so the ownership contract above can be TESTED — the
 * instance deliberately has no settable property, so there is otherwise nothing
 * to observe. Off the barrel with the installer.
 */
export function currentSingletonCommitHooksForTesting(): SessionCommitHooks | undefined {
  return singletonHookOwner?.hooks
}

/**
 * Whether the process is running under a test runner.
 *
 * `NODE_ENV === 'test'` and nothing else, verified by probe rather than assumed:
 *
 * - `bun test` sets `NODE_ENV=test`; plain `bun run` leaves it undefined.
 * - `typeof Bun.jest` is `'function'` under plain `bun run` TOO, so an earlier
 *   version of this guard admitted every plain-bun process — which is exactly
 *   the production case for the headless server and `pi-agent-server`. A guard
 *   that permits production is not a guard.
 * - `BUN_TEST` is unset in both, so it never contributed anything.
 *
 * A positive check for a test environment, never a negative check for
 * production: an unset or unrecognised environment must refuse, not permit.
 */
function isTestRunner(): boolean {
  return process.env.NODE_ENV === 'test'
}

// Singleton instance. Constructed with hooks that delegate to the holder above,
// so the instance exposes nothing assignable.
export const sessionPersistenceQueue = new SessionPersistenceQueue(500, {
  beforeUnlink: (key) => singletonHookOwner?.hooks.beforeUnlink?.(key),
  beforeRename: (key) => singletonHookOwner?.hooks.beforeRename?.(key),
  afterRename: (key) => singletonHookOwner?.hooks.afterRename?.(key),
})

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, resolveExternalMetadata }
