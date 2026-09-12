---
id: SUV-0066
title: Serialize workspace-qualified session persistence with owner receipts
status: in-progress
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-12
updated: 2026-09-12
related: [ADR-0033, SUV-0064]
blocked-by: []
---

# SUV-0066 — Serialize workspace-qualified session persistence with owner receipts

## Goal

Key every piece of session-persistence state on workspace + session id, serialize
all writes for a key onto one tail, and split "stop these writes" into deletion
and supersede — so a copied workspace cannot delete another's transcript and an
external metadata edit cannot be reverted by a write already in flight.

## Scope

- `packages/shared/src/sessions/persistence-queue.ts` — the unit:
  - `SessionWriteKey` = `sessionWriteKey(resolve(root), sessionId)`, a branded
    JSON tuple. Injective where the session file path is not.
  - One per-key write tail. Every write chains onto it; a shared `.tmp` path
    makes concurrency a correctness problem, not a fairness one.
  - Owner receipts over a per-key FIFO (`enqueueChecked` → `SessionWriteHandle`).
    Ordinary writes still coalesce into a trailing ordinary entry; a checked
    entry is never coalesced into, and receipts settle on the exact generation,
    so a receipt attests its own bytes rather than borrowing a later write's
    success. `ok: true` means committed, not power-loss durable.
  - Cancellation as two per-intent watermarks: `cancelForDeletion` discards a
    committed artifact, `supersedePendingWrites` never does. Re-checked at
    every commit boundary, and the check is **stage-aware** — between the
    Windows-compat unlink and the rename there is no target left, so a
    supersede completes the rename instead of walking away from nothing.
  - `resolveExternalMetadata` — one merge point, per-field authority
    (app-since-observation > disk-since-our-write > retained observation > local).
  - `lastWrittenHeaderSignature` outlives quiescence; dropped only on deletion.
    Set speculatively before the write for fs.watch self-echo detection, and
    **restored on every non-committing branch** — only a successful rename
    advances the committed baseline.
  - `flushAll` awaits queued keys **and active tails**, looping to quiescence,
    so quit cannot return with a session mid-commit.
- `packages/shared/src/sessions/{storage,types,index}.ts` — header passthrough
  for `pendingPlanExecution`, key-aware `saveSession`, exports.
- `packages/server-core/src/sessions/SessionManager.ts` — `writeKeyFor` and all
  13 rekeyed call sites; `applyExternalSessionMetadata` supersedes on the full
  header signature; read-state mirroring; the four pending-plan owners keep the
  managed mirror in step; `managedToSession` omits `pendingPlanExecution`.
- Tests: the checked-persistence suite (shared), the external-metadata supersede
  suite and the pending-plan mirror suite (server-core).

**Deliberately out.** Nothing Page- or callback-shaped: no session descriptor,
executor, grant, bridge, UI, status origin, callback reservation, or
`tryDeliverPageCallback`. This unit compiles and tests standalone on `main` and
exposes only the queue-level API SUV-0064 will consume. The SessionManager-side
adapters over that API (`buildStoredSession`, `enqueuePersistChecked`,
`persistSessionChecked`) are left to SUV-0064, where their second caller appears.

**Not folded in.** `permissionMode` is deliberately not mirrored into memory by
the watcher path — it is a declared-intent mutation with its own event and
ADR-0021 emit rules. Disk keeps the external value via the merge; in-memory mode
stays owned by the mode-change path. Recorded here rather than smuggled in.

## Acceptance

- [x] `packages/shared` and `packages/server-core` typecheck clean; the brand
      forced all 13 SessionManager call sites and 3 in `packages/shared/tests/`.
- [x] Two workspaces holding one session id keep independent snapshots,
      receipts, baselines and observations; a deletion in one cannot unlink the
      other's committed file mid-commit.
- [x] The full stage x intent grid holds: a supersede at any of the three
      commit boundaries leaves the session present, a deletion leaves it absent,
      and neither ordering of the two can undo the other.
- [x] `applyExternalSessionMetadata` supersedes on a pure merge-only edit that
      changes nothing in memory, and does not strip the signature baseline.
- [x] `pendingPlanExecution` survives the cold-load projection and an unrelated
      persist; `draftInputSnapshot` appears in no wire projection.
- [x] Observation baseline resolves both directions: an external edit landing
      during an uncommitted local change wins, and an in-app change made after
      the observation wins, on both merge-only fields.
- [x] Quit waits: `flushAll` and the real `SessionManager.flushAllSessions()`
      both return only after a write caught between the unlink and the rename
      has committed, and `flushAll` picks up work queued while it drains.
- [x] A write that fails or is abandoned does not advance the committed
      baseline: the next local write of B lands B rather than reverting to
      disk's A, including for a supersede carrying no observed header.
