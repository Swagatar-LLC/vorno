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
  - `SessionWriteKey` = `sessionWriteKey(resolve(root), sanitizeSessionId(id))`,
    a branded JSON tuple, canonicalised the way the file path is. Injective over
    those two strings — string identity, not filesystem identity; see Residuals.
  - One per-key write tail. Every write chains onto it; a shared `.tmp` path
    makes concurrency a correctness problem, not a fairness one.
  - Owner receipts over a per-key FIFO (`enqueueChecked` → `SessionWriteHandle`).
    Ordinary writes still coalesce into a trailing ordinary entry; a checked
    entry is never coalesced into, and receipts settle on the exact generation,
    so a receipt attests its own bytes rather than borrowing a later write's
    success. `ok: true` means committed, not power-loss durable (see Residuals).
  - Cancellation as two per-intent watermarks: `cancelForDeletion` discards a
    committed artifact, `supersedePendingWrites` never does. Re-checked at
    every commit boundary, and the check is **stage-aware** — between the
    Windows-compat unlink and the rename there is no target left, so a
    supersede completes the rename instead of walking away from nothing.
  - `resolveExternalMetadata` — one merge point, per-field authority
    (app-since-observation > disk-since-our-write > retained observation > local).
  - `inFlightSignature` (fs.watch echo suppression, published pre-write, cleared
    on every exit) split from `committedMetadata` — the ONE baseline, promoted
    only by a successful rename. It outlives quiescence, because that is exactly
    when an external edit happens, and is dropped only on deletion.
  - An observation is released only by its owning successful commit or by
    explicit deletion — never on a timer.
  - `flushAll` is shutdown: freeze ORDINARY intake (`closing`, refusing
    producers with a failed receipt), drain queued keys **and** active tails to
    true quiescence, and THROW rather than report a success it did not achieve.
    `enqueueReconciliation` is exempt — a supersede and its replacement are one
    operation, so refusing the replacement would make absorbing an external edit
    destroy it. Producers are also stopped before the close
    (`stopPersistenceProducers`), inside `flushAllSessions`, so all three hosts
    inherit the ordering.
- `packages/shared/src/sessions/{storage,types,index}.ts` — header passthrough
  for `pendingPlanExecution`, key-aware `saveSession`, exports; the public list
  readers strip the draft at runtime and `sessions/internal.ts` carries the
  off-barrel hydration reader and hook seam.
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
- [x] `pendingPlanExecution` survives the cold-load hydration and an unrelated
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
- [x] `diagnostics()` exposes every per-key map.
- [x] The public list readers return records with `pendingPlanExecution`
      deleted; the draft text appears in no serialized form of them, and the
      off-barrel internal reader still carries it for hydration.
- [x] A producer arriving after shutdown starts is refused with a receipt that
      says so; `flushAll` throws rather than reporting false success; reopening
      is explicit.
- [x] A watcher reconciliation arriving DURING the drain still lands — the
      shutdown waits for it — while an ordinary write at the same instant is
      refused; an endless reconciliation cycle fails the shutdown rather than
      extending it; and `flushAllSessions` stops the producers before closing,
      including each session's pending auto-retry timer.
- [x] A stale hook disposer cannot clear a newer owner's hooks; the seam admits
      only `NODE_ENV === 'test'` (probed: `Bun.jest` exists under plain bun) and
      a refused install leaves hooks unchanged.
- [x] `saveSession` resolves only when the bytes are on disk, and rejects both
      during a shutdown drain and on a genuine write failure.
- [x] A quit inside the 5s forced-turn-cleanup window cancels that timer, so it
      never persists after the freeze.
- [x] Shutdown aborts an active turn, waits for it, and its final assistant
      response reaches disk; no queued replay starts; a new send is refused; a
      turn that will not finish fails the shutdown instead of being closed over.
- [x] A final write superseded by a watcher reconciliation does not fail the
      shutdown — receipts distinguish `cancelled` from `failed`.
- [x] An active turn's final state is persisted even when an intermediate
      write is already queued for it.
- [x] A session mid-finalisation (flag already false, deferred still set) is
      selected for a checked final persist, not read as idle.
