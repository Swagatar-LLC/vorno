---
id: SUV-0065
title: Enforce Page action runtime authority
status: done
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-11
related: [SUV-0059, ADR-0033]
blocked-by: []
---

# SUV-0065 — Enforce Page action runtime authority

## Goal

Enforce every Page action at the authoritative runtime boundary so no renderer,
page, or direct RPC caller can bypass a consented grant's scope or fresh trusted
interaction proof.

## Scope

- Add shared mutating classification and `PageActionOrigin`; unattributed
  callers fail closed and a newly introduced descriptor cannot evade the
  classifier.
- Add trusted, digest/lease-bound, single-use activation tickets and required
  first-use confirmation. Ticket defaults remain policy within ADR-0033's
  10-second ceiling; run and record the iframe activation experiment before
  relying on its result.
- Revalidate origin, permission mode, workspace, page digest, grant, lease,
  nonce, expiry, and activation proof on every invocation.
- Implement replay defence, lease-scoped in-flight keys and cancellation,
  page/workspace rate limits, timeout, and redacted audit outcomes.

Grant issuance/lifecycle is SUV-0059; pinned session callback payload/execution
is SUV-0064.

## Acceptance

- [x] Table-driven tests classify every descriptor kind; only API GET is
      non-mutating, a new kind cannot silently evade classification, and
      unattributed mutation fails closed.
- [x] The Electron activation experiment is recorded; trusted tickets are
      digest/lease-bound, single-use, within the 10-second ceiling, and required
      first-use confirmation is enforced.
- [x] Every invocation revalidates origin, permission mode, workspace, page
      digest, approved grant, lease/nonce, expiry, and fresh activation proof;
      direct RPC, desktop, and WebUI cannot bypass the checks.
- [x] Script actions remain argv/no-shell, workspace-confined,
      minimal-environment, and abort-aware, with a direct runner test.
- [x] Replay, lease-scoped in-flight keys/cancellation, page/workspace rate
      limits, and timeout have regression coverage.
- [x] Rejection, execution, cancellation, timeout, and result are audited
      without credentials or sensitive payloads.

## Status log

- `2026-09-10` — created in `planned/` from reserved SUV-0065; split from
  SUV-0059 so runtime authority and trusted activation remain one reviewable PR.
- `2026-09-11` — moved from `planned` to `in-progress`: runtime authority,
  trusted activation, and the ADR-0033 activation experiment implementation
  began on the merged Pages baseline.
- `2026-09-11` — moved from `in-progress` to `done`. The ADR-0033 activation
  experiment was **run, not assumed**, and came back negative for its premise:
  parent `navigator.userActivation` reads `true` for a click over the Page and
  for one on unrelated app chrome, and Electron's `input-event` carries no
  frame identity, so no signal at any trust level attributes a gesture to the
  frame. Recorded with its rerunnable probe in
  `roadmap/evidence/SUV-0065/`; the implementation therefore takes the ADR's
  trusted-host-click branch rather than relying on frame proof, and the
  residual — that a real in-frame click may be invisible to `input-event` — is
  made safe by shape, since it fails as a refusal and never as a bypass.

## Residuals

Named here rather than left in PR threads, because each is a real limit a
future owner will meet.

- **Privileged Page actions are desktop-local.** Activation minting crosses
  Electron `ipcMain`, resolves the workspace from the local window map, and
  reaches the local broker — structurally identical to grant issuance in
  SUV-0059, which refuses transport RPC outright (`PAGE_GRANT_IPC_REQUIRED`).
  So a remote workspace cannot mint a grant *or* an activation, and the WebUI
  cannot mutate at all. This is consistent rather than new, but it does mean a
  grant approved while a workspace was local cannot be exercised against that
  workspace remotely. Raised in review of PR #204. Making the privileged Page
  surface work across the transport boundary needs the owning server to observe
  interaction, which is an architecture question, not an implementation fix.
- **One stray click can authorize one already-confirmed action.** After a
  grant's first confirmed use on a render, later invocations need a fresh
  unspent window gesture but no second dialog, and the SUV-0065 experiment
  proved a window gesture cannot be attributed to the Page frame. Confirming
  every invocation is friction ADR-0033 explicitly did not ask for.
- **Whether a real in-frame click is visible to `input-event` is unknown.**
  Measured only for synthesized input; see the evidence record. It fails as a
  refusal, never as a bypass.
