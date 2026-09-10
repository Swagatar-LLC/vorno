---
id: SUV-0059
title: Secure page scripts and session callbacks
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0058, ADR-0033]
blocked-by: []
---

# SUV-0059 — Secure page scripts and session callbacks

## Goal

Let an enabled Page invoke an approved script or pinned session callback without
letting page content, renderer-only policy, or direct RPC invent privilege.

## Scope

- Add shared mutating classification and `PageActionOrigin`; unattributed
  callers fail closed at the authoritative broker.
- Add digest/lease-bound, single-use host activation tickets plus trusted
  first-use confirmation for script/session grants; run and record the iframe
  activation experiment before relying on its result.
- Add `session` descriptors as bare triggers with pinned targets/actions/body;
  reuse existing script/session executors, workspace membership, origin, and
  closure guards.
- Clamp type-specific TTLs; implement revoke, replay, lease-scoped in-flight
  keys/cancellation, rate limits, containment, and redacted audit outcomes.

## Acceptance

- [ ] Table-driven tests classify every descriptor kind; only API GET is
      non-mutating and a new kind cannot silently evade classification.
- [ ] Direct RPC, desktop, and WebUI cannot run a mutating action without the
      approved origin, lease/nonce, grant/digest, fresh ticket, and required
      host confirmation.
- [ ] Ticket expiry, mismatch, single redemption, grant revocation, digest
      change, TTL clamp, replay, cancellation ownership, and page/workspace
      rate limits have regression tests.
- [ ] Script invocation remains argv/no-shell, workspace-confined, minimal-env,
      abort-aware execution through the existing runner.
- [ ] Session callbacks carry no invocation-time target or body, reject
      cross-workspace targets/escalation, and can never close a session.
- [ ] Approval, rejection, execution, cancel, timeout, and result are audited
      without credentials or sensitive callback payloads.

## Status log

- `2026-09-10` — created in `planned/`; follows the workspace gate and ADR-0033
  host-authority contract.
