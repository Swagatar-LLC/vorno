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

Land the approved Pages architecture decision and PR-sized execution roadmap
before implementation begins.

## Scope

- ADR-0033: upstream compatibility, per-workspace opt-in, callback authority,
  sharing topology, privacy gate, documentation/release invariants, and Sentry
  non-scope.
- PLAN-052 with its eight reserved SUVs and PLAN-053's deferred navigation
  evidence, reproduction-first caveat, separator decision, and post-merge
  sequence.
- DIR-04 and the ADR index backlinks.

Deliberately out: upstream integration or implementation changes. Each later
SUV owns exactly one implementation PR.

## Acceptance

- [ ] ADR-0033 records additive `pages:*`/`craft-pages/v1` compatibility and
      every stated security/privacy one-way contract.
- [ ] PLAN-052 lists all eight reserved SUVs with one owner and checkable
      program acceptance; PLAN-053 remains planned and release-unblocking.
- [ ] The callback activation premise, privacy/retention decision, and Sentry
      telemetry posture are surfaced as owner gates rather than assumed facts.
- [ ] DIR-04 and `roadmap/decisions/README.md` link to the new records.
- [ ] The corpus validator and `git diff --check` report no violations.

## Status log

- `2026-09-10` — created in `planned/` from the approved 0.22.0-beta.1
  program and all five Phase 1 research artifacts.
- `2026-09-10` — moved from `planned` to `in-progress`: authoring the decision
  and roadmap PR before any implementation SUV begins.
