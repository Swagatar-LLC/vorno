---
id: SUV-0064
title: Execute pinned page session callbacks
status: in-progress
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-12
related: [SUV-0059, SUV-0065, ADR-0033]
blocked-by: []
---

# SUV-0064 — Execute pinned page session callbacks

## Goal

Execute a user-approved Page session callback through the existing
workspace-contained session executor without allowing invocation-time targets,
payloads, escalation, or session closure.

## Scope

- Add `session` descriptors as bare triggers with user-approved,
  digest-bound target, action, and body pinned at grant approval.
- Reuse the existing session-action checks, `SessionManager` mutators, canonical
  outcome producer, and closure guards; pages receive no `allowClosed` escape
  hatch.
- Make shared target-session resolution require workspace containment for both
  Page callbacks and the existing webhook executor, closing the known webhook
  exposure rather than creating a Page-only check.

Grant issuance/lifecycle remains in SUV-0059; runtime action authority and trusted activation remain in SUV-0065.

## Acceptance

- [x] A callback descriptor accepts no invocation-time target, action, or body;
      each is user-approved, digest-bound, and pinned before execution.
- [x] The shared target-session resolver proves workspace containment for Page
      callbacks and the existing webhook path, with regression coverage for
      cross-workspace targets.
- [x] Execution reuses the existing session-action and `SessionManager` choke
      points and declares the ADR-0021 Page origin rather than mutating session
      records directly.
- [x] Callback escalation and every session-close path, including any
      `allowClosed` escape hatch, are refused and covered by closure-guard tests.
- [x] Approval, rejection, execution, cancellation, timeout, and result use the
      canonical outcomes/audit path without credentials or sensitive pinned
      payloads.

## Status log

- `2026-09-10` — created in `planned/` from reserved SUV-0064; split from
  SUV-0059 so callback execution remains one reviewable PR.
- `2026-09-10` — runtime Page-action enforcement split to SUV-0065; this SUV
  begins only after the grant lifecycle and runtime authority prerequisites.
- `2026-09-12` — moved from `planned` to `in-progress` on the merged
  SUV-0059/0060/0065 baseline; pinned session-callback implementation began.
- `2026-09-12` — implementation complete, all five acceptance items ticked.

## Reopen, and what closed it

`2026-09-12` — Greptile review of PR #205 did not clear (1/5, two P1). Acceptance
items 3 and 5 were un-ticked: both were claimed on checks a production caller
does not actually reach in the state they describe.

- **The state checks raced the delivery.** The executor read
  busy/closed/archived and then `await`ed `sendMessage` — but `sendMessage`
  awaits twice more before it branches on `isProcessing`, so a turn starting in
  that window got the page's text steered or queued into it, and a session
  archived in that window received a message into finished work. The guard
  described a state that was true earlier.
- **Cancellation did not stop delivery.** `executeSession` took no
  `AbortSignal`, on the reasoning that a single `sendMessage` has no
  long-running work to abort. That reasoning missed `race`: a losing promise
  keeps running. A cancel, a lease release, or the broker deadline would win the
  race, release the slot, and audit the action as cancelled or timed out while
  the message was delivered anyway — a withdrawn message recorded as not sent.

`2026-09-12` — closed again, at the root rather than by adding another check:

- **`SessionManager.tryDeliverPageCallback` is the atomic primitive.** The final
  workspace/archived/closed/busy/abort check runs as `sendMessage`'s own
  `deliveryGuard`, evaluated synchronously at its decision point with nothing
  able to yield between the check and the commit. This is **not** a second send
  path — it is the one send path, told when to stop. It returns at
  **acceptance** (`onAck`, once the user message is persisted and flushed), not
  at the end of the turn it starts, so the broker's deadline can never fire over
  work already on disk.
- **`executeSession` takes the signal** and the guard re-reads it immediately
  before the commit, so a withdrawal landing mid-flight refuses instead of
  delivering — and once committed, the action has succeeded and nothing
  downstream relabels it.
