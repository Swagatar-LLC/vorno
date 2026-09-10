---
id: SUV-0057
title: Merge upstream v0.13.x Pages
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0056, ADR-0033]
blocked-by: []
---

# SUV-0057 — Merge upstream v0.13.x Pages

## Goal

Merge upstream `v0.13.0`–`v0.13.3` through `e8963854` with a merge commit while
preserving all fork behavior and leaving Pages unavailable until SUV-0058.

## Scope

- Resolve manifests hunk-wise, retain Vorno versions, take dependency bumps,
  take upstream `bun.lock`, then regenerate it with `bun install`.
- Preserve navigator unions/routes, automation action unions and canonical
  outcome helpers, model/OAuth fixes, memory/headroom/browser/task/session work,
  SDK lifecycle protections, and upstream Pages contracts.
- Delete incoming upstream versioned release notes; add attributed Pages notes
  to `next.md`; audit `roadmap/upstream/compatibility.md`.
- Preserve Sentry exactly as it exists from the merge base; no new telemetry
  configuration, enablement, or decision is part of this merge.

## Acceptance

- [ ] `e8963854` is an ancestor of the merge branch through an actual merge
      commit, not a squash or rebase.
- [ ] Manifest versions remain Vorno-owned; upstream dependency changes and a
      regenerated lockfile are present without whole-file ours/theirs loss.
- [ ] Routes, parser, renderer navigation, automation unions, and existing
      fork contracts are reconciled additively and pass their focused tests.
- [ ] Claude depth/retry and Pi abort/recovered-output regressions are covered
      by tests, and required builds/tests from the upstream-sync skill pass.
- [ ] Upstream release notes are attributed in `next.md`, and the public
      compatibility audit records the result.
- [ ] Pages remains disabled until the persisted workspace gate lands.

## Status log

- `2026-09-10` — created in `planned/`; follows the decision/roadmap PR and
  precedes all Pages feature lanes.
