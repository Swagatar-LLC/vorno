---
id: SUV-0031
title: agentic-memory v2 as a plugged backend behind the interface
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related: []
blocked-by:
  - SUV-0030-memory-extension-interface-designed-and-proposed-upstream.md (the interface this backend plugs into)
---

# SUV-0031 — agentic-memory v2 as a plugged backend behind the interface

## Goal

Plug the private agentic-memory v2 engine in as a backend behind the SUV-0030
extension interface, and reduce the `agentic-memory` MCP source to a thin host
over it.

## Scope

- A backend implementation of the SUV-0030 interface wrapping the v2 engine —
  its gated loads, logged retrieval, PRG trims, and archive semantics become
  adapter behavior behind Headroom's memory, not a parallel engine.
- The `agentic-memory` MCP source rewired as a thin host over the plugged
  backend: its tools delegate; no engine logic remains in the source itself.
- Deliberately out: changes to the v2 engine's own semantics, and any new
  storage or query capability beyond what the interface carries.

## Acceptance

- [ ] The v2 engine is reachable only through the SUV-0030 interface as a registered backend — no session or workflow path calls it directly, verifiable by grep.
- [ ] Gated-load, retrieval-logging, and archive semantics behave the same through the plugged backend as before, asserted by tests exercising each through the interface.
- [ ] The `agentic-memory` MCP source's tools delegate to the plugged backend, and the source contains no engine logic of its own.
- [ ] Behaviors that could not express behind the interface (if any) are listed with the upstream ask that would unblock them, matching plan open question 3.

## Status log

- `2026-08-26` — created in `planned/`
