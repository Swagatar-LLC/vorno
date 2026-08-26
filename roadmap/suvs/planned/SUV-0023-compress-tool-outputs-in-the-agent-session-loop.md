---
id: SUV-0023
title: Compress tool outputs in the agent session loop
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related: []
blocked-by:
  - SUV-0018-resolved-config-drives-the-headroom-boundary.md (sessions must already hold a config-driven adapter)
---

# SUV-0023 — Compress tool outputs in the agent session loop

## Goal

Make the agent session loop pass tool outputs through the session's
`HeadroomAdapter` so compression is actually active in enabled workspaces, with
originals retrievable through the adapter.

## Scope

- Call sites in the `packages/shared` session loop: tool outputs (the dominant
  context consumers) go through `adapter.compress()` before entering session
  context, and each compressed item carries a retrieval handle.
- All calls go through the SUV-0015 boundary — no new SDK imports.
- Disabled workspaces take the no-op path and behave byte-identically to today.
- Deliberately out: Conductor node dispatch (SUV-0024), any UI affordance for
  retrieval (SUV-0026), and stats surfaces (SUV-0027/0028).

## Acceptance

- [ ] In a Headroom-enabled workspace, tool outputs pass through `adapter.compress()` before entering session context, asserted by an integration test using a representative large tool output.
- [ ] Each compressed context item carries a retrieval handle, and `adapter.retrieve()` on that handle returns the byte-identical original, asserted by a round-trip test.
- [ ] With Headroom disabled, session context is byte-identical to pre-SUV behavior — a test compares transcripts with and without the change on the no-op path.
- [ ] The SUV-0015 import guard still passes: no file outside the boundary module imports the Headroom SDK.
- [ ] Existing session persistence/replay tests pass unchanged with compression active.

## Status log

- `2026-08-26` — created in `planned/`
