---
id: SUV-0013
title: Trigger a Vorno Session from the Roadmap console to break down a PLAN and generate candidate SUVs
status: in-progress
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-24
updated: 2026-08-24
related: []
blocked-by: []
---

# SUV-0013 — Trigger a Vorno Session from the Roadmap console to break down a PLAN and generate candidate SUVs

## Goal

The Roadmap UI user can break down a plan into SUVs, including modifying existing SUVs, using an iterative set of prompt->view SUVs->modify->reprompt actions to bootstrap plan breakdown before task assembly.

## Scope

- IN: Using Vorno from the Roadmap UI to generate and regenerate SUVs for the current plan
- OUT: /What's deliberately out, if a reader would otherwise assume it in.

## Acceptance

- [ ] Break down function can use prompt to create/modify SUVs
- [ ] User can select available models with workspace default for prompt processing
- [ ] Sessions are inspectable in Vorno for validation
- [ ] Normal skill and tools mentions work as-normal

## Status log

- `2026-08-24` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Owner asked for this before plan close-out (2026-08-24 22:20 EDT). Acceptance criteria drafted from the owner goal statement by the orchestrator; the breakdown loop reuses SUV-0005/0006/0007/0008 machinery end to end.