- **Queued consent re-resolves the target**, immediately before the sheet opens
  and again after the answer. A request can wait the full confirmation timeout,
  and a sheet naming a session by a name it no longer has — or one since deleted
  — asks for consent to the wrong thing; approving one would mint a capability
  that can never fire.
- **Release-note bullet added** to `release-notes/next.md` per the bundled
  resources directive.

## Decisions worth keeping

Recorded here rather than in the PR thread, because each is a limit or a
deliberate narrowing a future owner will meet.

- **Send-message is the only action, and there is no `action` field.** ADR-0033
  §4 says "bare trigger with a user-approved target and pinned body"; the
  threat-model draft had proposed the automations `SessionAction` union
  (set-status / set-labels / apply-context / send-message). Narrowing to one
  action makes the hard no-close boundary structural rather than guarded — there
  is no status write to refuse. A single-valued discriminator would have been a
  knob that does not turn, so `kind: 'session'` carries it, and the session arm
  alone is `.strict()` so a smuggled `action: 'set-status'` is **refused**, never
  stripped.
- **The `page` origin's real caller is the refusal log, not a status write.**
  SUV-0065 deleted `host-ui` on the principle that an origin with no caller is
  unenforceable decoration. This one is constructed (`pageOrigin`) and passed to
  `describeOrigin` on every refusal, which forces the exhaustive `mayCloseSession`
  switch to classify it — permanently, for whatever routes a Page through the
  status choke point later. It has no `allowClosed` counterpart, and that
  asymmetry with `automation` is the decision: an automation was reviewed by a
  human at registration; a Page's content is agent-authored and rewritable.
- **Busy refuses instead of inheriting `sendMessage`'s mid-stream behavior.**
  `sendMessage` into a processing session steers or queues. Both would drop a
  page's text into a turn the user is watching with no gesture of theirs in
  between. The user's own send keeps that behavior; a page does not get it.
- **Audit records the target session id but never the pinned body.** Unlike the
  `script` arm, which records nothing beyond its kind, the target is the
  containment fact the row exists to make checkable. The body is payload, and
  payload is what every other rule in `describeApprovedAction` strips.
- **Delivery is attributed by the host.** The pinned body arrives verbatim behind
  an unforgeable provenance line naming page and grant. Without it a callback
  reads as a user turn, which is the T4 prompt-injection shape the design is
  built against. The prefix is host-authored and is deliberately not part of the
  descriptor the user approved.
- **Deliberately not built:** no `history.jsonl` record. A Page callback is not
  an automation matcher run, and synthesizing a `matcherId` would put a fake
  automation in the operator's history. The Page audit log already records every
  decision under the right redaction rules.

## Reopened again

`2026-09-12` — Greptile round 2 (4/5) found one more P1 that the round-1 fix
walked past. The re-resolution added before `addPageGrant` proved *existence and
containment* only, so a session archived or moved to a closed status while the
consent sheet was open still resolved, and the grant persisted against it. The
executor refuses every finished target, so the user had approved a capability
that could never fire — worse than a refusal, because it looks like it works.

`2026-09-12` — closed again:

- **`isSessionFinished` is now one predicate, shared by grant issuance and
  delivery.** Both paths ask the same question, so they cannot drift about what
  "finished" means, and the executor's own inline copy of the closed-status
  check is gone.
- **`isProcessing` is deliberately excluded from it**, and that asymmetry is the
  decision rather than an oversight. Finished (archived / `closed`-category) is
  durable — nothing re-opens a session on its own — so it refuses at BOTH grant
  time and delivery. Busy is a moment: a session mid-turn now is an ordinary
  target a minute later, so refusing to *grant* on it would make approval depend
  on timing the user can neither see nor choose. Busy therefore refuses at
  delivery only, where the remedy is clicking again.

## Reopened a third time

`2026-09-12` — independent architecture review blocked the PR. The round-1 fix
was right in shape and wrong in depth: it moved the guard to `sendMessage`'s
decision point but left three things ahead of it, and resolved at the wrong
instant.

- **Mutations preceded the guard.** `sendMessage` pins the browser-host client,
  claims the auto-retry slot, and `await`s `clearStoredPendingPlanExecution`
  before it decides anything. So a callback that was about to be *refused* still
  destroyed a pending plan the user had not answered — destructive, silent, and
  attributable to nobody they can see.
