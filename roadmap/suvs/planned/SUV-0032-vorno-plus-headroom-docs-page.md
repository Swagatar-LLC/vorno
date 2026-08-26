---
id: SUV-0032
title: Vorno + Headroom docs page
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related:
  - SUV-0027-in-app-headroom-savings-and-stats-report-view.md (the report view the page documents)
  - SUV-0029-adopt-headroom-multi-layer-memory-for-sessions-and-workflows.md (the memory behavior the page documents)
blocked-by: []
---

# SUV-0032 — Vorno + Headroom docs page

## Goal

Publish the `vorno.ai/docs` page explaining what Headroom does in Vorno, how
to toggle it, and what leaves the machine (nothing without opt-in).

## Scope

- One docs page covering: what compression/token stats/memory do in Vorno,
  the workspace settings toggle (SUV-0017), viewing originals and the report
  view (SUV-0026/0027), memory behavior (SUV-0029), and the privacy posture
  grounded in the SUV-0014 telemetry audit.
- Written against shipped behavior — this SUV lands late, once the surfaces it
  describes exist.
- Deliberately out: developer/contributor docs for the extension interface
  (the SUV-0030 design doc serves that audience).

## Acceptance

- [ ] A page exists in the `vorno.ai/docs` content source covering what Headroom does in Vorno, how to enable/disable it per workspace, and how to view originals and the savings report.
- [ ] The privacy section states what leaves the machine and under what opt-in, consistent with the SUV-0014 telemetry audit findings — no claim the audit does not support.
- [ ] Every UI element the page references (toggle, report view, view-original affordance) exists in the app as described at time of merge.

## Status log

- `2026-08-26` — created in `planned/`
