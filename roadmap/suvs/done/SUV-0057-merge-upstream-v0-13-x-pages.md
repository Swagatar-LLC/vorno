---
id: SUV-0057
title: Merge upstream v0.13.x Pages
status: done
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
preserving fork behavior and leaving Pages unavailable until SUV-0058.

## Scope

- Run a throwaway merge first and record the actual conflict set, resolving the
  prior 33-versus-34 reconstruction discrepancy from evidence rather than
  assumption.
- Resolve manifests hunk-wise, retain Vorno versions, take dependency bumps,
  take upstream `bun.lock`, then regenerate it with `bun install`.
- Preserve navigator unions/routes, automation action unions and canonical
  outcome helpers, model/OAuth fixes, memory/headroom/browser/task/session work,
  SDK lifecycle protections, and upstream Pages contracts.
- Take upstream's privacy-broadening Sentry redaction helper/refactor. Preserve
  the existing Sentry enablement, DSN, and telemetry posture; do not claim a
  byte-identical Sentry hunk or introduce a telemetry decision.
- Delete incoming upstream versioned release notes; add attributed Pages notes
  to `next.md`; audit `roadmap/upstream/compatibility.md`.

## Acceptance

- [x] A throwaway merge records the actual conflict count and paths before the
      production merge resolves them; `e8963854` is then an ancestor through an
      actual merge commit, not a squash or rebase.
- [x] Manifest versions remain Vorno-owned; upstream dependency changes and a
      regenerated lockfile are present without whole-file ours/theirs loss.
- [x] Routes, parser, renderer navigation, automation unions, and existing fork
      contracts are reconciled additively and pass their focused tests.
- [x] Claude depth/retry and Pi abort/recovered-output regressions are covered
      by tests, and required upstream-sync builds/tests pass.
- [x] Sentry enablement, DSN, and telemetry posture match the merge base while
      upstream's shared privacy-broadening redaction helper/refactor is taken.
- [x] Upstream release notes are attributed in `next.md`, the public
      compatibility audit records the result, and Pages remains disabled until
      the persisted workspace gate lands.

## Status log

- `2026-09-10` — created in `planned/`; follows the decision/roadmap PR and
  precedes all Pages feature lanes.
- `2026-09-10` — moved from `planned` to `in-progress`: beginning canonical upstream v0.13.x merge and conflict audit.
- `2026-09-10` — throwaway merge recorded 34 conflicted paths (the 34-path list is retained in merge commit `7a033d15`); production merge preserved `e8963854` as second parent. Focused regressions and upstream-sync gates passed; full CI typecheck stopped only on seven pre-existing `origin/main` errors.
- `2026-09-10` — moved from `in-progress` to `done`: upstream Pages baseline merged, sharing defaulted off with no Craft endpoint, compatibility and release-note audits recorded.