- **Acceptance was signalled at `onAck`, which fires after `flushSession`.** The
  message was already in `managed.messages` during that await, so a deadline or
  cancel landing in the gap could still audit delivered work as a timeout.
- **A second resolver survived.** `SessionManager.resolveAutomationTargetSession`
  answered an explicit `{ id }` from the process-wide session map with no
  workspace comparison, then acted with the calling workspace's root path — the
  same containment break the webhook path had, still live on the app-event path.
- **The delivery seam sat on the wire DTO.** `deliveryGuard` was a closure on
  `SendMessageOptions`, which crosses RPC, is stored on `lastSentOptions`, and is
  replayed verbatim by auth-retry.
- **The production bridge stripped rather than rejected.** A page sending
  `action: 'set-status'` got a well-formed send-message descriptor back.
- **Three identical refusal unions** in three packages.

`2026-09-12` — closed again:

- **`pageCallback` seam reorders the preamble.** For the callback path the only
  await before the guard is `ensureMessagesLoaded`, which mutates nothing
  observable; the three mutations stay inside the non-callback branch. A callback
  **never** clears pending plan execution — refused or delivered. It is a page's
  button, not the user moving on.
- **`onCommitted` fires synchronously immediately after `messages.push`**, before
  any await, and that is what `tryDeliverPageCallback` resolves on. Cancel after
  commit cannot relabel a delivery; abort before commit leaves no message and no
  mutation.
- **One resolver.** `resolveAutomationTargetSession` is deleted; the app-event
  executor uses `resolveWorkspaceSessionTarget`, with cross-workspace regressions
  for status, labels, send-message, context, and label targeting.
- **The seam is SessionManager-internal** (`SendMessageInternalOptions`) and
  `toPersistableSendOptions` strips it at both storage sites. Assignability alone
  would not have protected this — the strip has to be an action, not a type.
- **The bridge rejects unknown keys** on the session arm rather than
  reconstructing and stripping, matching the host schema's `.strict()`.
- **One refusal union**, `PageSessionRefusalCode`, in `shared/pages/types.ts`;
  the other two are re-exports.
- **First-use consent re-resolves inside the queued callback** immediately before
  chrome and again after the answer, before the ticket is minted.
- **Consent leads with host-resolved target identity** and renders the pinned
  body **in full, never truncated**, so a long message cannot bury which session
  is being authorized *and* cannot hide a suffix from the person approving it.
  (This bullet originally described a display truncation. That truncation was
  itself a P1 — see the post-mortem below — and the cap, not the preview, is
  what keeps the sheet legible.)

The adjacency itself is pinned by a test that reads the source and fails if an
`await` appears between the guard and the commit — **verified by injecting one**,
because the behavioral tests pass either way (the window it opens is a race, and
races do not fail deterministically).

## The truncation that became the vulnerability

`2026-09-12` — worth recording separately, because the mistake was mine and the
shape of it is instructive.

Round 3 raised a presentation concern: a 2,000-character pinned body could push
the target identity off a native sheet. I fixed it twice — reordering so
host-resolved identity leads, **and** truncating the body at 600 characters for
display. The second fix was a P1 vulnerability. A page could put innocuous text
in the visible prefix and instructions in the hidden suffix; the user approves
what they can see, and the session receives the whole thing. That is exactly the
prompt-injection shape this feature exists to prevent, arriving through the
mechanism built to prevent it.

The rule now stated in code, docs, and a test: **what a human approves, a human
sees whole.** The consent dialog never truncates. The "long body buries the
target" problem is solved by ordering and by a body cap small enough to display
in full (1,000 characters) — never by showing less than was approved. Raising
that cap means first proving the consent surface still shows every character.

The general lesson: a *display* mitigation for a *layout* problem became a
security hole because it broke the correspondence between what is consented to
and what executes. When consent is the security boundary, do not make the
consent surface lossy.

## Test integrity, round 5

`2026-09-12` — security re-review found three tests that passed for the wrong
reason. Recorded because "the test was green" was doing work it had not earned.