- [x] A checked receipt never reports success for a snapshot that was replaced,
      and consecutive ordinary writes still coalesce to one disk write.
- [x] `diagnostics()` exposes every per-key map; an aged-out observation for a
      session that is never written again is swept by unrelated activity.
- [x] Ids that name one file share one key and tail (`nested/same` == `same`),
      while the same canonical id under different roots stays separate.
- [x] A failed rename does not advance the committed baseline; an abandoned
      write withdraws its in-flight echo value and leaves no map entry.
- [x] An observation survives unrelated activity indefinitely and is released
      only by its owning commit or by explicit deletion.
- [x] Mutation harness run against every guard: 12 rounds pre-review (10 caught,
      1 fixed by adding the cold-load test, 1 labelled an unreachable backstop),
      3 rounds on the round-1 fixes, and 6 on the round-2 fixes — all caught.

## Review findings

### Round 3 — architecture review

Seven items; two were already satisfied by round 2 and verified rather than
re-implemented. Of the rest, one was a real defect I had introduced and missed.

1. **`SessionWriteKey` did not canonicalise the id the way the file path does.**
   `getSessionPath` runs the id through `sanitizeSessionId` (a `basename`) as
   path-traversal defence, so `nested/same` and `same` address ONE file — and
   keying on the raw string gave them two keys, two tails, and two writers over
   one `.tmp`. The lost-bytes race this key exists to prevent, reintroduced from
   the other direction. Both now use the same canonicaliser.
2. **One committed baseline, split from the fs-watch echo value.** The
   speculative-set-then-restore machinery from round 2 is gone: `inFlightSignature`
   serves echo suppression and is cleared on every exit, `committedMetadata` is
   the single baseline and is promoted only by a successful rename. This also
   removed a duplicated signature/fields pair and the subtle
   "did our bytes reach disk" branch the restore needed.
3. **The observation TTL is removed, not fixed.** A five-minute drop discarded
   the only surviving copy of an external edit — data loss on a timer, and only
   for idle sessions. An observation is now released solely by its owning
   successful commit or by explicit deletion. It is normally short-lived because
   the only caller supersedes and then immediately persists. This deliberately
   reverses round 2's TTL-sweep item: preferring a bounded memory record over
   silent data loss.
4. **`pendingPlanExecution` is off the public metadata shape.** It rides the
   internal `SessionMetadataWithPendingPlan` instead, so unsent draft text is
   not within reach of the artifact scan, label and status queries, or anything
   that later decides to serialize a `SessionMetadata`.
5. **Commit hooks are constructor-injected and `readonly`.** The queue exposes
   no settable property. Honest residual below on why a named seam still exists
   for the shared singleton.
6. **P3:** the `beforeUnlink` deletion acceptance is now stated exactly rather
   than skipped, and the repeated rationale is collapsed into four named
   invariants (I1–I4) in the file header that the sites reference.

### Round 2 — independent review

### Round 2 — independent review

Four more findings, three of them correctness. Each was reproduced with a
failing test before being fixed, and each fix is mutation-verified.

1. **`flushAll` walked past writes already in flight.** It listed only queued
   keys, and `flush` returns immediately for a key it cannot see — so quit
   returned while a session was mid-commit, possibly between the unlink and the
   rename where the session has no file at all. Now the union of queued keys and
   active tails, looped until a round finds nothing, with a bounded round count
   so a pathological producer cannot hang quit. Probed at the queue level and
   through the real `SessionManager.flushAllSessions()` wiring.
2. **The self-echo baseline advanced speculatively and was never rolled back.**
   It is set before the write on purpose (fs.watch fires during unlink/rename
   and those events must read as ours), which makes it a claim about bytes that
   may never land. Left standing after a failed or abandoned write, the next
   write read the untouched file on disk as an external edit and the merge handed
   disk the win — so one failed write silently reverted the app's own unsaved
   change. The prior value is now captured before the try and restored on every
   non-committing branch.
3. **A checked receipt could report success for a snapshot that never
   existed.** With one coalescing slot per session, an ordinary `persistSession`
   landing between a checked enqueue and its write replaced it, and any later
   generation satisfied the receipt. Queued writes are now a FIFO per key:
   ordinary writes still coalesce into a trailing ordinary entry, a checked
   entry is never coalesced into, and receipts settle on the exact generation.
4. **Bounds and terminology.** `diagnostics()` now covers every per-key map
   (three were absent, so nothing was watching them); held observations are
   swept on TTL from every public entry point rather than only by the next write
   for their own session; and the receipt no longer claims durability it does
   not provide — `ok: true` means committed, with the missing `fsync` recorded
   as a residual instead of implied away.

