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
