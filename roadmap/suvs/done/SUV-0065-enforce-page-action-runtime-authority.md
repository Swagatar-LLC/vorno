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

## Reopen, and what closed it

`2026-09-11` — independent architecture review of PR #204 did not clear. Three
acceptance items are un-ticked again because they were claimed on checks that a
production caller does not actually reach:

- queued actions re-validated a `PageConfig` snapshot loaded before the wait, so
  a revocation or content change during the wait was invisible;
- the scheduled-refresh origin is enforced at the broker but production cron
  refresh never enters the broker, so "every invocation" was true of the code
  path under test and not of the product;
- audit rows carried the raw API path, query params, and MCP arguments, which is
  caller payload rather than metadata.

`2026-09-11` — closed again. Each item was fixed on the real path rather than
argued down:

- **Queued actions reload from disk.** An injected `loadCurrentPage` re-reads
  `page.json` immediately before the executor, so a revocation or content change
  during the wait is seen; the reloaded config is also what executes, and a host
  with no reload seam refuses rather than falling back to the snapshot.
- **Scheduled refresh now enters authoritative admission.** `pages/scheduled-admission.ts`
  runs origin policy, permission mode, grant existence, digest binding, expiry,
  and descriptor identity, and audits every decision — called by the scheduler
  immediately before spawn. No lease or nonce is invented for a run that has no
  render, and no second execution path was created: the hardened argv runner
  still owns spawning.
- **Audit is metadata only.** No path, params, or MCP arguments are recorded at
  all. Key-name redaction could only ever catch keys it recognized.
- **First-use sheets are abortable.** Registered under the PR #203 requester and
  lease, so a lease release or a retired render closes the sheet instead of
  stalling the serially-drained host queue behind a prompt nobody can answer.
- **`dropLease` aborts before it deletes.** Cancellation is authorized against
  the lease, so deleting first left a lease's own in-flight actions running with
  nothing able to reach them.
- **`host-ui` and `mayMutate` are gone** — an origin with no caller and a field
  that was true for every row.

## Learnings

- `vorno-internal:learnings/LEARNING-085-consent-caches-key-on-the-command-not-the-grant-id.md`
  — a grant id names a slot, not a command; consent caches and activation
  tickets must both carry the descriptor, and fixing one does not fix the other.

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