- **The plan-preservation test asserted against a file that does not exist.** It
  wrote an invented `sessions/<id>.pending-plan.json` and checked it survived.
  `clearStoredPendingPlanExecution` never touches such a path — the state lives
  on `pendingPlanExecution` inside the session record — so the assertion was
  true no matter what the code did. It now seeds through
  `setPendingPlanExecution` and reads back through `getPendingPlanExecution`,
  with a precondition assert so a failed seed fails loudly instead of passing
  vacuously, and a control test proving a non-callback send still clears.
- **The mutation-placement test proved less than it claimed.** It searched
  backwards for `if (!pageCallback) {` before each mutation, which only showed
  the branch opened somewhere earlier in the file — it kept passing with every
  mutation moved out past the closing brace. It now brace-matches the block, the
  way its sibling matches the mid-stream branch, and asserts each mutation is
  inside it and absent outside.
- **The host-surface test matched a comment.** It asserted the interface body
  contained `sendMessage`, which stayed true after the member was replaced by
  `tryDeliverPageCallback` because the word survived in a comment explaining why
  `sendMessage` is *not* the member. It now parses declared members and asserts
  the exact set `['getSessions', 'tryDeliverPageCallback']`.

All three were **falsified before being trusted**: the plan test reddens when
the clearing call is moved out of the branch, the placement test reddens on the
same edit, and the surface test reddens when a lifecycle member is added.

## Reopened a fourth time — two-phase acceptance

`2026-09-12` — architecture re-review. Four defects, all real, all in the
acceptance path rather than the authorization path.

- **Two callbacks could both commit to one idle session.** `isProcessing` cannot
  separate them: a turn does not start until well after the message is pushed,
  so both pass the guard and both commit. The guard's verdict is only as good as
  its exclusivity, and nothing in the existing session state provided any.
  **Fixed:** a per-session reservation taken in the same synchronous frame that
  clears the guard, released when the send settles. A second caller sees
  `session-busy` — what it actually is from that side, and it leaks nothing
  about the other page.
- **Commit and durability were conflated.** The primitive resolved at the
  in-memory push, so a crash before the flush lost a message the page had been
  told landed. **Fixed:** `markCommitted` (phase one, irreversible) and
  `onDurable` (phase two, on disk) are separate hooks, and the result carries
  `durable` so the caller reports what actually happened instead of asserting
  the stronger claim for both.
- **The broker could relabel a committed delivery.** A deadline or cancel
  landing after the message was in the transcript would audit it as a timeout —
  an operator reading "not delivered" about a message the user can see.
  **Fixed:** the executor signals commit to the broker, which drops the request
  from the cancellable set; `cancelAction` then refuses with an audited
  `already-committed`, and the catch path reports a committed delivery as the
  delivery it was.
- **Auth retry would re-deliver a callback with no authorization.** The retry
  path resends `lastSentMessage` verbatim after a token refresh, and the entire
  grant/activation/consent chain sits upstream of `sendMessage` and is not
  re-run. **Fixed:** `lastSentWasPageCallback` records provenance and
  `attemptAuthRetry` refuses. Stored rather than skipped, so the retry cannot
  fall back to an older user message instead — the turn is simply not
  retryable, and clicking the page again goes through the whole chain properly.

Each is falsified: removing the reservation reddens the concurrency test,
renaming the commit hook reddens the adjacency test, and the auth-retry refusal
is asserted against the real method.

## Round 7 — what the two-phase change itself got wrong

`2026-09-12` — three findings against the fixes above, all valid.

- **The reservation serialised callbacks against each other and nothing else.**
  An ordinary user send during a callback's flush window still saw an idle
  session and committed, so two turns could start. **Fixed by inverting the
  asymmetry rather than widening the lock:** ordinary sends *announce*
  (`ordinarySendsInFlight`) and callbacks *yield*. Nothing consults the set on a
  user's behalf, so no user message is ever delayed or refused by it — a page
  stands down for a person, never the reverse. The announcement is released in a
  `finally` on a thin public wrapper, because scattered `delete` calls cannot
  cover a throw and a leaked entry would make the session permanently
  un-callable by any Page.
