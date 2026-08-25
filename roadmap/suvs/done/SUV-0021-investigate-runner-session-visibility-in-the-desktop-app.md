---
id: SUV-0021
title: Investigate runner-session visibility in the desktop app
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related:
  - SUV-0013-trigger-a-vorno-session-from-the-roadmap-console-to-break-do.md
blocked-by: []
---

# SUV-0021 — Investigate runner-session visibility in the desktop app

## Goal

Determine — honestly, in the code — what it would take for breakdown/feedback
runner sessions (which live under the runner's own `CRAFT_CONFIG_DIR`) to be
inspectable from the desktop app, and land either the console-side fix or the
written finding that it requires product change.

## Scope

- IN: reading the product's workspace/session discovery path
  (`packages/shared`, `apps/electron` main process) to establish precisely why
  `~/.craft-agent-roadmap-runner/` sessions are invisible, and what the
  smallest honest surfacing mechanism is.
- IN: anything console-side that closes the gap without product change (e.g.
  richer transcript/session metadata on the record, a path the owner can open).
- OUT: Vorno product change — PLAN-043's non-goal stands. If visibility
  requires one, the deliverable is the finding written into the PLAN-039
  evidence base (the authoring-gaps discussion or a sibling), scoped and
  referenced, not the change itself.

## Acceptance

- [ ] The invisibility is explained from named files/lines, not asserted.
- [ ] Either a console-side improvement lands with tests, or a written finding
  states what product change is required and where it belongs (PLAN-039/041),
  referenced from SUV-0013's open acceptance item.
- [ ] SUV-0013's "Sessions are inspectable in Vorno" box is resolved one way or
  the other: ticked with evidence, or explicitly re-homed to the finding.

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-25` — moved from `planned` to `in-progress`: Starting: verifying the investigation claims in code first.
- `2026-08-25` — moved from `in-progress` to `done`: Investigated from named code, then landed the safe console-side piece (console d8c2575). Invisibility explained: app discovery is one chain from CRAFT_CONFIG_DIR (paths.ts:27) through config.json workspaces (storage.ts:106/276/733) to a boot-time readdir (SessionManager.ts:2021-2029); unknown session ids are dropped by the watcher (SessionManager.ts:1737-1739); and vorno-cli deleted its session on exit (index.ts:643) — verified: both live runs left empty sessions dirs. Console fix: dispatch passes --no-cleanup, finished sessions are archived to a stable workspace (default ~/.craft-agent-roadmap-runner/archive) recorded on dispatch.sessions; owner registers it once via Open existing folder, sessions appear on next app launch. Product-change residual (live adoption + sessions:rescan) written as finding D7 in the authoring-gaps discussion, cross-referenced from SUV-0013. 214 console tests green.
