---
id: PLAN-026
title: Composed surfaces v1 — declarative spec over the trusted block catalog (C2)
status: archived
direction: DIR-04
owner: jh
created: 2026-07-21
updated: 2026-08-22
related:
  - PLAN-025-artifact-plane-v1.md
blocked-by:
  - PLAN-025-artifact-plane-v1.md
---

# PLAN-026 — Composed surfaces v1: declarative spec over the trusted block catalog (C2)

## Goal

An agent can generate a persistent, native-rendering page — dashboard, board, report — as a versioned declarative composition of Vorno's existing trusted blocks, stored and organized as an artifact.

## Scope

- **Surface spec v1**: versioned JSON (additive-only evolution per ADR-0013 discipline) describing layout (panes/sections) + block instances (markdown, mermaid, datatable, spreadsheet, html-preview) + data bindings to artifacts by URI.
- **Generic host page**: one renderer page that loads any surface artifact and renders it via the existing block components; desktop + WebUI free.
- **Surface = artifact**: surfaces persist through the PLAN-025 plane (typed `surface/composed`, versioned, related to the artifacts they render); they appear in Artifact Home like everything else.
- **Round-trip v0**: block-level actions (open artifact, ask-agent on a selection, refresh binding) route into sessions via existing `sessions:*` plumbing — the workbench's question-loop pattern, generalized.
- **Catalog gap, first installment**: an **editable datagrid** block (edit cell → typed change event → artifact update or session message). Editable graph/diagram interfaces and smart chips are scoped subsequent installments (tracked here, likely split out when reached; ADR-0015 §3).
- **Door ADR before code**: surface spec format (owner sign-off — the format is owned forever).

## Non-goals

- Sandboxed HTML/scripted surfaces (C3 — PLAN-027).
- A visual surface-builder UI (agents author surfaces in v1; humans edit via agent or JSON).
- Smart chips and editable diagrams in v1 (subsequent installments).
- Skill-contributed blocks (DIR-02, C4).

## Approach

The block catalog already renders everything; C2 adds composition (spec + host page), persistence (via the artifact plane), and the action round-trip. Detailed sketch on advance to in-progress, after the spec door-ADR.

## Acceptance

- [ ] An agent generates "dashboard of open plans by status" as a surface artifact; it renders natively and survives restart
- [ ] Surface appears in Artifact Home with `renders` relations to its data artifacts
- [ ] Editable datagrid: a cell edit round-trips to a persisted change
- [ ] Ask-agent from a surface block lands in a chosen session (workbench loop, generalized)
- [ ] Door ADR (spec format) accepted before implementation
- [ ] Tests added/updated; CI-parity gates green; behind feature flag
- [ ] Roadmap docs updated

## Status log

- `2026-07-21` — created in `planned/` (C2 of the ADR-0015 ladder)
- `2026-08-22` — **archived (PLAN-045 Pass 2)**: pre-DIR-05, and blocked behind PLAN-025, which is itself blocked on owner QA — a queued plan with no live head. Its durable idea (a typed run form may be an instance of the composed-surface spec) was salvaged into `PLAN-039-workflow-definitions-reusable-parameterized-tasks.md`. The C2 ambition survives as DIR-04 direction text, not as a queued plan. Mining record: [`2026-08-22-plan-045-mining-report.md`](../../discussions/2026-08-22-plan-045-mining-report.md).