- [x] `markAllSessionsRead` saves the sessions it can, reverts the in-memory
      flag for the ones whose write failed so memory matches disk, emits the
      unread summary after those reverts, and reports a partial failure naming
      the sessions that failed.
- [x] A handoff interrupt (plan submit, auth request, auth retry) releases the
      finalisation deferred, so shutdown resolves promptly instead of waiting
      out its bound on a turn that merely paused.
- [x] Shutdown stays pending while a finaliser is parked after `isProcessing`
      has gone false, and the read-state and final response it writes are on
      disk before the queue closes.
- [x] A superseded final write is re-snapshotted and commits the merged state;
      when the replacement cannot land at all, shutdown rejects rather than
      reporting success.
- [x] 200 cold sessions are byte-identical after a quit — no rewrite, no
      `lastUsedAt` restamp, no hydration — while a session with queued work or
      an active turn still has its final state persisted, including a turn that
      ends without persisting itself.
- [x] `saveSession` reapplies its patch once when an external edit supersedes
      it (both changes survive) and never resurrects a deleted session.
- [x] A stuck turn still lets every other session's final state reach disk and
      still closes and drains the queue, and the shutdown still reports itself
      unclean.
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

### Review 10 — architecture: the finalisation boundary

1. **`isProcessing = false` is not "the turn is finished".** The stop handler
   clears it and then keeps going — browser visuals, read state, status, runtime
   teardown, the complete event — before the persist that records all of it.
   Waiting on the flag let shutdown resume mid-tail and close the queue
   underneath that write. Each turn now carries a finalisation deferred, created
   when processing starts and resolved in `onProcessingStopped`'s `finally`
   after every step, with a token so a slow finaliser cannot resolve or clear
   the deferred of the turn that started after it. Shutdown captures the
   deferreds BEFORE aborting — the abort is what makes them resolve — and awaits
   them; the `isProcessing` poll stays as the always-available fallback for a
   session that has no deferred.
2. **A cancelled final receipt is no longer accepted.** Treating `superseded` as
   "the replacement carries it" assumed the replacement would land, and it can
   fail — a disk error on the reconciliation's own write left nothing carrying
   the state while shutdown reported success. Supersession is now a bounded
   RETRY that re-snapshots from CURRENT managed state, so the reconciliation's
   merge is picked up and both changes commit. `deleted` stays terminal;
   `failed` is collected. The queue closes only after every session has an exact
   committed receipt.

Both wait mechanisms are deliberately redundant, which is why each survived
mutation alone and only removing both fails the test — recorded so the next
reader does not delete one as dead.

Greptile then caught what creating the deferred on every turn start implied: a
turn can stop WITHOUT being finalised. Plan submission and auth requests are
handoff interrupts — control moves to the UI, the flag goes false, and
`onProcessingStopped` is never reached — as is the auth-retry resend. Those left
a deferred nothing would settle, so shutdown burned its whole bound and then
reported a stuck turn that was not stuck. `setProcessing(false)` now releases
the deferred unless `finalizerRunning` marks the finaliser as the caller, which
is the one case where releasing would be the early-resolve the deferred exists
to prevent.

### Review 9 — security: shutdown scope and cancellation intent

1. **Shutdown was rewriting the whole workspace.** Persisting every loaded
   session hydrated hundreds of cold records from disk purely to write them back
   and restamped `lastUsedAt`, so idle sessions drifted up a recency-sorted list
   because the app closed. `collectSessionsNeedingFinalPersist` now defaults to
   SKIP: a session earns a final write only if it was processing or holds queued
   messages, and anything already queued or in flight is skipped because the
   drain carries it. Evaluated BEFORE quiescing — aborting turns is what makes
   every session look idle — which also removes a dependency on
   `onProcessingStopped` always enqueueing.
   Greptile then caught the filter's precedence backwards: it checked
   `hasPendingOrTail` before activity, and a streaming turn enqueues
   intermediate snapshots — so the check was true for exactly the sessions that
   most needed a final write, and shutdown drained a mid-turn snapshot while the
   completed response was never written. Activity is now checked first; an
   outstanding write proves some state is on its way, not that it is the state
   shutdown is waiting for.