### Round 1 — Greptile

Greptile returned 3/5 with two P1s and a P2. All three were valid; the first was
reproduced before being fixed.

1. **Supersede removed a live session.** The Windows-compat `unlink` of the
   target happens before the rename, so a supersede landing in that window
   abandoned the write with the old file already gone and the replacement
   deleted — the exact loss this SUV exists to prevent, reached from the other
   side. Cancellation is now stage-aware: under a keep-the-file intent the
   post-unlink stage completes the rename, and the caller's merged write
   replaces the stale bytes. Stale-then-replaced is what this path did before
   any cancellation check existed; absent was new damage.
2. **Observation baseline was the last COMMITTED metadata.** Local writes are
   debounced, so in-app state routinely sits uncommitted; baselining behind it
   made such a change look like a post-observation edit and wrote it over a
   newer external one. Now baselined on the newest ENQUEUED metadata.
3. **Release note lacked traceability.** `apps/electron/resources/AGENTS.md`
   requires issue reference and commit hash; four bullets were also more
   fragmentation than one SUV warrants. Consolidated to one traced bullet.

A third defect surfaced while fixing the first, from the orchestrator's read:
the single sticky `discardCommitted` flag described the **session**, not a
generation, so a deletion's intent leaked onto every later generation including
a supersede's. Split into per-intent watermarks. Constructing a test that can
observe it took two attempts — `retireIfQuiescent` erases the watermark the
moment a session goes idle, so the leak is only reachable under unbroken write
activity.

## Residuals

- **`ok: true` is committed, not power-loss durable.** No `fsync` on the temp
  file or the parent directory, so bytes and directory entry may still be in the
  page cache. Deliberate: this queue carries every session state change in the
  app, and two syncs per write buys a guarantee no current caller asks for.
  Revisit if a caller ever needs crash-consistency rather than write success.
- **A held observation has no time bound, by design.** It is released only by
  its owning successful commit or by explicit deletion, because it is the sole
  surviving copy of an external edit in the stale-write race and an age-based
  drop would discard user data rather than bound anything. What remains is one
  small record per session that received an external edit, was never
  successfully written again, and was never deleted — bounded by that anomaly
  rather than by traffic, and visible in `diagnostics()`.
- **The shared queue keeps one named test seam**
  (`setSingletonCommitHooksForTesting`). Hooks are otherwise constructor-only
  and `readonly`, and the instance exposes nothing assignable. The seam cannot
  be removed outright because `storage.ts:saveSession` and `SessionManager` must
  share ONE queue instance — they write the same files, and two instances would
  mean two tails over one `.tmp`, which is the race this unit exists to prevent.
  So a SessionManager-level test cannot be handed its own queue. It throws if
  hooks are already attached, so a leak between suites is loud.
- Exact-generation receipt matching is unreachable-by-construction today given
  the FIFO, and is kept as defence against coalescing being reintroduced.

- `commitHooks` is a public mutable test seam on a module singleton. Not
  reachable by a Page, a script action, or any RPC — no wire representation —
  but tightening it to a build-stripped seam is recorded, not silently accepted.
  Suites that set it must clear it in `afterEach`.
- The two watermarks' `Math.max` calls have no reachable path today; they hold
  an invariant that currently rests on `retireIfQuiescent` dropping
  `generations` and `cancelledThrough` together.
- `retireIfQuiescent`'s failure-evidence guard has no live reader. Kept because
  deleting a record of failure is the wrong default for the next reader; pinned
  as state, not as behaviour.

## Status log

- `2026-09-12` — created in `in-progress/`, extracted from PR #205 as a
  standalone prerequisite of SUV-0064. Id reserved via `refs/suv-ids/SUV-0066`
  (ADR-0030 CAS) after an all-refs floor scan agreeing with the console.
- `2026-09-12` — PR #206 opened; all twelve gates green.
- `2026-09-12` — review round 1 (Greptile 3/5): two P1 data-loss findings and
  one P2 traceability finding, all valid, all fixed with mutation-verified
  tests; plus a per-generation intent leak found while fixing the first.
- `2026-09-12` — review round 3 (architecture): the write key did not
  canonicalise the session id the way the file path does, so two ids naming one
  file raced; the committed baseline was split from the fs-watch echo value,
  retiring the speculative-restore machinery; the observation TTL was removed as
  data loss rather than a bound; pending-plan state moved off the public
  metadata shape; commit hooks became constructor-injected.
- `2026-09-12` — review round 2 (independent): quit walked past in-flight
  writes, the speculative self-echo baseline was never rolled back, and a
  checked receipt could attest a snapshot that was replaced before it was
  written. All three reproduced first, fixed, and mutation-verified; bounds and
  durability wording corrected alongside.
