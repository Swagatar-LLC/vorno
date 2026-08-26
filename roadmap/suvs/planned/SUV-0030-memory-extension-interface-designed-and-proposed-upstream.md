---
id: SUV-0030
title: Memory extension interface designed and proposed upstream
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related: []
blocked-by:
  - SUV-0029-adopt-headroom-multi-layer-memory-for-sessions-and-workflows.md (the interface extends the memory substrate in actual use)
---

# SUV-0030 — Memory extension interface designed and proposed upstream

## Goal

Design the pluggable extension interface for additional memory storage formats
and querying against Headroom's existing seams, and open it as an upstream
contribution.

## Scope

- An interface specification (storage-adapter / hook contract for alternative
  storage formats and query semantics) designed against Headroom's extension
  seams — pipeline hooks, compression hooks, provider slices — committed as a
  design doc in `roadmap/`, with query semantics that treat markdown
  frontmatter as already-structured data.
- The upstream contribution: an issue or PR opened on the Headroom repo
  proposing the interface. If upstream declines, the decline and the
  carry-a-patch rationale are documented instead — either outcome closes this
  SUV.
- Deliberately out: any backend implementation (SUV-0031 is the first
  consumer) and forking Headroom (plan non-goal — seams and upstream PRs
  only).

## Acceptance

- [ ] A design doc in `roadmap/` specifies the extension interface — operations, storage-format contract, query semantics — and names the specific Headroom seams it builds on.
- [ ] The design demonstrates (on paper) that the agentic-memory v2 engine's gated behaviors can express as a backend behind it, or records exactly which behaviors need upstream interface support.
- [ ] An upstream issue or PR proposing the interface is open on the Headroom repo and linked from the design doc — or upstream's decline is documented with the maintained-patch rationale.
- [ ] The design doc records what shape upstream maintainers indicated they would accept (plan open question 2), even if the answer is "no response yet" with a dated follow-up plan.

## Status log

- `2026-08-26` — created in `planned/`