2. **`cancelled` split into `superseded` and `deleted`.** They were one value
   until a caller needed to retry one and never the other: `saveSession` now
   reapplies its patch ONCE on a supersede (the queue's held observation merges
   both changes) and throws without retrying on a deletion, because retrying
   would resurrect a session the user deleted. Bounded to one retry — a second
   supersede means edits are arriving faster than writes complete, and looping
   would hide that.
3. **Batch loops no longer abandon the rest.** `saveSession` throwing is new, so
   `unbindSessionsFromProject` collects failures and reports a partial result
   instead of stopping at the first, and the two sync status/label migration
   loops — which call an async updater WITHOUT awaiting — now catch per session,
   so a rejection is neither unhandled nor invisible.

Adjacent-but-different handling, stated because the two look alike: shutdown's
final write does not retry a supersede (it is a whole-snapshot write that the
replacement already supersedes), while `saveSession` does (it carries a
caller's patch that would otherwise be collateral damage).

### Review 7 — architecture: shutdown producer completeness

The freeze and the producer sweep were still treating "stop the timers" as the
whole job. They are not: the thing most likely to write during shutdown is a
TURN — it has an agent streaming into it and an async finalisation that
persists. Shutdown is now an ordered sequence rather than a flush.

`flushAllSessions` does, in order: set `shuttingDown` (refusing new sends and
blocking queued replay) → stop the timers and watchers, **queue still open** →
abort every running turn and WAIT for each to finish tearing down → persist every
session's final state and await the EXACT receipts → only then close and drain.
Any step that cannot complete throws; host cleanup and exit belong strictly
after it resolves.

Greptile then caught a regression in the first version of the sequence: it threw
the moment a turn refused to finish, which skipped the final persist and the
drain entirely — so one stuck turn cost every OTHER session its last write,
while the hosts caught the error and exited anyway. Failing loudly had made the
data loss worse. Failures are now collected and thrown at the end, after the
salvage: a stuck turn costs its own session's completeness, not the process's.

Three things fell out of building it that are worth recording:

- **A cancelled final write is not a shutdown failure.** A watcher
  reconciliation landing during the drain supersedes the final persist, and the
  first version of this aborted the shutdown over it. `SessionWriteReceipt`
  failures now carry a `reason` (`cancelled` / `refused` / `failed`), and only
  `failed` means data may be lost. Comparing error strings would have been the
  fragile version of this.
- **`onProcessingStopped` still runs and still persists during shutdown; it just
  does not start the next turn.** Blocking the replay rather than the
  finalisation is the distinction — blocking both would discard the response the
  wait exists to save, and blocking neither makes draining a treadmill.

The test uses a real `SessionManager` with a fake agent whose abort drives the
REAL `onProcessingStopped`, so the final response landing on disk and the queued
replay not starting are both observed through the production path. Thin fakes no
longer survive the sequence, which is the sequence working.

### Review 6 — security final on the freeze

Three more, all consequences of the shutdown freeze rather than of the original
unit, and two of them cases where my own guard did not do what its comment said.

1. **`saveSession` reported successes it had not made.** It is the one awaited
   save API, and it used the fire-and-forget `enqueue` + `flush` pair — but a
   refused enqueue leaves nothing queued, and `flush` returns immediately for a
   key with no queued work and no tail. During a drain it therefore resolved
   having written nothing, telling pending-plan writes, status and label
   mutations, and any in-flight RPC or tool call that they had succeeded. Now
   routed through `enqueueChecked` and throws on a bad receipt.
2. **The test-runner guard admitted production.** It accepted
   `typeof Bun.jest !== 'undefined'`, and a probe shows that is `'function'`
   under plain `bun run` as well as `bun test` — so it admitted every plain-bun
   process, which is exactly how the headless server and `pi-agent-server` run.
   `BUN_TEST` was unset in both and contributed nothing. Now `NODE_ENV === 'test'`
   alone, which `bun test` sets and plain `bun` does not; a refused install
   leaves hooks unchanged.
3. **A second per-session producer.** The 5s forced turn-cleanup timer calls
   `onProcessingStopped`, which persists, and its handle was not stored. A quit
   inside that window fired it against a frozen queue. Stored on the managed
   session, cleared when the cleanup it backs up runs, and cancelled with the
   rest before the freeze.

The pattern worth naming: both missed producers hang off each managed session
rather than sitting in a workspace-keyed map, which is where the first sweep
looked. Anything on `ManagedSession` that schedules work is a producer.

### Review 5 — Greptile P1 on the shutdown freeze

Freezing intake (review 4, item 3) introduced a defect of its own, and Greptile
caught it: `flushAll` closed the queue while SessionManager's watchers were
still running, so a watcher-triggered reconciliation during the drain had its
supersede accepted and its replacement write REFUSED. The net effect of
absorbing an external edit became destroying it — the cancelled write was gone
and the stale file stood.

Fixed on both levels, because either alone leaves a gap:

- **`enqueueReconciliation`** is exempt from the freeze. A supersede and its
  replacement are two halves of one operation; only that path is exempt, and it
  is bounded by the same drain rounds, so a watcher stuck in a cycle fails the
  shutdown loudly rather than extending it.
- **`stopPersistenceProducers()`** runs at the top of `flushAllSessions`, before
  the close. Doing it inside SessionManager means the three quit paths cannot
  get the order wrong independently — which is what the alternative fix would
  have required proving.

The exemption is what covers a watcher event already dispatched when the freeze
lands; the ordering is what stops the race from being routine.

A follow-up pass then found a producer the first sweep had missed: each managed
session's source-activation `autoRetryTimer`. The watchers and schedulers live in
two workspace-keyed maps that read like "the background things"; this one hangs
off each session, and it fires `sendMessage` — so a shutdown starting inside its
100 ms window let it commit state after the freeze and have that write refused,
exiting without the retried message while the flush reported quiescence. Now
cancelled with the rest, pending record dropped.

### Review 4 — architecture final + security final

Security cleared P0–P2 and left three prose corrections; the architecture pass
found four more, one of which showed a round-3 fix had been type-level only.

1. **`pendingPlanExecution` is now stripped at RUNTIME.** Round 3 narrowed the
   type, which stops autocomplete and stops nothing from `JSON.stringify`-ing
   the record onto a wire payload. The public `listSessions` /
   `listActiveSessions` / `listArchivedSessions` now return records with the key
   deleted, and the bearing reader is `listSessionsWithPendingPlan`, exported
   from `@craft-agent/shared/sessions/internal` and off the barrel. The
   type-level test was replaced by one asserting the serialized form.
2. **The hook seam is a token/disposer with a runtime guard.** No unconditional
   `set(undefined)`: installing captures the owner it displaced, the disposer
   restores that owner, and a stale disposer is a no-op so a late teardown
   cannot strip a newer suite's hooks. Refuses outside a test runner. Off the
   barrel.
3. **`flushAll` is shutdown, and can fail.** It sets a `closing` state that
   refuses new producers (a refused checked write gets a failed receipt, not
   silence), drains queued keys and active tails to true quiescence, and
   **throws** if the round bound is exhausted rather than returning as though it
   had succeeded. Reopening is explicit. The electron quit path now says writes
   may be lost when it catches, instead of logging an ordinary cleanup error.
4. **Stale comments cleaned.** The merge-only field list was wrong — six of the
   seven fields are mirrored and only `permissionMode` is not, a claim my own
   round-1 read-state mirroring invalidated. Worse, a test had picked
   `lastReadMessageId` as its "merge-only" field and therefore **passed with the
   observation mechanism disabled**; it now uses `permissionMode` and fails
   without it. Also removed: the retirement failure-evidence guard, which had no
   reader, and its test.

Security prose corrections, all three applied: `readonly` is TypeScript-only and
the singleton IS constructed with delegating hooks, so the seam is narrowed
rather than absent; the write key is injective over (resolved root string,
sanitised id) — string identity, not filesystem identity, with case-insensitive
and symlinked spellings a recorded residual; and the observation doc no longer
claims to preserve fields `applyExternalSessionMetadata` already mirrors.

### Review 3 — architecture (2e9d7060)

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

### Review 2 — independent (5f9d2319)

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

### Review 1 — Greptile (797f1ebb)

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
- **The shared queue keeps one narrowed test seam**
  (`installSingletonCommitHooksForTesting`, `sessions/internal`). Hooks are
  otherwise constructor-only; note that `readonly` is a TypeScript constraint
  and erased at runtime, so what it removes is the discoverable API, not the
  ability. The seam is additionally guarded at runtime (refuses outside a test
  runner) and hands back a token-scoped disposer. It cannot be removed outright
  because `storage.ts:saveSession` and `SessionManager` must share ONE queue
  instance — they write the same files, and two instances would mean two tails
  over one `.tmp`, which is the race this unit exists to prevent. So a
  SessionManager-level test cannot be handed its own queue.
- **The write key is injective over strings, not over filesystem identity.**
  (`resolve`d root string, sanitised id). On a case-insensitive volume two
  spellings of one root yield two keys over one artifact, and there is no
  `realpath`, so a symlinked root is a different string for the same directory.
  Accepted rather than fixed: it needs the same workspace reached through two
  spellings in one process, which nothing does (roots come from stored config),
  and `realpath` is a syscall per key on a hot path that also fails for a root
  that does not exist yet. If it needs closing, canonicalise the root ONCE where
  a workspace is loaded.
- **Shutdown can fail and says so.** `flushAll` throws when it cannot reach
  quiescence within its round bound. Callers must not report success on that
  path; the electron quit handler logs that writes may be lost.
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
- `2026-09-12` — review 12 (security P3s): the final-persist predicate read a
  mid-finalisation session as idle, so the one session being assembled during
  shutdown got no checked receipt; and `markAllSessionsRead` used `Promise.all`,
  which abandoned the remaining writes and skipped the unread-summary event
  after already clearing the flags in memory.
- `2026-09-12` — review 11 (Greptile P1): creating a finalisation deferred on
  every turn start meant handoff interrupts (plan submit, auth request, auth
  retry) left one nothing would settle, hanging shutdown for its full bound;
  `setProcessing(false)` now releases it unless the finaliser is the caller.
- `2026-09-12` — review 10 (architecture): `isProcessing = false` was treated
  as finalisation complete, so shutdown closed the queue while the stop
  handler's tail was still assembling and persisting state; turns now carry a
  token-guarded finalisation deferred that resolves only after the final
  persist. And a superseded final receipt is retried from current managed state
  rather than accepted, because the replacement write can itself fail.
- `2026-09-12` — review 9 (security): shutdown was rewriting every cold session
  (hydration + `lastUsedAt` restamp); the final-persist set is now computed
  before quiesce and defaults to skip. `cancelled` split into `superseded` and
  `deleted` so `saveSession` can retry the first once and must never retry the
  second; batch loops collect partial failures.
- `2026-09-12` — review 8 (Greptile P1): the ordered shutdown's timeout path
  threw before the final persist and the drain, so one stuck turn cost every
  other session its last write. Failures are now collected and reported after
  the salvage.
- `2026-09-12` — review 7 (architecture, shutdown producer completeness): the
  freeze stopped timers but not TURNS, so an agent's async finalisation could
  write after the close. `flushAllSessions` is now an ordered sequence — refuse
  new work, stop producers, abort and await turns with the queue still open,
  persist final states against exact receipts, then close and drain — and
  receipts carry a `reason` so a superseded final write is not mistaken for a
  lost one. Five steps mutation-verified.
- `2026-09-12` — review 6 (security final): `saveSession` could resolve success
  during a drain having written nothing; the test-runner guard admitted plain
  bun (and so the headless server) because `Bun.jest` exists there too; and the
  5s forced turn-cleanup timer was a second unstored per-session producer. All
  three mutation-verified.
- `2026-09-12` — review 5 (Greptile P1): the review-4 shutdown freeze refused
  the replacement half of a watcher reconciliation, so absorbing an external
  edit during quit destroyed it. Fixed with a narrow reconciliation exemption
  plus producer-stopping inside `flushAllSessions`; both halves mutation-tested.
- `2026-09-12` — review 4 (architecture final + security final): the round-3
  pending-plan narrowing was type-level only and is now a runtime strip behind
  an off-barrel internal reader; the hook seam became a guarded token/disposer;
  `flushAll` became a real shutdown that freezes intake and throws rather than
  reporting a success it did not achieve; and a test that named a now-mirrored
  field as merge-only was proven vacuous and rewritten.
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
