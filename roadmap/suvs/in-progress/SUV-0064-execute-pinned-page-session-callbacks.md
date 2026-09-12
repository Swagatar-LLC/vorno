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
- **Consent leads with host-resolved target identity** and truncates the pinned
  body for display, so a 2,000-character message cannot bury which session is
  being authorized.

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
