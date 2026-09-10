---
id: SUV-0059
title: Secure page grant authority and actions
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0058, ADR-0033]
blocked-by: []
---

# SUV-0059 — Secure page grant authority and actions

## Goal

Make host-consented page grants and script actions safe from page content,
renderer-only policy, or direct RPC privilege invention.

## Scope

- Add shared mutating classification and `PageActionOrigin`; unattributed
  callers fail closed at the authoritative broker.
- Replace privileged direct `pages:issueGrant` with host-driven
  `pages:requestGrant`: render consent before persistence and refuse direct
  issuance as ADR-0033's sanctioned wire-behavior divergence.
- Add digest/lease-bound, single-use host activation tickets plus trusted
  first-use confirmation for script grants. Initial policy defaults are a
  five-second ticket TTL, at most three outstanding tickets per lease, and
  type-specific clamped grant TTLs; these defaults remain changeable policy.
  Run and record the iframe activation experiment before relying on it.
- Add grant listing, management, immediate revoke, replay/in-flight/rate/cancel
  hardening, containment, permission-mode revalidation, and redacted audit
  outcomes. Scheduled refresh scripts must use a user-approved declared grant
  before recurring execution.

Session callback execution, pinned payloads, and shared target-session handling
are deliberately owned by SUV-0064.

## Acceptance

- [ ] Table-driven tests classify every descriptor kind; only API GET is
      non-mutating, a new kind cannot silently evade classification, and
      unattributed mutation fails closed.
- [ ] `pages:requestGrant` persists a grant only after host-rendered consent;
      direct `pages:issueGrant`, decline, disconnect, and no response leave no
      privileged grant.
- [ ] The Electron activation experiment is recorded; invocation requires a
      fresh ticket/required confirmation and revalidates origin, permission
      mode, workspace, lease/nonce, digest, expiry, and grant every time.
- [ ] Users can list, inspect, and revoke grants; digest change, revocation,
      type-specific TTL clamp, ticket expiry/mismatch, and single redemption
      have regression coverage.
- [ ] Script and refresh execution remain argv/no-shell, workspace-confined,
      minimal-env, abort-aware, and use a user-approved declared grant before
      every recurring run.
- [ ] Replay, lease-scoped in-flight keys/cancellation, page/workspace rate
      limits, timeout, rejection, execution, and result are audited without
      credentials or sensitive payloads.

## Status log

- `2026-09-10` — created in `planned/`; follows the workspace gate and
  ADR-0033 host-authority contract.
- `2026-09-10` — split: host grant/action authority remains here; pinned session
  callback execution moves to reserved SUV-0064.