- **The commit race dropped the durability answer.** When a deadline won after
  commit, the row was written before the executor reported durability, so
  `durable` was silently absent — exactly when an operator most needs to know
  whether a crash could lose the message. The in-flight delivery is now held and
  awaited in that branch; it settles promptly, since only the flush is
  outstanding.
- **The attribution line bypassed localization.** It lands in the session
  transcript, so the repo directive applies. Now `pages.callback.attribution`
  across all seven locales — **with an English fallback**, because the line is a
  security property rather than decoration: a host that never booted i18n (a
  headless process, a test harness) returned `undefined` and silently removed
  the warning. A missing translation must degrade to English, never to nothing.

## Round 8 — the announcement, and a self-inflicted slowdown

`2026-09-12` — two P1s against round 7.

- **A Set entry is a flag, and overlapping sends share it.** Two ordinary sends
  for one session shared one key, so whichever finished first deleted it while
  the other was still pre-handoff — and a callback could commit alongside the
  survivor, which is the overlap the announcement exists to prevent. Now a
  **refcount**, with the wrapper owning exactly one announce/withdraw pair; the
  inner early releases are gone, because a second decrement would under-count an
  overlapping send and reopen the window. Holding the announcement until the
  turn ends costs nothing, since `isProcessing` refuses a callback from the
  handover onward anyway.
- **Resolving on send-settle made every callback as slow as the turn it
  started.** `sendMessage` does not return until the agent turn completes, so
  round 7's change to resolve there meant the broker held its mutating queue
  slot for the whole turn and its deadline could not help — the caller was
  blocked on work that had already succeeded. **Fixed:** the primitive resolves
  at `onDurable`, which is the last thing it promises; everything after belongs
  to the turn, not to the delivery. The send-settle path remains as the fallback
  for a refusal or a throw before the flush. The broker's post-commit durability
  wait is additionally bounded (`POST_COMMIT_DURABILITY_GRACE_MS`), because
  "normally prompt" is not a guarantee to hold a queue slot on, and unknown
  durability records as not-durable rather than claiming a flush nobody saw.

## Round 9 — the reservation outlives the answer

`2026-09-12` — one P1. Resolving the caller at durability was right; releasing
the **reservation** there was not. On a session's first message `sendMessage`
performs a second flush (title generation) before `setProcessing`, so the
reservation lifted while `isProcessing` was still false — and a second callback
or an ordinary send could commit into that window, which is the overlapping turn
the whole mechanism exists to prevent.

The two lifetimes are genuinely different and conflating them was the bug. The
caller is answered at durability; the reservation now follows the **send**,
released when `sendMessage` itself settles — at or after the `isProcessing`
handover. There is therefore no instant at which a session is unreserved and not
yet processing. It costs nothing, because a callback arriving during the turn is
refused by `isProcessing` anyway: the reservation is only ever the stricter of
two already-agreeing answers.

The invariant is now asserted directly — after a delivery, the session is either
still reserved or already processing, never neither.

## Round 10 — test integrity, and the last of the acceptance window

`2026-09-12` — security final. Two of these are corrections to tests that were
claiming coverage they did not have, which is worse than absent coverage because
it reads as proof.

- **The pending-plan test proved nothing.** Its refusal cases never entered
  `sendMessage` at all — `tryDeliverPageCallback` early-outs on an already-busy
  or archived session — and its delivery case was masked by `persistSession`
  writing managed state back, restoring the field whether or not the clear had
  run. Both passed with the defect injected. It now drives a refusal at the
  **guard**, inside `sendMessage` and past where the clearing code sits, by
  making the session read idle at the synchronous early-out and busy at the
  guard. Verified red with the defect injected. The delivery path deliberately
  carries **no** behavioural assertion, because an honest one is not available
  there; branch placement is the structural test's job and the comment now says
  so instead of implying otherwise.
- **A stale comment described an early withdraw that no longer exists.** The
  ordinary-send announcement is decremented exactly once, from the wrapper's
  `finally`. A direct refcount test now covers announce-twice / withdraw-once:
  the callback still refuses, and only the second withdrawal releases.
