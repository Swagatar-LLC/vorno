---
id: SUV-0028
title: Token displays and thresholds read through Headroom stats
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related:
  - SUV-0027-in-app-headroom-savings-and-stats-report-view.md (the savings report; this SUV migrates the existing token surfaces)
blocked-by:
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (Headroom-sourced numbers must exist before surfaces migrate onto them)
---

# SUV-0028 — Token displays and thresholds read through Headroom stats

## Goal

Migrate Vorno's existing token usage displays and thresholds (the PLAN-002/003
surfaces) to read through Headroom's stats where they overlap, so token budget
management runs on one measured source.

## Scope

- The PLAN-002 token usage display and PLAN-003 threshold evaluation consume
  Headroom-sourced counts through the boundary adapter where the data
  overlaps; Vorno-side glue stays thin app code.
- `resolveThresholds()` precedence (per-model override → per-provider →
  default, warn < danger) is the contract to preserve, not redesign.
- Denominator discipline: every percentage carries its denominator (context
  window) from a known source or declares it unknown — no silent
  `contextWindow: 200_000` fallbacks feeding confident lies.
- Any gap between Vorno's token-management needs and Headroom's features is
  recorded as thin glue or filed upstream — explicitly not a new library.
- Deliberately out: the savings report view (SUV-0027) and any threshold
  semantics changes.

## Acceptance

- [ ] Token usage displays source their counts through the boundary adapter's stats where Headroom covers them, with the previous source retained only where Headroom has no equivalent — the split documented in the PR.
- [ ] Existing `resolveThresholds()` precedence tests pass unchanged, and threshold warn/danger states fire from the migrated counts in a test scenario.
- [ ] No percentage renders without a known denominator: a test with an unknown context window asserts the display declares it unknown instead of computing against a default.
- [ ] Gaps between needed token management and Headroom's features are listed in the PR as glue-vs-upstream dispositions, with upstream issues linked where filed.
- [ ] With Headroom disabled, displays and thresholds fall back to today's behavior unchanged.

## Status log

- `2026-08-26` — created in `planned/`
