---
id: SUV-0002
title: SUV corpus scaffolding and work-management instructions
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
related:
  - ADR-0028-suv-as-the-shippable-unit-between-plan-and-task.md
blocked-by: []
---

# SUV-0002 — SUV corpus scaffolding and work-management instructions

## Goal

The SUV corpus exists as files, and an agent reading this repo cold learns the
DIR → ADR → PLAN → SUV → task ladder without being told.

## Scope

- `roadmap/suvs/` with the plan status folders verbatim (`planned/`,
  `in-progress/`, `blocked/`, `done/`, `documented/`, `archived/`) plus
  `definitions/`, all tracked via `.gitkeep`.
- `roadmap/suvs/_template.md` — frontmatter exactly `id`, `title`, `status`,
  `plan`, `direction`, `owner`, `created`, `updated`, `related`, `blocked-by`;
  body Goal / Scope / Acceptance / Status log. Shorter than the plan template.
- `roadmap/suvs/README.md` — folders, lifecycle, `SUV-NNNN` four-digit naming,
  frontmatter contract, the `plan:` ownership edge, and where definitions live.
- `roadmap/README.md`, `roadmap/plans/README.md`, `roadmap/plans/_template.md`
  updated: `suvs/` in the layout, the ladder, `related-suvs:` on plans.
- `.agents/skills/roadmap-suv-create/SKILL.md`, registered in
  `.agents/skills/README.md`; `roadmap-plan-advance` noted as serving both
  corpora off one transition graph.
- `CLAUDE.md` / `AGENTS.md` kept in sync, carrying the instruction that
  **advancing a plan means working at SUV granularity**.

## Non-scope

- No `corpus.py` change (SUV-0003) and no console rendering (SUV-0004). Files
  and instructions only.

## Acceptance

- [ ] `roadmap/suvs/{planned,in-progress,blocked,done,documented,archived,definitions}` all exist and are tracked.
- [ ] `_template.md` frontmatter keys match the ADR-0028 contract exactly, in order.
- [ ] `roadmap/README.md` shows `suvs/` in the layout tree and states the ladder.
- [ ] `roadmap/plans/README.md` documents `related-suvs:` and points at `../suvs/`.
- [ ] `CLAUDE.md` and `AGENTS.md` are mirror-consistent on the ladder and both cite ADR-0028.
- [ ] `[skill:roadmap-suv-create]` is listed in `.agents/skills/README.md`, `CLAUDE.md`, and `AGENTS.md`.
- [ ] Pre-commit hooks pass without `--no-verify`.

## Status log

- `2026-08-23` — created in `planned/`. Written alongside the scaffolding it describes, on `jh/plan-043-roadmap-work-surface`.
- `2026-08-23` — moved from `planned` to `in-progress`: Work executed 2026-08-23 in the PLAN-043 SUV bring-up.
- `2026-08-23` — moved from `in-progress` to `done`: Corpus scaffolding, template, READMEs, CLAUDE/AGENTS ladder, and roadmap-suv-create skill landed in b3d39e9d. Verified: all seven status folders tracked, template frontmatter matches ADR-0028 order, hooks passed without --no-verify.
