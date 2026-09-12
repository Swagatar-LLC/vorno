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
reported a stuck turn that was not stuck. The first fix released the deferred
from `setProcessing(false)` unless a `finalizerRunning` flag marked the finaliser
as the caller — which the round below replaced, because it made release a side
effect of a flag write.

### Review 13 — finalisation ownership is explicit, not a side effect

Releasing the deferred from the single `setProcessing(false)` choke point put it
at the START of a handoff's tail, not the end. Plan submission clears the flag,
*then* releases the browser, *then* persists the plan; a quit landing in that
window resumed, closed the queue underneath the plan's write, and reported
success. The guard against early-resolve had become a second route to it.

So ownership is now named rather than inferred. `claimTurnFinalization(id)` hands
out a token-bound owner, `setProcessing`'s stop overload takes a REQUIRED
disposition — that owner, or `'no-tail'` — and every one of the four stop sites
holds its own `finally`:

| Site | Tail the deferred covers |
|---|---|
| `onProcessingStopped` | claimed at ENTRY, before the first `return`; released after visuals, read state, status, teardown, complete event, persist |
| plan submission (`completePlanSubmissionHandoff`) | browser release → complete event → persist |
| auth request (`completeAuthRequestHandoff`) | complete event → `auth_request` event → persist (synchronous; the browser release stays fire-and-forget, because awaiting it would delay the auth prompt behind teardown and lose it if teardown hung) |
| auth retry resend | released BEFORE `sendMessage`, deliberately — the resend is a NEW turn with its own deferred, and holding across it would strand the old promise the moment the new turn replaced it |

Making it required is the half that lasts: a future stop site cannot inherit
someone else's answer, because there is no default. The type is the check, per
*encode lessons in structure*. And a deferred still unreleased when the next turn
starts is resolved and logged rather than orphaned — a forgotten `finally` then
costs a warning, not a shutdown that waits out its whole bound. The two handoff
bodies were extracted from their agent callbacks so the ordering is reachable
from a test; the callbacks assign the message and hand over.

Four mutations, each killed: releasing generically from the flag write (plan +
stale-owner tests fail), dropping the auth `finally` (shutdown burns its bound),
dropping the token guard in `release` (a stale owner resolves its successor), and
orphaning instead of superseding at turn start. The auth-retry site is the one
stop site with no test of its own — its tail is two synchronous statements and
the supersede backstop bounds a leak there — recorded rather than implied away.

### Review 21 — steers are durable from the moment they are accepted

The previous rounds treated an undelivered steer as something to recover at turn
end. That still loses it: between the ACK and the turn end the message exists
only in the backend's memory, so a crash there drops a message the user was told
had landed. The model is now PROVISIONAL and durable from the accept:

1. **Marked at accept, before the ACK.** `isQueued` + canonical
   `queuedSkillSlugs` are written and flushed before `onAck`, so a crash replays
   it. Optimistic on purpose — most steers are delivered and the marker is then
   cleared — and one-directional: a replayed duplicate is recoverable, a lost
   message is not.
2. **The previous steer is settled when the next one arrives — by ASKING.** The
   first version promoted it unconditionally, and Greptile caught what that
   misses: a delivered slot and an overwritten slot are both EMPTY, so a steer
   the model had already answered was queued and run a second time. The settle is
   the same shared routine, and it runs BEFORE `redirect` writes the slot.
   Ordering is the fix in both directions: ask afterwards and the answer
   describes the steer arriving now, and taking the slot then would rob that
   steer of its delivery.
3. **A null answer is the only thing that clears a marker**, and it speaks for
   the most recent steer alone. Clearing the whole list on it would silently
   discard an earlier steer nothing ever answered.
4. **Every site that loses the slot reconciles first**, enumerated: turn end,
   user stop (`cancelProcessing`), the shutdown abort loop, the plan handoff and
   the auth handoff. `deleteSession` is the one deliberate omission and says so
   in-line — that session's file is going away, so queueing work into it is
   queueing for a transcript that is about to stop existing.
5. **The event path shares the routine** and correctness no longer depends on it;
   asking takes, so whichever of the two runs first leaves the other nothing.
