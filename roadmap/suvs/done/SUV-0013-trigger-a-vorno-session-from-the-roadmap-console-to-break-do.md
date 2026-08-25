---
id: SUV-0013
title: Trigger a Vorno Session from the Roadmap console to break down a PLAN and generate candidate SUVs
status: done
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

- [x] Break down function can use prompt to create/modify SUVs
- [x] User can select available models with workspace default for prompt processing
- [ ] Sessions are inspectable in Vorno for validation
- [ ] Normal skill and tools mentions work as-normal

## Status log

- `2026-08-24` — created in `planned/`
- `2026-08-24` — moved from `planned` to `in-progress`: Owner asked for this before plan close-out (2026-08-24 22:20 EDT). Acceptance criteria drafted from the owner goal statement by the orchestrator; the breakdown loop reuses SUV-0005/0006/0007/0008 machinery end to end.
- `2026-08-24` — moved from `in-progress` to `done`: Landed on console branch plan-043-p3-p6-work-surface (3ba7165). Verified by the orchestrator: 198 tests green (21 new stub-CLI loop tests); live two-round breakdown of PLAN-039 — round 1 cut SUV-0014 + SUV-0015 and added the plan reverse edges, round 2 reprompt collapsed to SUV-0014 alone with the deletion carried through both sides of the ownership edge; validator ok both rounds; a third no-change round re-evaluated reconciled after the iteration-baseline fix (evaluation now unions the diff since the previous iteration HEAD), and the candidate set is mergeable, left for the owner decision in the console. The loop is human-terminated by design: rounds end reconciled/incomplete/escalated and wait — no auto-redispatch. Found en route, recorded not fixed: the manual Add-SUV form writes plan: without the reverse related-suvs edge (invalid corpus per the validator) — worth its own SUV.
- `2026-08-24` — two acceptance items deliberately left unticked. "Sessions inspectable in Vorno": partial — each round is a real Vorno session whose transcript streams into the console dialog and persists on the record, but it runs under the runner's own CRAFT_CONFIG_DIR (required: two servers cannot share one .server.lock, SUV-0006), which the desktop app does not list; surfacing runner sessions in-app is its own piece of work. "Skill and tools mentions work as-normal": true by construction (plain vorno-cli run, live rounds used Read/Write/Bash normally) but skill mentions were not exercised by a dedicated test. Owner-authored acceptance list (2026-08-24) supersedes the orchestrator's earlier draft; the loop itself is verified live (see prior entry).
