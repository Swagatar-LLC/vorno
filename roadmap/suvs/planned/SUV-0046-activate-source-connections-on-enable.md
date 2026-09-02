---
id: SUV-0046
title: Activate source MCP connections on enable, tear down on disable
status: planned
plan: PLAN-048
direction: DIR-03
owner: jh
created: 2026-09-01
updated: 2026-09-01
related:
  - ADR-0022
blocked-by: []
---

# SUV-0046 — Activate source MCP connections on enable, tear down on disable

## Goal

Enabling a source on a running session establishes its MCP connection and
registers its tools, so they are callable on the next turn.

## Scope

- On source enable: establish the MCP connection and register the source's tools
  into the running session's tool registry.
- On source disable: tear down the connection and deregister its tools.
- Surface an explicit failure state when activation cannot complete (auth
  required, stdio subprocess crash, unreachable endpoint). A source with no live
  connection must never render as `Active`.
- Deferred-tool discovery (`ToolSearch`) must see newly registered tools without
  a restart.

**Deliberately out:** namespace collisions between sources sharing an endpoint —
that is SUV-0047, and this SUV does not fix the motivating scenario on its own.
Config edits to an already-enabled source are out of scope for the whole plan.

## Acceptance

- [ ] Enabling a source mid-session registers its tools; they are callable on the
      next turn with no session restart
- [ ] Disabling a source deregisters its tools; subsequent calls fail cleanly
      rather than hitting a stale connection
- [ ] A source that fails to activate shows an explicit error state distinguishable
      from both `Active` and `Inactive`
- [ ] `ToolSearch` surfaces tools registered after session start
- [ ] Tests cover enable → call, disable → call, and activation failure

## Status log

- `2026-09-01` — created in `planned/`