6. **Skill names are path-safe rather than lowercase.** `[A-Za-z0-9_-]+` keeps
   `My_Skill` and `Commit` pre-enabling their sources — the compatibility cost
   flagged last round, now removed rather than documented — while still refusing
   separators, dots, spaces and empties. Live and replay share the one
   normalizer.

Mutations killed: no marker at accept; the previous steer not settled; a null
answer clearing every envelope; no reconcile before the user-stop abort; the
older first-match correlation; promoting without asking; and settling after
`redirect` instead of before it. The clear-all mutation survived its first
pass because the two-envelope state cannot be reached through the call graph —
it is now pinned by a direct test that says so in its own comment rather than
pretending the state is ordinary.

Fixture waits moved from "the admission map is momentarily empty" to STABLE
quiescence: idleness has to hold across consecutive turns of the loop before it
counts, because the empty instant between one replay settling and the next being
admitted is not quiescence.

That change then failed in CI once — and the failure was earned, not noise. The
fixture stops a replay by throwing from `getOrCreateAgent`, which the send
reaches AFTER starting the turn and which sits OUTSIDE the chat loop's try, so
the throw unwinds past every handler and leaves `isProcessing` true with nothing
scheduled to clear it. Quiescence was therefore a state the test could never
reach, and the old momentary check had been passing only because it did not look.
The fixture now closes the lifecycle it interrupted; verified with 20 consecutive
runs of the file and 10 of the whole WebUI gate, all clean.

**Recorded for the orchestrator, not fixed here:** production has the same hole.
A `getOrCreateAgent` that throws — a backend that cannot be built, bad
credentials — leaves the session marked processing with no completion event, and
that session then makes shutdown wait out its entire drain bound and report a
stuck turn. It is a lifecycle defect adjacent to this SUV rather than one of its
own, so it is named rather than quietly folded in.

### Review 19 — the last places the two paths disagreed

1. **An undelivered steer came back as a different message, and not durably.** A
   steer is a user message that was accepted, ACKed and persisted, then pushed
   into the running turn instead of queued. `steer_undelivered` carries only the
   TEXT, so the re-queue built a bare entry: a NEW message with a new id (a
   duplicate in the transcript), no attachments, no skill slugs, and nothing on
   disk — `messageQueue` is runtime state. A quit right there lost a message the
   user had been told was accepted. `pendingSteers` now remembers the envelope at
   steer time and the event consumes it: the ORIGINAL message gets `isQueued` +
   `queuedSkillSlugs` and a full runtime entry. Envelopes are per-turn and
   cleared in `onProcessingStopped`, because a delivered steer is not coming back
   and a stale one re-queues a message that was already answered.

2. **Live and replayed sends could disagree about the slugs.** Normalizing at
   each persist site left the LIVE pre-enable — the one that reaches
   `loadSkillBySlug` FIRST — reading whatever the caller sent. There is one
   normalization now, at send ingress, and the raw value is never read again, so
   the pre-enable, every runtime queue entry and the persisted field take the
   same list. The shape moved to the repo's standing slug rule: lowercase
   alphanumeric with hyphens, no leading hyphen, the same rule `isValidSlug` and
   the source/status schemas use.

   **Compatibility, stated:** a skill DIRECTORY may be named anything the
   filesystem allows, and one with an underscore or a capital is mentionable
   today. Such a skill still RUNS; what it loses is the source pre-enable, on the
   live path as well as the replayed one, so the agent enables its sources at
   runtime — the two-turn penalty, not a failure. Widening to `[a-z0-9_-]` is a
   one-character change if that trade is the wrong way round.

3. **Fixture waits are events, not timers.** `setTimeout(50)` asserted that 50ms
   had passed. The fake turn boundary now resolves a deferred the test awaits,
   and settling polls the real condition — an empty admission map, bounded — so a
   send that never settles fails an assertion instead of hanging. Every fixture
   ends by asserting nothing it started is still outstanding, and the mid-stream
   fake now ADOPTS and settles the pre-claimed admission: a mock that ignored
   that argument leaked one per replay, and the leak is invisible until a
   shutdown waits out its bound on it.

