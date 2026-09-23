---
id: SUV-0073
title: Auto-handoff workspace settings card
status: planned
plan: PLAN-055
direction: DIR-05
owner: jh
created: 2026-09-23
updated: 2026-09-23
related: [SUV-0071, SUV-0072, PLAN-003]
blocked-by: []
---

# SUV-0073 — Auto-handoff workspace settings card

## Goal

AI settings shows, under each workspace's token-limit card, an auto-handoff
card that edits `defaults.autoHandoff` (enable, prompt with `@skill` mentions,
follow-up status, archive) with complete i18n.

## Scope

- `apps/electron/src/renderer/pages/settings/AutoHandoffSettings.tsx`: one card
  per workspace rendered directly below `WorkspaceTokenThresholdsCard` in the
  existing token-thresholds section of `AiSettingsPage.tsx`.
- Controls: enabled toggle; prompt textarea (placeholder shows the default
  prompt, hint explains `@skill-slug` mentions); status select fed by
  `useStatuses` with a "leave unchanged" option; archive toggle. Persist through
  `updateWorkspaceSetting('autoHandoff', …)`; toast on failure.
- i18n keys under `settings.ai.autoHandoff.*` in `en.json` and every other
  locale; locale files stay sorted.
- Docs: a short "Automatic handoff" note in the automations guide next to the
  `ContextThresholdReached` event; release-notes bullet.
- Out: any change to the watcher or consumer (SUV-0071/0072).

## Acceptance

- [ ] The card appears under each workspace's token-threshold card and only when
      that section renders; disabled state greys the prompt, status, and archive
      controls.
- [ ] `bun run lint:i18n:parity`, `bun run lint:i18n:sorted`, and
      `bun run lint:i18n:coverage` pass with the new keys.
- [ ] Saving each control writes the merged `autoHandoff` object through the RPC
      and reflects the persisted value on reload.
- [ ] `apps/electron` typecheck is clean and `bun run lint:branding` passes.
- [ ] `next.md` gains an Improvements bullet; PLAN-055 moves to `done/`.

## Status log

- `2026-09-23` — created in `planned/` (id allocated from the all-refs floor;
  see SUV-0071 for the refused reservation push).