- **The reservation now carries an ownership token** and is released at the
  `isProcessing` handover, idempotently, with the wrapper's deferred release as
  a token-scoped backstop. Without identity, a finishing callback's deferred
  release could clear a *later* callback's reservation; without the handover
  release, a stuck turn leaked a reservation nobody would ever clear. A stuck
  turn is now governed by `isProcessing`, which is the flag that already means
  what it needs to mean.
- **User priority is a rule about WHEN, not blanket precedence.** Before a
  callback commits, the user wins and the callback stands down. After it
  commits there is an accepted turn to be behind, so an ordinary send now
  **queues** (`pageCallbackTurnPending` joins `isProcessing` at the mid-stream
  branch) rather than committing alongside it and starting a second turn.
- **The i18n fallback requires BOTH placeholders.** A locale that dropped
  `{{grant}}` still contained the slug and passed a page-only check, shipping a
  line that named a page without saying which approval authorized it — the half
  an operator needs in order to revoke it.

## Round 11 — the marker could outlive its turn

`2026-09-12` — one P1. `pageCallbackTurnPending` is set at commit and cleared at
the `isProcessing` handover, but persistence, the flush, the ack, the event
dispatch and title generation all sit between those two points and any of them
can throw. A marker left set with `isProcessing` false is the worst residue
available: every later user message queues behind a turn that will never start,
and the session goes quiet with no error the user can see.

Cleared now in the send wrapper's `finally`, which is the one place that covers
every failure path at once, and a no-op on the success path because the handover
has already cleared it.

Worth recording how the test got there, because the first version was worthless:
it relied on the harness's own post-commit failure, which happens *after* the
handover — so the marker was cleared by the handover and the test passed with
the fix removed. It now injects a throw in `flushSession`, squarely inside the
window, and reddens when the clearing is taken out.

## Round 12 — one identity for both pieces of per-delivery state

`2026-09-12` — one P1, and the same class as the reservation token a round
earlier: the accepted-turn marker was session-wide with no ownership. Callback A
finishing while callback B had already committed cleared B's marker, and the
next send would then treat the session as idle and commit alongside B's turn.

Both pieces of per-delivery state now share **one token**, minted per delivery
and carried on the seam: the reservation and the marker are set with it, and
each is cleared only by the holder. That they were two mechanisms with one
identity — rather than two identities to keep in step — is the point; a second
token would just be the same bug waiting in a new place.

The test needed two attempts and the first was worthless. It set B's marker
after awaiting A, by which time A's cleanup had already run, so there was no
race and it passed with the ownership check removed. It now holds A inside its
flush so A is genuinely mid-settle when B takes over, and reddens when the check
is taken out.

## Round 13 — three production fixes the earlier rounds had only described

`2026-09-12` — architecture review, and each of these replaced a claim with a
mechanism.

- **A delivered callback destroyed a disk-only pending plan.** Not by clearing
  it — that was fixed rounds ago — but by writing a record that had never heard
  of it, because the metadata projection strips the field and the persist
  rebuilds the header from managed state. The test that "covered" this mirrored
  the field onto the managed session, which is a state the product cannot reach,
  so it was validating fiction. The callback now hydrates the stored value
  synchronously at its commit (the storage accessor is sync, so nothing yields
  between guard and commit), and the test starts from the real representation:
  plan on disk only, deliver, reload, unchanged.
- **`durable: true` could be a lie.** The persistence queue catches its own
  write errors so its fire-and-forget callers keep working, which made a failed
  write indistinguishable from a successful one to anyone awaiting `flush`. Added
  `flushChecked` — additive, with `flush` and every existing caller untouched —
  which reports the actual write outcome, and `onDurable` now fires only on a
  verified success. An injected write failure reports `durable: false`, and the
  audit never says otherwise.
- **The callback-first/user-second interleaving test was passing for the wrong
  reason.** It released the callback's flush before the user send reached its
  branch, so the send queued on `isProcessing` and the marker was never
  consulted — it passed with the marker check removed. It now holds the flush
  open until the send has reached the decision, asserts `isProcessing` is still
  false at that moment, and asserts that *that* message is in the queue rather
  than merely that the queue is non-empty.