4. **Two comments claimed `messageQueue` is persisted. It is not** — `isQueued`
   on the message is what survives — and a cancelled write announced itself as a
   failed one, sending a log reader after a disk problem that was not there. The
   classification now runs before the error log.

Mutations: the steer re-queued as text only; no ingress normalization; stale
envelopes kept. The last two SURVIVED at first — not because the code was safe
but because no test asserted those claims, which is the same aim problem this SUV
has now hit three times. A live-vs-replay test and a two-turn steer test kill
them.

### Review 19 — the last places the two paths disagreed

1. **An undelivered steer came back as a different message, and not durably.** A
   steer is a user message that was accepted, ACKed and persisted, then pushed
   into the running turn instead of queued. `steer_undelivered` carries only the
   TEXT, so the re-queue built a bare entry: a NEW message with a new id (a
   duplicate in the transcript), no attachments, no skill slugs, and nothing on
   disk, since `messageQueue` is runtime state. A quit right there lost a message
   the user had been told was accepted. `pendingSteers` now remembers the
   envelope at steer time and the event consumes it: the ORIGINAL message gets
   `isQueued` + `queuedSkillSlugs` and a full runtime entry. Envelopes are
   per-turn and cleared in `onProcessingStopped`, because a delivered steer is
   not coming back and a stale one re-queues a message already answered.

   **Greptile then found that the event never arrives at all, and it was right.**
   `chat()` yields `steer_undelivered` from its `finally`, and the send loop
   RETURNS the moment it sees `complete` — which abandons the generator, and an
   abandoned generator's trailing yields are discarded. So every Claude turn that
   ended without a tool call firing dropped an accepted, ACKed user message, both
   before this SUV and after its first fix. The information cannot be pushed, so
   it is PULLED: `AgentBackend.takeUndeliveredSteer()` (optional; Claude
   implements it, native-steering backends have nothing to hand back) is called
   at turn end, in `onProcessingStopped`'s SYNCHRONOUS prefix — the generator's
   `finally` runs when the iterator closes, which is after that point and would
   otherwise clear the backend's copy first. Taking it clears it, so the trailing
   yield (if anything is still draining) cannot promote the same message twice.
   The event handler stays as the courtesy path for a consumer that drains
   naturally; both go through one promotion routine.

   The test for this is narrow on purpose and its limit is stated: it drives the
   turn-end handler the loop really does reach and asserts the message survives
   with NO `steer_undelivered` event processed at all. It does not re-prove that
   the loop calls that handler on `complete` — that is existing, unchanged code.
   A full fake backend driven through `sendMessage` was tried first and abandoned
   when it hung on incidental backend surface; a test that needs a dozen stubs to
   reach one assertion is testing the stubs.

2. **Live and replayed sends could disagree about the slugs.** Normalizing at
   each persist site left the LIVE pre-enable — the one that reaches
   `loadSkillBySlug` FIRST — reading whatever the caller sent. There is one
   normalization now, at send ingress, and the raw value is never read again, so
   the pre-enable, every runtime queue entry and the persisted field take the
   same list. The shape moved to the repo's slug convention: lowercase
   alphanumeric with hyphens, no leading hyphen. Not a call to `isValidSlug`, and
   slightly looser than it — that predicate also forbids a trailing hyphen —
   because the job is to reject anything that is not a plain name, not to police
   cosmetics on a directory the user owns.

   **Compatibility, stated:** a skill DIRECTORY may be named anything the
   filesystem allows, and one with an underscore or a capital is mentionable
   today. Such a skill still RUNS; what it loses is the source pre-enable, on the
   live path as well as the replayed one, so the agent enables its sources at
   runtime — the two-turn penalty, not a failure. Widening to `[a-z0-9_-]` is a
   one-character change if that trade is the wrong way round.

3. **Fixture waits are events, not timers.** `setTimeout(50)` asserted that 50ms
   had passed. The fake turn boundary now resolves a deferred the test awaits,
   and settling polls the real condition — an empty admission map, bounded — so a
   send that never settles fails an assertion instead of hanging the suite. Every
   fixture ends by asserting nothing it started is still outstanding, and the
   mid-stream fake ADOPTS and settles the pre-claimed admission: a mock that
   ignored that argument leaked one per replay, and that leak is invisible until
   a shutdown waits out its bound on it.

