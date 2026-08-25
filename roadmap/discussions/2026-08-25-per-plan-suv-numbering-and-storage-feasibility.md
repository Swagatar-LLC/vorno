---
date: 2026-08-25
participants: product owner (question) + agent (evaluation)
topic: Is moving SUVs to per-plan numbering and/or per-plan storage feasible without major disruption?
related-decisions: [ADR-0028]
related-plans: [PLAN-043]
related-suvs: [SUV-0020]
---

# Per-plan SUV numbering and storage — feasibility evaluation

> **Owner's question (2026-08-25, preserved as stated):** "SUVs should probably
> be stored under the individual plan so that our numbering is coherent per
> plan as opposed to coherent at the system level… evaluate whether or not
> SUVs being moved is feasible at this point without major disruption."
>
> This is an evaluation, not a migration. ADR-0028 fixed the current shape;
> changing it requires a superseding ADR and the owner's decision. Nothing has
> been moved.

## What prompted it, and what has changed since

Two concurrent breakdowns each minted `SUV-0014` — the landed PLAN-040 unit
and the parked PLAN-039 candidate — because the allocator only saw files on
disk. **That operational driver is now fixed at the allocator level**:
SUV-0020 makes every id source (New-SUV form, breakdown prompt floor, index
prefill) consult unmerged `breakdown/*` and `feedback/*` branches, and an
override into a claimed id is refused by branch name. Per-plan numbering would
make cross-plan collisions *unrepresentable* rather than *prevented*, which is
a stronger property — the question is what it costs today.

## The two axes are separable

- **Axis A — per-plan numbering**: ids like `SUV-043-01` (or `PLAN-043/SUV-01`),
  storage unchanged.
- **Axis B — per-plan storage**: files under `roadmap/suvs/<PLAN-NNN>/<status>/`,
  ids unchanged.

They fail in different places and at very different prices. The blast-radius
inventory below was produced by a full sweep of both repos and the console,
with every load-bearing claim re-verified in code.

## Axis A — per-plan numbering: expensive, and it fails silently

The id format `SUV-\d{4}` is hard-coded at every layer, and two of the failure
modes are **wrong answers, not errors** (verified live against the console's
`corpus.py`):

- `ref_id("SUV-043-01")` → `""` — every SUV silently loses its identity:
  backlinks, the `plan:` edge, mention resolution (`corpus.py:39`).
- `ref_id("PLAN-043/SUV-01")` → `"PLAN-043"` — a slash-form id makes **every
  SUV resolve to its own plan**, corrupting the index without raising anything.
- `next_id`'s regex matches nothing → it hands out `SUV-0001` forever
  (`corpus.py:387-396`) — a silent allocator regression, not a crash.

Counted blast radius: **12 hard-break sites in the console** (`corpus.py`
id/regex layer, `validator.py` filename+id checks, `server.py` `SUV_ID_RE`
gate on every task-def endpoint, `www/app.js` dependency-map resolution);
**5 of 11 validator checks** misfire, including `duplicate-id` — the check
that caught the 0014 collision — and the validator's check ids are a stated
stable API that the breakdown merge gate keys off, so a partial migration
**blocks acceptance of every candidate set** until validator and corpus move
together. **~130 console test functions** (289 literal ids) need rewriting.
In the main repo: **230 id occurrences**, 111 of them across 8 files outside
`roadmap/suvs/` — 55 in the dated, append-only authoring-gaps discussion that
PLAN-039 W1 references as its evidence base. The four-digit width is also a
*deliberate* disambiguation property stated in ADR-0028, the SUV README, both
skills, and the breakdown prompt — `roadmap-plan-advance` derives which corpus
root to search from the id shape.

**Assessment: not feasible without major disruption.** The benefit (collision
impossibility) is largely delivered by SUV-0020; the cost is a coordinated
rewrite of every layer plus the historical record, with two silent-corruption
modes waiting for whatever the sweep misses.

## Axis B — per-plan storage: feasible at moderate cost, one shape only

The surprise of the sweep: the console's path machinery is mostly
layout-agnostic *by construction* —

- `api_advance` computes the destination as `dirname(dirname(src))/<target>`,
  which under `suvs/<PLAN-NNN>/<status>/` resolves correctly with **zero code
  change**; same for status derivation (`basename(dirname(path))`) and the
  allocator's recursive walk.
- Exactly **one** hard depth assertion exists in the whole system:
  `validator.py:340` (`len(rec.parts) != 3` → `illegal-status-folder`).
  Verified. Beyond it: one `target_dir` line in `api_create`, the breakdown
  prompt's three path bindings, ~31 test path fixtures, the docs/skills globs,
  and 22 `git mv`s. Every relative markdown link into `roadmap/suvs/<status>/`
  breaks — loudly, because the validator's link check reports them.

**The shape matters.** ADR-0028's rejection of nesting — "plans move between
status folders; nesting would drag every child along" — argues against
`plans/<status>/PLAN-NNN/suvs/…`, and that argument is correct. It does **not**
apply to `roadmap/suvs/<PLAN-NNN>/<status>/…`, where the grouping key is the
plan's *id*, which never changes when the plan file moves. A superseding ADR
would narrow, not contradict, 0028's reasoning. (`_doc_type` also stays correct
under this shape and would misclassify under the plan-nested one.)

Cost that remains real: ids stay four-digit and system-global, so this buys
**per-plan browsing**, not per-plan numbering coherence; the transition graph,
skills, README trees, CLAUDE.md/AGENTS.md, and the breakdown prompt all need
their globs and examples rewritten; and the migration must land as one commit
(corpus + validator + console + skills + 22 moves) to keep the validator — and
therefore the merge gate — green throughout.

## Options, priced

| # | Option | Collision safety | Cost | Risk |
|---|--------|------------------|------|------|
| 1 | Status quo + SUV-0020 (landed) | prevented at every allocator | paid | lowest |
| 2 | B only: `suvs/<PLAN-NNN>/<status>/` | as #1 | moderate, one-commit migration | link/glob churn; loud failures |
| 3 | A only: `SUV-043-01` ids | unrepresentable | very high | **silent** corruption modes |
| 4 | A + B | unrepresentable | highest | as #3 |

## Recommendation

**Option 1.** Keep system-level numbering and flat storage. SUV-0020 already
removed the collision mechanism the question grew from; global ids keep the
230 existing cross-references (including PLAN-039's evidence base) stable; and
the console gained nothing from per-plan ids that branch-aware allocation does
not already give it. If per-plan *grouping* is the real want — "show me
PLAN-043's units" — that is already served relationally (the board filters
SUVs by owning plan, and `/api/doc` on a plan lists its SUVs from the derived
edge), and Option 2 remains open later at unchanged cost: nothing landed this
week deepens the flat-layout coupling.

If the owner wants Option 2 anyway, the path is: a superseding ADR narrowing
ADR-0028's nesting rejection to the plan-nested shape; then one coordinated
change (validator depth check, `api_create` target dir, prompt bindings, skills
and docs globs, 22 `git mv`s, link fixes) verified by the validator running
green at the single migration commit. Estimated as one focused SUV plus a
sweep-and-verify pass — disruptive for a day, not for a season. Options 3 and 4
are not recommended at any point where the corpus's history matters.

**Decision needed from the owner:** adopt Option 1 (no ADR required — the
status quo is ADR-0028), or direct Option 2 (requires the superseding ADR
first).
