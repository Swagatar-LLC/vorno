---
id: SUV-0039
title: Per-plan sequence computed from the plan's related-suvs order and shown on the board
status: planned
plan: PLAN-046
direction: DIR-05
owner: jh
created: 2026-08-27
updated: 2026-08-27
related:
  - SUV-0022-add-suv-form-records-the-reverse-related-suvs-edge.md (the edge this view depends on)
  - SUV-0004-render-suvs-on-the-console-board-and-workstream-view.md (the surface being extended)
blocked-by: []
---

# SUV-0039 — Per-plan sequence computed from the plan's related-suvs order and shown on the board

## Goal

An SUV's position within its owning plan is visible on the board without any
SUV file, id, or path changing.

## Scope

- `corpus.py` — compute `plan_seq` in the derived-edge post-pass of
  `Corpus.scan` (`:274-283`), from the **position of the SUV's filename in its
  owning plan's `related-suvs:` list**, formatted `NNN.MM` (`040.06`).
  `parse_frontmatter` (`:67-89`) already preserves file order, and `ref_id`'s
  anchored match already tolerates the trailing annotations the lists carry
  (`SUV-0026-….md (I1 — after 0023)`).
  **The blocker:** `:283` currently builds each plan's `suvs` from a `set()` of
  *forward* `plan:` edges and then `sorted()` by id — the authored order is
  read from disk and thrown away before anything consumes it.
- `server.py` — thread the field through all three whitelists, or it never
  reaches the browser: `Corpus.index` (`corpus.py:307-324`), `api_doc`
  (`:143-155`), and `_suv_summary` (`:158-163`).
- `www/app.js` — render at the three emission points, alongside (never instead
  of) the global `SUV-NNNN` id: board card (`:1852`), workstream lane chip
  (`:1967`), plan-detail sidebar row (`:568`).
- An SUV whose owning plan does not list it gets **no** number and a visible
  "not listed on its plan" marker. The validator already reports this case as
  `missing-related-suv` (`validator.py:473-478`) — the badge makes it visible
  where the work is read.

Per [ADR-0030](../../decisions/0030-suv-identity-is-global-per-plan-coherence-is-derived.md):
computed at index time, **never written to SUV frontmatter**, and never used as
an identifier, filename, branch name, or lookup key.

## Acceptance

- [ ] `plan_seq` is derived from the plan's list order; no SUV markdown file is
      modified by this change.
- [ ] PLAN-040's sixth listed unit (`SUV-0023`) renders `040.06`, and PLAN-043's
      first (`SUV-0001`) renders `043.01`.
- [ ] Reordering a plan's `related-suvs:` changes the labels on the next index
      with no other edit.
- [ ] An SUV carrying `plan:` that its plan does not list renders the marker,
      not a fabricated number.
- [ ] The global `SUV-NNNN` id remains present on every surface that had it.
- [ ] Console suite green, including a test for the annotated-filename parse.

## Status log

- `2026-08-27` — created in `planned/`
</content>