4. **Two comments claimed `messageQueue` is persisted. It is not** — `isQueued`
   on the message is what survives — and a cancelled write announced itself as a
   failed one, sending a log reader after a disk problem that was not there. The
   classification now runs before the error log.

Mutations: the steer re-queued as text only; no ingress normalization; stale
envelopes kept. The last two SURVIVED at first — not because the code was safe
but because no test asserted those claims, which is the same aim problem this SUV
has now hit three times. A live-vs-replay test and a two-turn steer test kill
them.

### Review 17 — the edges of the fixes from review 16

1. **A delete racing a failing write left evidence, and the retry resurrected the
   session.** Review 16's retained snapshot is right, and it was missing the
   other half: the intent has to be RE-READ in the catch, because the attempt
   spans awaits and the check at the top of `write` answered for an instant that
   has passed. A `cancelForDeletion` landing while a write failed left a retained
   snapshot for a session that no longer existed, and `flushAll` then wrote its
   file back. Cancellation now outranks failure — the receipt settles `deleted`
   rather than `failed`, the temp file is tidied, no evidence is retained, and
   the shutdown retry has nothing to resurrect. A supersede is the same rule with
   a gentler reason: the replacement write owns that state.

2. **The replay handoff had a gap of its own.** `processNextQueuedMessage`
   shifted the entry out of the runtime queue and cleared the persisted
   `isQueued` BEFORE handing the message to a deferred send — so for that tick
   the queue had dropped it, disk said it was not queued, and nothing was running
   it. A quit landing there saw an idle session and the message was gone. It now
   claims the send admission SYNCHRONOUSLY before giving anything up and passes
   it into the deferred `sendMessage` (adopted, never claimed twice), and the
   durable marker is released only once a replay owns the turn. A quit in the gap
   therefore waits for that send to refuse or to take one, and a refusal leaves
   the marker true: at-least-once, never lost. The renderer still gets
   `status: 'processing'` with an `isQueued: false` copy for that tick — display
   and durability are allowed to differ there, and only there.

3. **Badges were the wrong source for the slugs.** Review 16 reconstructed
   `skillSlugs` from the message's skill badges, which works for a send typed in
   the input and not at all for an automation or CLI send — those carry
   `options.skillSlugs` and no badges. So a presentation detail was deciding
   whether a replayed turn pre-enabled its sources. `Message.queuedSkillSlugs` is
   now the canonical copy, normalized from the original options on the way out
   and re-normalized on the way in, written with `isQueued` and cleared with it.
   That normalizer takes `unknown` and checks `Array.isArray` FIRST (a later
   security pass): the value returns from a file anyone can edit, and a bare
   string passes a `.length` test and then iterates as CHARACTERS — each a valid
   slug shape — while `{length: 2}` passes it and THROWS on iteration, inside
   hydration, which is a session that will not open.
   `skillSlugsFromBadges` is deleted rather than kept as a fallback: a second
   source of truth for the same answer is how the two hydration paths came to
   disagree in the first place.

4. **The tests were replaced, not extended.** Review 16's coverage asserted the
   recovery helper built the right object — the seam, which is what I flagged as
   the limit at the time. It is now a process-boundary fixture: a real send with
   `skillSlugs` and no badges, queued by a real turn, written to the real JSONL,
   hydrated cold by a SECOND `SessionManager`, replayed against a real
   `SKILL.md` declaring `requiredSources` and a real source `config.json` — and
   the assertion is that the source is enabled before the turn. The turn itself
   is the only fake, and the scheduled replay is awaited rather than left
   running.

Six mutations, each killed: failure outranking cancellation; the slugs not
persisted; recovery ignoring them; the marker cleared in the gap; no admission
claimed before the gap; the marker never released.

Known upgrade gap, stated: a message queued by a build older than this one has
no `queuedSkillSlugs`, so its replay pre-enables nothing and the agent discovers
the skill at runtime — the two-turn penalty that existed before this work. One
launch wide, and not worth a badge-shaped fallback that would reintroduce the
second source of truth.

### Review 16 — three producers that acted past the edges of the shutdown

