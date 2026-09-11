---
id: SUV-0059
title: Manage host-consented Page grants
status: done
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0058, ADR-0033]
blocked-by: []
---

# SUV-0059 — Manage host-consented Page grants

## Goal

Give users host-consented, digest-bound Page grants that they can inspect,
revoke, and safely authorize for recurring refresh execution.

## Scope

- Replace privileged direct `pages:issueGrant` with host-driven
  `pages:requestGrant`: render consent before persistence and refuse direct
  issuance as ADR-0033's sanctioned wire-behavior divergence.
- Store digest-bound, expiring grants with type-specific TTL policy: initial
  defaults remain changeable policy within ADR-0033's 30-day ceiling.
- Add user grant listing, inspection, and immediate revocation; invalidate
  persisted grants when bound content changes.
- Require scheduled refresh to name a user-approved declared grant before it
  can be persisted or recur.

Runtime action authority, activation, and execution hardening are deliberately
owned by SUV-0065; session callbacks remain SUV-0064.

## Acceptance

- [x] `pages:requestGrant` persists a grant only after host-rendered consent;
      direct `pages:issueGrant`, decline, disconnect, and no response leave no
      privileged grant.
- [x] Persisted grants bind their approved descriptor and page digest, use
      type-specific TTL policy within the 30-day ceiling, and invalidate on
      bound-content change.
- [x] Users can list, inspect, and immediately revoke grants, with regression
      coverage for revocation and digest invalidation.
- [x] A scheduled refresh names a user-approved declared grant before it can be
      persisted or recur; unapproved refresh residual is refused.
- [x] Grant lifecycle storage/management tests do not own runtime action,
      activation, replay, or audit enforcement, which belongs to SUV-0065.

## Status log

- `2026-09-10` — created in `planned/`; follows the workspace gate and
  ADR-0033 host-authority contract.
- `2026-09-10` — narrowed: consented grant lifecycle and refresh approval
  remain here; runtime action hardening splits to reserved SUV-0065.

- `2026-09-10` — moved from planned to in-progress: host-authoritative consent and refresh-grant lifecycle implementation began.
- `2026-09-10` — moved from in-progress to done: host-held consent, direct-issue refusal, TTL/digest/revocation lifecycle, and declared refresh grants landed; runtime action authority remains SUV-0065.
