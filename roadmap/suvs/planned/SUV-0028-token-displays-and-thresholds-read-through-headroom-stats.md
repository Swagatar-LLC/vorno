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
- `2026-08-27` — implemented on `plan/plan-040`.

  **The migration is a verified negative, and that is the finding.** Checked the
  pinned `headroom-ai` SDK's actual type surface rather than its README, per
  PLAN-040's standing "verify at integration time" rule. Its entire stats
  surface — `SessionStats`, `ProxyStats`, `MetricsSummary`, `TOINStats` —
  measures *compression throughput only*: requests, tokensBefore/After/Saved,
  ratios, cache hits, retrieval rates. It carries **no** notion of a model
  context window and **no** notion of live context occupancy. So neither of the
  two counts the token surface renders has a Headroom equivalent:

  | Count | Source | Why not Headroom |
  |---|---|---|
  | `used` (input tokens, next prompt) | provider `usage_update` — retained | Headroom never sees an assembled prompt. SUV-0023 compresses individual tool outputs, SUV-0024 compresses inter-node Conductor context; neither measures window occupancy. The provider's count is already post-compression and is the only authority. |
  | `limit` (context window) | session-reported window → model registry — retained | No context-window field exists anywhere in the SDK's stats. `tokenBudget` is a compression *input* the caller supplies, not a measurement returned. |

  `ProxyStats.tokens.input` was considered and rejected: it is cumulative
  proxy-wide input across every client, and Vorno does not route model traffic
  through the Headroom proxy (SUV-0023/0024 call `compress()` directly). Real
  measurement, wrong subject.

  **What did land is the denominator discipline**, which was the scope bullet
  with a real defect behind it. `DEFAULT_CONTEXT_WINDOW = 200_000` is deleted.
  `computeContextUsage` now returns a discriminated union whose unknown arm
  carries no limit, no fraction and no threshold level, mirroring
  `HeadroomMeasurement`'s absent arm for the same reason. Every provider whose
  window Vorno cannot resolve previously rendered a percentage against a
  hardcoded 200k — e.g. a compat model at 50k tokens displayed a confident
  "25%" of a window nobody measured. It now displays `?` and no percentage.

  Indicator label derivation was extracted to a pure `describeContextUsage()`
  so "the display declares the window unknown" is directly assertable — this
  app has no React test harness, so leaving it in JSX would have left the
  acceptance criterion untestable.

  `resolveThresholds()` is byte-unchanged and its precedence tests are
  untouched. Thresholds now cannot fire while the denominator is unknown, since
  "80% full" is not a statement about an unknown window.

  Because nothing on this surface consults the Headroom adapter, disabling
  Headroom cannot change what it displays — acceptance #5 holds structurally
  rather than by fallback.

  Files: `context-usage.ts`, `ContextUsageIndicator.tsx`,
  `TokenUsageThresholdsSettings.tsx` (union narrowing), plus
  `__tests__/context-usage-denominator.test.ts` (new, 13 cases) and four
  reversed assertions in `__tests__/context-usage.test.ts` that encoded the
  removed fallback.

  Gates: all ten `validate-pr.yml` jobs run locally and green.