1. **A failed ordinary write's bytes existed nowhere.** The queue shifts an entry
   off before attempting it, so on failure the snapshot it carried was gone: no
   receipt holder, no queue entry, every map quiescent, a stale file on disk and
   nothing that would ever correct it. The exact latest failed snapshot is now
   RETAINED per key — `retireIfQuiescent` refuses to sweep a key holding one,
   because that is evidence rather than bookkeeping — and released only by a
   successful commit for that key (same-or-newer by construction: generations
   increase and the FIFO drains them in order) or by deletion. `flushAll` retries
   each retained snapshot before it may report a clean shutdown, enqueued as
   checked + reconciliation: exempt or the shutdown refuses its own retry,
   checked or the answer belongs to somebody else. Ordered AFTER the drain, so a
   newer queued write commits first and releases the snapshot instead of being
   overwritten by stale bytes. One attempt each — a filesystem that has said no
   twice is not going to be talked round, and the failure reports itself through
   the closing ledger. This is also what covers `storage.ts:saveSession` callers
   that never reach SessionManager, which is why it lives at the queue level
   rather than in the candidate scan.

2. **`generateTitle` acted after the freeze.** Un-awaited by its caller and not
   one of the producers `stopPersistenceProducers` stops — a quit may not be held
   open for a model round-trip — it would mutate `managed.name`, enqueue a write
   the closing queue refuses, and emit `title_generated`, leaving memory, disk
   and the renderer disagreeing about the name. It now re-checks after its await
   and DISCARDS before mutating, persisting, announcing or logging success, and
   refuses to stand up a temporary backend once the freeze has landed, so the
   provider handle is never opened rather than opened and abandoned. Greptile
   then found the gap between those two: a quit beginning while `postInit` was
   opening the connection still let the REQUEST go out, to be discarded on
   arrival — so the check is repeated immediately before the request, inside the
   `try` whose `finally` tears the temporary backend down. That review also
   surfaced a pre-existing leak beside it: a `postInit` that threw returned
   without destroying the backend it had just created, because `isTemporary` was
   only set after the await. It is set before it now, and the catch destroys.
   Bounded by
   refusing rather than by being awaited, deliberately: the title is derived, and
   the fallback name the session already has is correct. The previous round
   recorded this as an accepted P3 residual; it is now fixed, and the residual
   says so.

3. **A replayed queued message lost its skill slugs.** `options` is not
   persisted, so the entry rebuilt at cold load had `options: undefined` and the
   pre-enable block (`if (options?.skillSlugs?.length)`) never ran — the replayed
   turn started with the skill's required sources disabled, which is exactly the
   two-turn penalty that block exists to remove. The slugs are reconstructed from
   the message's persisted skill badges. Two hydration paths held byte-identical
   copies of this recovery and were separately maintained, which is how they came
   to be separately wrong in the same way; there is one copy now
   (`recoverOrphanedQueuedMessages`), so the next fix lands once.

   `skillSlugsFromBadges` parses `rawText` against the same bracket form the
   input builds and nothing else. That is the security half, not a formality: a
   badge is CONTENT — it travels with a message, is persisted, and nothing
   revalidates it on the way back in — while the slug it yields reaches
   `loadSkillBySlug`, which builds a filesystem path out of it. `[\w-]+` cannot
   express a separator or a `..`, so what comes back is a name and not a route,
   and `label` is deliberately not a fallback because it is a display string.
   Existence stays `loadSkillBySlug`'s question, which it already answers and
   tolerates a miss on.

Six mutations, each killed: no shutdown retry; retirement sweeping the evidence;
a successful commit not releasing the snapshot; the title applying after the
freeze; the replay dropping `skillSlugs`; and a permissive slug pattern.

Honest limit on the third: the end-to-end claim "a cold replay pre-enables the
same sources the original send did" is asserted at the SEAM — the recovered
queue entry carries exactly the `options.skillSlugs` the pre-enable block reads —
rather than through a live skill-file-plus-source fixture driven all the way to
an enabled source. The pre-enable block itself is unchanged by this SUV.

### Review 14 — two ways a shutdown reported success it did not have

