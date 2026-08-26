---
id: SUV-0029
title: Adopt Headroom multi-layer memory for sessions and workflows
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related: []
blocked-by:
  - SUV-0018-resolved-config-drives-the-headroom-boundary.md (memory rides the same config-driven adapter)
---

# SUV-0029 — Adopt Headroom multi-layer memory for sessions and workflows

## Goal

Make Headroom's multi-layer memory the flag-gated memory substrate for agent
sessions and workflow runs, exposed through memory operations on the boundary
adapter.

## Scope

- Extend the `HeadroomAdapter` boundary (SUV-0015) with the memory operations
  the plan needs — write, query, and provenance-carrying reads — backed by
  Headroom's memory layers with its default local-markdown substrate; the
  no-op adapter reports memory as unavailable.
- Wire session and Conductor workflow construction so agents read and write
  through that memory when the workspace flag enables it.
- Deliberately out: the pluggable extension interface (SUV-0030), the
  agentic-memory v2 backend (SUV-0031), and `headroom learn` mining.

## Acceptance

- [ ] The boundary adapter exposes memory operations, and the only production import of Headroom's memory APIs remains inside the boundary module (SUV-0015 guard still passes).
- [ ] In an enabled workspace, a memory written during one session is retrievable in a later session and in a workflow run, asserted by an integration test.
- [ ] The memory substrate on disk is local markdown, human-readable, and nothing is sent off-machine — verified against the SUV-0014 telemetry audit's opt-in findings.
- [ ] With Headroom disabled or absent, sessions and workflows run unchanged and memory operations report unavailable rather than throwing.

## Status log

- `2026-08-26` — created in `planned/`
