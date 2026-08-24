---
id: SUV-0007
title: Corpus validator as the termination predicate
status: in-progress
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
related:
  - SUV-0008-reconciling-feedback-prompt-with-a-bounded-loop.md
blocked-by: []
---

# SUV-0007 — Corpus validator as the termination predicate

## Goal

A single command answers "is the corpus internally consistent?" with a
machine-readable verdict, so a reconciliation run has a defined stopping
condition rather than a hoped-for one.

## Scope

- A validator over `roadmap/` checking, at minimum:
  - frontmatter `status` agrees with the containing status folder;
  - every status-folder record sits in a legal folder for its type;
  - `plan:` on an SUV resolves to an existing plan, and `direction:` resolves;
  - internal markdown links to corpus files resolve;
  - ids are unique and match the filename;
  - `related-suvs:` on a plan agrees with the SUVs claiming it.
- Exit code 0 clean / non-zero dirty, plus a structured report listing each
  violation with file and line.
- Runnable standalone from the console repo and from CI. Stdlib Python only.

## Non-scope

- No auto-fixing. The validator reports; the reconciliation agent fixes.
- No task.yaml schema validation — that is `validateTaskInput` (SUV-0010).

## Acceptance

- [ ] Running the validator on a clean `roadmap/` exits 0 with an empty violation list.
- [ ] Moving a plan file between folders without rewriting frontmatter is reported, with the file path.
- [ ] An SUV whose `plan:` names a nonexistent plan is reported.
- [ ] A plan whose `related-suvs:` omits an SUV that claims it is reported.
- [ ] A broken internal link to a corpus file is reported.
- [ ] Each check has a test that fails when the check is deliberately removed.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-23` — moved from `planned` to `in-progress`: Starting P3: standalone corpus validator, developed in parallel with SUV-0005 (no shared files).