1. **Quiescence is not success.** The cold-session no-rewrite decision is right —
   an idle session's queued write IS its latest state and the drain carries it —
   but the drain's own failures had no reader. `write` catches its own errors so
   the fire-and-forget callers keep working, and an ordinary write has no receipt
   holder, so an idle session whose one pending write failed left the queue
   empty, `flushAll` returned, and the host logged a clean quit over state that
   never reached disk. The checked final persists cannot cover it: they run
   BEFORE the freeze. Now a `closingWriteFailures` ledger records any write that
   fails while `closing`; a later successful write for the same key clears it,
   because a failure is a claim about STATE rather than about an attempt, and
   every transient mid-drain error would otherwise fail a shutdown that actually
   saved everything. Cancellations record nothing — `deleted` is intentional,
   `superseded` means a replacement is carrying the state. `flushAll` reports
   quiescence failures and drain failures together instead of letting the first
   hide the second.

2. **A send admitted before the freeze was invisible.** `sendMessage` refuses at
   entry while shutting down, which answers "may this send START" and nothing
   else: two awaits sit between that check and the first mutation (the
   stored-plan clear, the message hydration). A quit landing in that window found
   nothing to wait for, so the send resumed into a closing queue, pushed a user
   message the queue then refused to write, and called `onAck` — telling the
   client "accepted" for a message that existed only in memory of a process about
   to exit. Worse, a send that went on to start a turn created one AFTER the
   candidate scan had already decided what needed writing.

   So a send is now *admitted*: `admitSend` registers a deferred in the SAME tick
   as the entry check (registering after any await just moves the window), and a
   send that resumes into a quit refuses having mutated nothing and ACKed
   nothing. Ownership
   transfers to `turnFinalization` in `beginTurnFromAdmittedSend`, which holds
   both statements together — the atomicity comes from there being no await
   between them, not from their order, since nothing can run in between either
   way. Shutdown awaits admissions BEFORE the candidate scan, so a send about to
   take a turn is visible to it; bounded like the turn drain and reported rather
   than thrown, for the same reason.

3. **Where the refusal point sits was the next P1** (Greptile, on the first
   version of item 2). Re-checking after *every* pre-mutation await looked
   strictly safer and was not: `clearStoredPendingPlanExecution` unlinks an
   accepted plan from DISK, so a check after it refused the send having already
   dismissed the user's plan — destroying state while reporting that nothing was
   mutated, on a session that might then earn no final write at all.

   There is now exactly ONE refusal point, after hydration and BEFORE the plan
   clear: the last instant at which refusing costs nothing. Past it a send is
   COMMITTED and finishes — the admission holds the queue open, so the message is
   written and honestly ACKed. What a committed send skips is STARTING A TURN,
   since shutdown has already chosen the turns it will abort; it marks the
   message `isQueued` and leaves it, the same answer `processNextQueuedMessage`
   gives when it declines to replay during a shutdown. `isQueued` is the durable
   half — `messageQueue` is runtime-only and dies with the process, and the
   cold-load re-queue scan is what actually replays the message next launch.

Mutations, each killed: shutdown skipping the admission wait; a missing
post-hydration re-check; a transfer that forgets to settle; a ledger that never
records; a success that does not clear the ledger; a turn started during
shutdown rather than queued; and a refusal placed after the plan clear. That
last one appeared to SURVIVE TWICE before it was killed, both times because the
mutation was aimed at the wrong line — the file holds two
`pendingPlanExecution = undefined` sites and the earlier one is not on the send
path. A surviving mutation is a question about the aim before it is a claim
about coverage; this SUV has now been bitten by that twice.

One mutation survives for a real reason, recorded rather than papered over:
swapping the two statements inside `beginTurnFromAdmittedSend` changes nothing
observable, because a synchronous block has no instant in between. The comment
claiming the order was the contract was corrected to say what actually holds —
that the absence of an await is the property.

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

- The two watermarks' `Math.max` calls have no reachable path today; they hold
  an invariant that currently rests on `retireIfQuiescent` dropping
  `generations` and `cancelledThrough` together.
- The auth-retry resend is the one turn-stop site with no test of its own. Its
  tail is two synchronous statements, and a forgotten release there is bounded
  by the supersede-at-turn-start backstop rather than by coverage.
