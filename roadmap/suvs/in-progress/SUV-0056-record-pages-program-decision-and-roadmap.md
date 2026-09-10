---
id: SUV-0056
title: Record Pages program decision and roadmap
status: in-progress
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [ADR-0033]
blocked-by: []
---

# SUV-0056 — Record Pages program decision and roadmap

## Goal

Land the owner-authorized Pages architecture decision and PR-sized execution
roadmap before implementation begins.

## Scope

- ADR-0033: upstream compatibility, per-workspace opt-in, host grant authority,
  pinned callback boundaries, isolated sharing topology, and privacy gate.
- PLAN-052 with its nine reserved SUVs and PLAN-053's deferred navigation
  evidence, reproduce-first caveat, separator decision, and post-merge sequence.
- DIR-04 and the ADR index backlinks.

Deliberately out: upstream integration or implementation changes. Each later
SUV owns exactly one implementation PR.

## Acceptance

- [ ] ADR-0033 is accepted and records additive compatibility plus every stated
      durable security, consent, sharing, and privacy boundary.
- [ ] PLAN-052 lists all nine reserved SUVs with one owner, explicit
      prerequisites, and checkable program acceptance.
- [ ] The activation experiment is required before relying on iframe activation;
      numeric ticket/TTL defaults are implementation policy, not owner gates.
- [ ] Proposed sharing retention is surfaced as the one pending Jeff gate and
      consistently blocks Worker deployment and the beta tag.
- [ ] DIR-04 and `roadmap/decisions/README.md` link to the new records.
- [ ] The corpus validator and `git diff --check` report no violations.

## Status log

- `2026-09-10` — created in `planned/` from the approved 0.22.0-beta.1
  program and all five Phase 1 research artifacts.
- `2026-09-10` — moved from `planned` to `in-progress`: authoring the decision
  and roadmap PR before any implementation SUV begins.
