---
id: SUV-0003
title: Teach corpus.py the SUV type
status: planned
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
related:
  - SUV-0002-suv-corpus-scaffolding-and-work-management-instructions.md
blocked-by: []
---

# SUV-0003 — Teach corpus.py the SUV type

## Goal

The console's scanner recognises `roadmap/suvs/` records as a first-class type,
with the plan status set reused verbatim and the `plan:` / `related-suvs:` edge
resolved in both directions.

## Scope

- `corpus.py`: type derivation from the `suvs/` root; `ID_PREFIX["suv"] = "SUV"`
  and `ID_WIDTH["suv"] = 4`; `SUV-\d{4}` in the ID regex; `"suv"` in
  `STATUS_FOLDER_TYPES` so its folder is authoritative for status.
- Relation resolution: an SUV's `plan:` produces a reverse `suvs` list on the
  owning plan record, derived from the scan rather than trusted from the plan's
  own frontmatter — the SUV file is the source of truth for its own parent.
- `roadmap/suvs/definitions/` is **not** a status folder. Files there must not
  be scanned as records.
- Next-id allocation returns four-digit SUV ids.
- Tests in `test_server.py` covering the above.

## Non-scope

- No UI. Rendering is SUV-0004.
- No second status vocabulary — the plan transition graph is reused unchanged.

## Acceptance

- [ ] A file in `roadmap/suvs/planned/` scans as `type == "suv"` with `status == "planned"`.
- [ ] Frontmatter `status` disagreeing with the folder resolves to the folder, same as plans.
- [ ] A plan record exposes its SUVs, derived from the SUVs' `plan:` field.
- [ ] Nothing under `roadmap/suvs/definitions/` appears in the record set.
- [ ] Next-id for `suv` returns `SUV-NNNN` zero-padded to four digits and skips taken ids.
- [ ] `test_server.py` covers each of the above and passes.

## Status log

- `2026-08-23` — created in `planned/`. A concurrent console session has already landed most of this (`STATUS_FOLDER_TYPES`, `ID_WIDTH`, the reverse edge); treat the acceptance list as the audit.
