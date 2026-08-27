---
id: SUV-0024
title: Compress context in Conductor node dispatch
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related:
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (same adapter pattern, session-loop side)
blocked-by:
  - SUV-0018-resolved-config-drives-the-headroom-boundary.md (dispatch needs the config-driven adapter)
---

# SUV-0024 — Compress context in Conductor node dispatch

## Goal

Wire the `HeadroomAdapter` into Conductor node dispatch so workflow runs
(PLAN-039) execute with compression active on the context handed between nodes.

## Scope

- Conductor dispatch call sites: node outputs and context carried into
  downstream nodes pass through `adapter.compress()`, with retrieval handles
  preserved in the run record.
- Run-log durability untouched: Conductor persistence (run logs, node outputs)
  keeps storing what it stores today — Headroom manages context, not execution
  state (plan non-goal).
- Deliberately out: session-loop call sites (SUV-0023), benchmarks
  (SUV-0025), and any UI.

## Acceptance

- [ ] A workflow run in a Headroom-enabled workspace passes node outputs through `adapter.compress()` before they enter downstream node context, asserted by an integration test over a multi-node workflow.
- [ ] Retrieval handles for compressed node context are recorded and `adapter.retrieve()` returns byte-identical originals, asserted by a test.
- [ ] With Headroom disabled, workflow dispatch behavior and run records are unchanged from pre-SUV behavior.
- [ ] Existing Conductor persistence tests pass unchanged — run logs and node outputs are stored as before.

## Status log

- `2026-08-26` — created in `planned/`