## Round 14 — both fixes from round 13 had a hole

`2026-09-12` — two P1s, one in each of the previous round's mechanisms.

- **The checked receipt could succeed too early.** `write` removes its pending
  entry *before* it touches the filesystem, so a checked flush arriving while a
  write was mid-I/O found an empty queue and reported success — with the bytes
  still in flight and the failure not yet known. It now awaits any in-progress
  write first, and the debounced timer path registers its write the same way the
  flush path already did, so "in progress" means it regardless of who started
  it. The test had to fail at an **async** step to exercise this at all: an
  ENOTDIR from `mkdir` is raised synchronously, so the whole write settles
  before anything can observe it and the window does not exist.
- **A cleared plan could reappear.** Mirroring the stored plan onto the managed
  session solved the write, but the mirror outlived it: the user-send and
  explicit-clear paths delete the STORED value only, so a later persist of that
  managed session would write the dismissed plan back and offer to resume work
  the user had moved past. The mirror is now dropped immediately after the
  persist that needed it — `persistSession` snapshots synchronously, so the
  enqueued record already has it — and clearing the stored value clears any
  mirror too.

## Round 15 — write tracking needed the same ownership rule

`2026-09-12` — one P1, and the third appearance of one idea: **any state keyed
by session and released after an await needs an owner.** The reservation needed
it, the accepted-turn marker needed it, and now the queue's in-flight write
tracking needs it. An older call's `finally` was deleting the entry
unconditionally, so a newer write could be untracked — after which a checked
flush sees no pending and no in-flight work and reports success over bytes still
being written. Both `flush` and `flushChecked` now delete only their own entry.

**The test is deliberately white-box, and the reason is recorded here rather
than buried.** The real interleaving cannot be produced in-process: these writes
settle far too quickly for one to still be running when the next registers, and
two attempts at a "natural" version both passed with the fix removed. Rather
than ship a third test that looks like coverage, it installs a successor entry
while the older call is in flight and asserts the older call's cleanup leaves it
alone — which is exactly the rule, and it reddens when the rule is removed.

## Round 16 — the mirror made real, and the queue given one tail

`2026-09-12` — final review. Six items; the two P1s replaced workarounds with
the actual mechanism.

- **Pending plan is a lifecycle mirror, not a rescue.** Hydrating it for the
  callback's write alone fixed this feature and left the product defect in
  place: the field was stripped by `headerToMetadata`, so any writer's next
  persist dropped it. It now flows through metadata into the managed session at
  load, and `set` / `markDispatched` / `clear` each update disk and mirror
  together. The callback's temporary set-and-clear is gone. Tested across the
  real startup projection and several later persists in a callback turn — and
  the test is built from `listSessions` metadata rather than by assigning the
  field, because assigning it bypasses the very projection that used to drop it.
- **The persistence queue has one tail per session.** Debounced, flushed and
  checked writes all chain onto it, so two writes for a session can never be in
  flight against the shared `.tmp` at once — interleaved writers can rename a
  half-written temp file over a good session and lose bytes with no error
  anywhere. Receipts are keyed to a **generation**: a later write satisfies one
  (it contains the snapshot), an older write completing does not, and a failure
  settles its own generation immediately rather than leaving a caller to hang
  until something else happens to supersede it. `writeInProgress` and its
  ownership dance are deleted — the tail makes the race structurally impossible
  rather than guarded.
- **A user send into the accepted-turn window queues directly.** No redirect, so
  no `forceAbort` against a turn that has not started, and `wasInterrupted`
  stays false — otherwise the replayed turn injects "your previous response was
  interrupted" in front of a turn that never began.
- **A write failure resolves the callback at the receipt**, not at the end of
  the turn or the broker's deadline. A failed write is an answer; making the
  caller time out to learn it turns a disk error into what looks like a slow
  turn.
- Reservation-token release and the both-placeholder provenance fallback have
  direct tests.

## Round 17 — the two new mechanisms each had a gap