- **`generateTitle` is still not awaited by shutdown, by choice.** It is fired
  un-awaited from the send path and `stopPersistenceProducers` does not stop it,
  because holding a quit open for a model round-trip is worse than losing the
  title. What is guaranteed instead is that it cannot ACT across the freeze: it
  discards before mutating, persisting, announcing or logging success, and will
  not open a temporary backend once shutdown has begun. So a title in flight at
  quit is lost — a DERIVED value that regenerates next turn, while the
  transcript, the user message and the turn state are all written by paths
  shutdown does wait for. `AgentInstance.generateTitle` takes no abort signal,
  so cancelling the in-flight provider call is not available to us today.
- **Retained failure evidence is bounded by an anomaly, not by traffic.** A key
  whose last write failed keeps its snapshot and its generation bookkeeping
  until something commits or the session is deleted — so a session that fails
  and is never written again holds one record for the life of the process, and
  `retireIfQuiescent` is blocked for it. Same shape and same justification as
  the held-observation residual: the alternative is discarding the only copy of
  state that never reached disk. Visible in `diagnostics()`.
- **`isQueued` replay is at-least-once, not exactly-once.** A message committed
  during shutdown is marked `isQueued` and re-queued by the cold-load scan;
  `processNextQueuedMessage` clears the flag and persists, so a crash in the
  window between the clear and that persist replays the message a second time.
  The direction is deliberate: duplicating a user message is recoverable and
  losing one is not. Exactly-once needs the clear and the send to share a
  durable transaction, which this queue does not offer — see the `fsync`
  residual for the other half of that story.
- `clearStoredPendingPlan` is a one-line, one-caller indirection around a module
  import, kept as a test seam. What it buys is the only way to hold the window
  where a quit lands INSIDE the plan clear — the window a P1 was found in — open
  for a test; a module-level import cannot be held. Named rather than passed off
  as a refactor.

## Status log

- `2026-09-12` — created in `in-progress/`, extracted from PR #205 as a
  standalone prerequisite of SUV-0064. Id reserved via `refs/suv-ids/SUV-0066`
  (ADR-0030 CAS) after an all-refs floor scan agreeing with the console.
- `2026-09-12` — PR #206 opened; all twelve gates green.
- `2026-09-12` — review round 1 (Greptile 3/5): two P1 data-loss findings and
  one P2 traceability finding, all valid, all fixed with mutation-verified
  tests; plus a per-generation intent leak found while fixing the first.
- `2026-09-12` — review 21b (Greptile P1): settling the previous steer by
  promoting it unconditionally re-queued a message the turn had already
  DELIVERED — an empty slot means delivered just as often as it means
  overwritten. The settle now asks, through the shared reconcile, and runs
  before `redirect` writes the slot.
- `2026-09-12` — review 21 (architecture P1s): a steer lived only in the
  backend's memory between its ACK and the turn end, so a crash there lost an
  acknowledged message. Steers are now marked durably provisional at accept,
  overwritten ones are promoted immediately, and a null slot answer — the only
  evidence of delivery — clears that one marker and no other. Reconcile runs at
  every site that loses the slot (turn end, user stop, shutdown, both handoffs;
  delete deliberately excluded). Skill names relaxed to path-safe
  `[A-Za-z0-9_-]+`, so `My_Skill` keeps its pre-enable.
- `2026-09-12` — review 20 (security P3): the steer promotion matched the FIRST
  envelope with a given text while the backend's single slot holds the LATEST,
  so two same-text steers in one turn re-queued the wrong message id and the
  earlier send's attachments; `findLastIndex` now. Slug comment corrected: the
  pattern matches the repo convention, it is not `isValidSlug`, which is
  stricter about a trailing hyphen.
- `2026-09-12` — review 19b (Greptile P1): the `steer_undelivered` EVENT never
  reaches the session layer — the send loop returns on `complete` and abandons
  the generator, discarding its trailing yield — so every Claude turn that ended
  without a tool call firing dropped an accepted, ACKed message. The answer is
  now pulled at turn end via `takeUndeliveredSteer()` rather than waited for.
