---
id: SUV-0065
title: Enforce Page action runtime authority
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
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

- [ ] Table-driven tests classify every descriptor kind; only API GET is
      non-mutating, a new kind cannot silently evade classification, and
      unattributed mutation fails closed.
- [ ] The Electron activation experiment is recorded; trusted tickets are
      digest/lease-bound, single-use, within the 10-second ceiling, and required
      first-use confirmation is enforced.
- [ ] Every invocation revalidates origin, permission mode, workspace, page
      digest, approved grant, lease/nonce, expiry, and fresh activation proof;
      direct RPC, desktop, and WebUI cannot bypass the checks.
- [ ] Replay, lease-scoped in-flight keys/cancellation, page/workspace rate
      limits, and timeout have regression coverage.
- [ ] Rejection, execution, cancellation, timeout, and result are audited
      without credentials or sensitive payloads.

## Status log

- `2026-09-10` — created in `planned/` from reserved SUV-0065; split from
  SUV-0059 so runtime authority and trusted activation remain one reviewable PR.
