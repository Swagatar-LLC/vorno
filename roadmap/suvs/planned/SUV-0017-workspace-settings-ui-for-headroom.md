---
id: SUV-0017
title: Workspace settings UI for Headroom
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related: []
blocked-by:
  - SUV-0016-headroom-config-schema-storage-and-precedence.md (the schema and storage this UI edits)
---

# SUV-0017 — Workspace settings UI for Headroom

## Goal

Give each workspace a settings surface to enable/disable Headroom and edit its
integration options, persisted through the SUV-0016 storage.

## Scope

- A Headroom section in the Electron workspace settings UI (`apps/electron`):
  enable/disable toggle plus controls for the SUV-0016 option fields.
- Each field shows its effective value and where it came from — workspace
  override vs instance default — and a workspace override can be cleared back
  to the instance default.
- Reads and writes go through the SUV-0016 storage and resolver only; the UI
  holds no config logic of its own.
- Deliberately out: editing the instance base config (shown as defaults only —
  its editing surface is decided with the server-hosted end-state), and any
  runtime effect of the toggle (SUV-0018).

## Acceptance

- [ ] Workspace settings show a Headroom section with an enable/disable toggle and the SUV-0016 option fields; changes persist via the SUV-0016 storage and survive an app restart.
- [ ] Each field indicates whether its effective value comes from a workspace override or the instance default, and clearing an override reverts the display to the instance value.
- [ ] Two workspaces hold independent Headroom settings — a test (or scripted scenario) toggles Headroom on in one workspace and verifies the other still resolves to disabled.
- [ ] The section renders and saves correctly when no Headroom config exists yet (fresh install path), defaulting the toggle to off.

## Status log

- `2026-08-25` — created in `planned/`