`2026-09-12` — Greptile 3/5. Both findings were in the round-16 work.

- **`cancel()` did not stop a write already on the tail.** It drops the pending
  entry, but a write past that point finishes and renames its temp file over a
  session the caller has deleted — recreating state meant to be gone, silently.
  A cancelled flag is now checked when a write starts and again immediately
  before the rename, and the temp file is removed rather than left as litter a
  later reader could misread. A fresh enqueue clears the flag, so a cancel
  cannot suppress every later write for the process's lifetime.
- **`markCompactionComplete` left the mirror stale.** Round 16 updated `set`,
  `markDispatched` and `clear` and missed this one, so a later persist would
  write `awaitingCompaction: true` back — un-completing a compaction that had
  finished and sending reload recovery back to waiting for something that had
  already happened. Every owner now updates disk and mirror together.

**One guard is deliberately not covered by a test, and the code says so.** The
pre-rename cancel check defends a cancel landing *mid-I/O*; this suite's writes
settle far too fast to construct that, and the first version of the test passed
with the check removed because cancel had actually landed before the write even
started. Rather than leave a test implying coverage it does not have, it now
states what it covers — cancel-before-start — and both the test and the code
name the uncovered case explicitly.

## Residuals

- **The webhook containment fix is behavioral.** A desktop webhook that had been
  relying on cross-workspace `{ id }` targeting — resolving a session by id from
  any loaded workspace and acting on it with the calling workspace's root path —
  now records `deferred:target-not-found` instead. That was never a supported
  contract and the standalone host never had it, but it is a behavior change to
  an existing path, not only to the new one.
- **`apps/server`'s standalone resolver was left alone.** It reads sessions from
  a workspace root path on disk, so it is already contained by construction and
  shares neither the bug nor the fix. Converging it on the shared primitive would
  be a refactor with no security content.
- **Desktop-only, like every privileged Page action.** Activation tickets mint
  only through Electron `ipcMain`, so WebUI and headless hosts cannot fire a
  callback at all. This inherits SUV-0065's residual rather than adding one.
- **A page can learn whether a session id is live in its own workspace** by
  requesting a grant and seeing it refused before any dialog. The resolution is
  placed after the lease check so only a mounted render can probe, and a mounted
  render is already showing that workspace to the user.
- **A grant descriptor can be edited on disk without invalidating its digest.**
  The content digest a grant is bound to covers `index.html`, not `page.json`,
  and the pinned `sessionId` and `message` live in `page.json`. So anything with
  local filesystem write access to the workspace can change what an approved
  callback says, or which session it targets, while the grant continues to
  validate.

  **This is not a privilege escalation, and the distinction matters.** An actor
  who can write `page.json` can already write `index.html`, drop a script and
  request a script grant, or edit `automations.json` — ADR-0021's model treats
  local filesystem write as *already inside* the trust boundary, which is why
  `automations.json` rules are "reviewed at registration" rather than
  re-verified per run. Nothing here grants a capability that actor did not have.

  What it does cost is **provenance**: the audit row names a grant the user
  approved, and the user may have approved different words. Two things narrow
  the window rather than close it — host-rendered first-use confirmation per
  render shows the descriptor *as it stands on disk at that moment*, so an
  edited body is surfaced to the user the next time the page is opened; and the
  activation ticket binds `pageActionDescriptorSignature`, which is re-checked
  after a queue wait, so a swap mid-flight is refused outright.

  Closing it properly means extending the digest to cover the grant descriptors
  themselves, which changes what "content changed" means for every existing
  grant kind and belongs in its own SUV rather than smuggled into this one.
- **`pendingPlanExecution` is now a real managed mirror, and the general defect
  is fixed rather than sidestepped.** It was stripped by `headerToMetadata`, so
  it lived only on disk and the next persist from ANY writer silently dropped
  it. The first fix here hydrated it for the callback's write alone, which
  rescued this feature and left the product bug intact. It now flows through
  metadata into the managed session at load, and every owner
  (`set`/`markDispatched`/`clear`) updates disk and mirror together — so the
  field survives an ordinary session lifetime, and a dismissal stays dismissed.