- `2026-09-12` — review 19 (architecture P1/P2/P3): an undelivered steer was
  re-queued as a NEW, non-durable message, losing id, attachments and slugs — it
  now promotes the original through a per-turn envelope; skill slugs are
  normalized once at send ingress against the repo's lowercase-hyphen slug rule,
  so a live turn and its replay cannot disagree; fixture waits became events with
  leak assertions; and the `messageQueue`-is-persisted comments and the
  cancelled-write error log were corrected.
- `2026-09-12` — review 19 (architecture P1/P2/P3): an undelivered steer was
  re-queued as a NEW, non-durable message, losing its id, attachments and slugs
  — it now promotes the original through a per-turn envelope; skill slugs are
  normalized once at send ingress against the repo's lowercase-hyphen rule, so a
  live turn and its replay cannot disagree; fixture waits became events with
  leak assertions; and the `messageQueue`-is-persisted comments and the
  cancelled-write error log were corrected.
- `2026-09-12` — review 18 (security P3): `normalizeQueuedSkillSlugs` trusted a
  `.length` check on an untrusted field, so a corrupted `queuedSkillSlugs`
  string produced one slug per character and an object with a `length` threw
  during hydration. `Array.isArray` first, parameter widened to `unknown`, plus
  a read-path regression that opens a session carrying both corrupt forms.
- `2026-09-12` — review 17 (architecture P1/P2/P3): a delete racing a failing
  write left retained evidence the shutdown retry then RESURRECTED, so
  cancellation now outranks failure in the catch; the replay handoff cleared the
  durable marker before anything owned the send, so the admission is claimed
  synchronously and the marker released only when a turn owns it; and the skill
  slugs moved off badges onto a canonical persisted `queuedSkillSlugs`, since
  automation and CLI sends have no badges at all. The seam-level replay tests
  were replaced by a real process-boundary fixture. Six mutations killed.
- `2026-09-12` — review 16 (architecture P1/P2/P3): a failed ordinary write's
  bytes existed nowhere afterwards, so the exact snapshot is now retained (and
  not swept by retirement) and retried by `flushAll` before it may report a
  clean shutdown; `generateTitle` acted past the freeze and now discards before
  mutating, persisting, announcing or logging; and a replayed queued message
  lost its skill slugs, which are reconstructed from persisted badges through
  one shape-validated helper shared by both cold-recovery sites, which were
  duplicated and separately wrong. Six mutations killed.
- `2026-09-12` — review 15 (security: P0–P2 clear, one P3): both shutdown waits
  bounded themselves with a 5s timer and never cleared the losing side of the
  race, so a Bun headless or standalone host sat with its event loop held open
  for five seconds after a shutdown that had finished. Electron hid it —
  `app.quit` tears the process down regardless. Timers are hoisted and cleared
  in a `finally`; asserted by instrumenting the timer API rather than reading
  `_getActiveHandles`, because the claim is about this code's timers and not
  about the runtime's handle list. Two residuals recorded:
  `generateTitle` (derived-value loss, P3) and `isQueued` replay being
  at-least-once.
- `2026-09-12` — review 14 (architecture, 2 P1): a write that failed during the
  closing drain had no reader — ordinary writes have no receipt holder — so a
  quiescent queue reported a clean shutdown over lost state; and a send admitted
  before the freeze resumed into a closing queue, pushed a user message that
  could not be written, and ACKed it. Added a closing-failure ledger that
  `flushAll` reports, and a send-admission seam shutdown awaits before its
  candidate scan. Five mutations killed, one survived and is recorded as a
  corrected claim rather than a defect.
- `2026-09-12` — review 13 (architecture P1): releasing the finalisation
  deferred from `setProcessing(false)` made release a side effect of a flag
  write, so a handoff with an async tail resolved it at the START of that tail —
  a quit inside a plan submission closed the queue before the plan reached disk
  and reported success. Ownership is now explicit and REQUIRED at every stop
  site (`claimTurnFinalization` + a stop-overload disposition), each site
  releasing in its own `finally` after its tail and persist. Four mutations
  killed; the stale `receiptFor` "or later" wording and two residuals that the
  code had already outgrown were corrected in the same pass.
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
