---
id: PLAN-003
title: Make token-usage thresholds configurable per-model/per-provider in workspace settings
status: in-progress
direction: none
owner: jh
created: 2026-05-07
updated: 2026-05-07
related: [PLAN-002]
blocked-by: []
---

# PLAN-003 — Per-model / per-provider token-usage thresholds (workspace settings)

## Goal

Surface the green/yellow/burnt-orange threshold percentages from PLAN-002 as user-configurable values, scoped per **model** with per-**provider** defaults, persisted in the **workspace** config.

## Scope

- Schema addition to workspace config:
  - `tokenUsageThresholds: { [providerId: string]: { warn: number; danger: number } }`
  - Optional per-model override:
    `tokenUsageModelOverrides: { [modelId: string]: { warn: number; danger: number } }`
  - `warn` is the green→yellow boundary (e.g., 0.6); `danger` is the yellow→burnt-orange boundary (e.g., 0.8)
- Settings UI in the workspace settings panel (a new page or section under an existing panel):
  - List of providers + models the user has connections for
  - Two number inputs per row (warn %, danger %) with sane bounds (0 < warn < danger < 100)
  - Inline preview of the threshold bar at the chosen percentages
  - "Reset to defaults" button per row
- `ContextUsageIndicator` (from PLAN-002) reads the merged thresholds:
  1. Per-model override, if present
  2. Provider default, if present
  3. Built-in fallback (60 / 80)

## Non-goals

- **No** *cross-workspace* threshold sharing — settings live with the workspace
- **No** *per-session* thresholds (workspace granularity is enough for v1)
- **No** import/export of settings
- **No** thresholds for things other than context-window consumption (e.g., cost-in-USD)

## Approach

**Storage:**
- Workspace config already lives in `~/.craft-agent[-fork]/config.json` under each workspace's slot.
- Add the new fields to the workspace schema in `packages/shared/src/workspaces/types.ts` (or wherever the workspace shape lives — confirm during execution).
- Migration: existing configs without the field default to the built-in fallback.

**UI:**
- New settings page or section under existing AI/model settings.
- Component: `TokenUsageThresholdsSettings.tsx` — list of providers, expandable per-model rows.
- Re-uses existing form-input components in `packages/ui/`.

**Indicator integration:**
- `ContextUsageIndicator` consults a small new helper `resolveThresholds(providerId, modelId, workspace)` that merges per-model override → provider default → built-in fallback.
- Live-updates if user changes thresholds while a session is open.

**Validation:**
- `warn` must be strictly less than `danger`
- Both must be in `(0, 100)`
- Show inline error state on invalid input

## Acceptance

- [ ] Workspace schema extended; existing configs continue to load
- [ ] Settings UI exposes per-provider thresholds + per-model overrides
- [ ] Threshold validation (warn < danger; both in 0–100) with inline errors
- [ ] `ContextUsageIndicator` honors workspace settings, falling back through model→provider→default
- [ ] Live re-render of the indicator when settings change
- [ ] Bun tests for `resolveThresholds()` precedence
- [ ] Bun tests for schema migration (no thresholds → default; partial → complete)
- [ ] Manual screenshot of settings UI in PR description
- [ ] PR opened, CI green, merged, plan moved to `done/`

## Status log

- `2026-05-07` — created in `planned/`, blocked-by PLAN-002
- `2026-05-07` — moved from planned to in-progress (PLAN-002 shipped in PR #11/#14)
