---
id: SUV-0016
title: Headroom config schema, storage, and precedence
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related: []
blocked-by: []
---

# SUV-0016 — Headroom config schema, storage, and precedence

## Goal

Define and persist Headroom configuration as instance-level base config plus
per-workspace overrides, with one resolver that yields the effective config.

## Scope

- Config types in `packages/core`: an enable/disable flag plus integration
  options (compression engines, verbosity steering, stats exposure — the
  options the boundary adapter accepts), identical shape at instance and
  workspace level.
- Storage in `packages/shared` config machinery: instance base config at the
  config root, workspace overrides in per-workspace settings, following the
  existing settings persistence patterns.
- `resolveHeadroomConfig(instance, workspace)` — workspace overrides instance
  base, field-level; default is disabled everywhere until benchmarks set
  rollout defaults (plan I0).
- Types and resolver are transport-neutral: plain serializable data, no
  Electron or local-filesystem assumptions, so a future server-hosted instance
  supplies the same shapes over the wire.
- Deliberately out: any UI (SUV-0017), and wiring the resolved config into the
  boundary adapter (SUV-0018).

## Acceptance

- [ ] Headroom config types live in `packages/core`, are plain serializable data (round-trip through `JSON.parse(JSON.stringify(...))` in a test), and import nothing from Electron or node filesystem modules.
- [ ] Instance base config and per-workspace overrides persist through the existing config storage in `packages/shared`, and a fresh install with neither file present resolves to disabled.
- [ ] `resolveHeadroomConfig()` applies field-level precedence — workspace value wins where set, instance base fills the rest — with tests covering: no config anywhere, instance-only, workspace-only, and workspace partially overriding instance.
- [ ] A malformed or partial config file resolves to safe defaults (disabled) rather than throwing, with a test feeding real-world-shaped bad input (unknown keys, wrong types).

## Status log

- `2026-08-25` — created in `planned/`
