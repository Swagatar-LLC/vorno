---
id: ADR-0030
title: SUV identity stays global; per-plan coherence is a derived view
status: accepted
date: 2026-08-27
supersedes: []
superseded-by: []
---

# ADR-0030 — SUV identity stays global; per-plan coherence is a derived view

## Context

[ADR-0028](0028-suv-as-the-shippable-unit-between-plan-and-task.md) gave SUVs a
flat, system-global identity: `SUV-NNNN`, four digits, stored in
`roadmap/suvs/<status>/`, tied to an owning plan by a `plan:` relation rather
than by nesting.

Two things have since pressed on that shape.

**1. The numbering does not read as per-plan.** PLAN-040's units are
SUV-0014–0018 and SUV-0023–0033; PLAN-043's are SUV-0001–0013 and 0019–0022.
Neither plan's set is contiguous, so "which unit of this plan is this?" cannot
be answered from the id. The owner asked (2026-08-25) whether SUVs should be
stored under their plan so numbering is coherent per plan. That question was
evaluated in
[`../discussions/2026-08-25-per-plan-suv-numbering-and-storage-feasibility.md`](../discussions/2026-08-25-per-plan-suv-numbering-and-storage-feasibility.md).

**2. Allocation actually collides.** On 2026-08-26 two concurrent breakdowns
each minted `SUV-0014`; the duplicate reached local `main` and the corpus went
validator-invalid. SUV-0020 hardened the console allocator, but only against
the branch conventions that existed when it was written — the defect survives,
and is reproducible today (see Decision, point 3).

The distinction that resolves the tension: **per-plan coherence is a reading
problem, not an identity problem.** It is wanted at the moment someone looks at
a board. Identity is wanted at the moment someone reads a branch name, a PR
title, or six months of git history. Serving the first by changing the second
trades a cheap need against an expensive guarantee.

## Decision

**The global `SUV-NNNN` identifier is permanent and load-bearing. Per-plan
coherence is delivered as a computed view over the owning plan's
`related-suvs:` order, never as a stored field, a renumbering, or a file move.
Allocation counts every id that has ever existed anywhere a ref can reach.**

Three commitments:

### 1. Global four-digit ids stay

`SUV-NNNN` remains the identity in filenames, frontmatter `id:`, cross-document
references, branch names, PR titles, and git history. The four-digit width stays
a deliberate disambiguator from three-digit `PLAN-NNN` — `roadmap-plan-advance`
derives which corpus root to search from the id shape.

### 2. `plan-seq` is computed, not authored

An SUV's per-plan sequence — rendered `040.06` for the sixth entry in PLAN-040's
list — is derived at index time from the **position of the SUV's filename in its
owning plan's `related-suvs:` list**, and exposed as a record field on the
console's API and board. It is **not** written into SUV frontmatter.

This is the one place this ADR departs from the shape the work was chartered
with. An authored `plan-seq:` field would be a second source of truth for
ordering that nothing recomputes: reorder a plan's `related-suvs:`, insert a
unit mid-list, or move an SUV to another plan, and every downstream number is
silently wrong. The plan's list is already the ordering the team maintains by
hand and already carries intent (`(after 0014)`, `(P3)`). Deriving from it means
the label cannot drift, because there is nothing to drift *from*.

Consequences that follow, and are accepted:

- **Ordering authority moves to the plan.** Reordering a plan's `related-suvs:`
  renumbers the display. That is correct — the list *is* the sequence.
- **An SUV missing its reverse edge has no sequence.** It renders with its
  global id and a "not listed on its plan" marker rather than a fabricated
  number, making the corpus defect visible instead of papered over.
- **The label is not an identifier.** `040.06` is never a filename, a branch
  name, a link target, or an input to a lookup. Anything that must round-trip
  uses `SUV-NNNN`.

### 3. Allocation counts every ref, not the working tree

Next-id allocation must consider **every SUV id that has ever appeared
anywhere a ref can reach**, not the files visible in one checkout.

The defect, reproduced 2026-08-27: a fresh worktree cut from `origin/main` sees
a maximum of `SUV-0022`, so a max+1 allocator hands out `SUV-0023` — an id
PLAN-040 has already used and shipped on `plan/plan-040` (PR #180). The true
maximum across all refs is `SUV-0036` (0034–0036 live on `plan/plan-039`).

The console's SUV-0020 fix is real but partial. `suv_ids_on_candidate_branches`
(`server.py:2872`) enumerates only `refs/heads/breakdown` and
`refs/heads/feedback` — local heads, written against the branch convention in
force at the time. It therefore misses:

- `refs/heads/plan/*` — **the convention SUV-0019 introduced one SUV earlier**,
  and where 0034–0036 actually live;
- every remote ref, including `origin/plan/plan-039`;
- ad-hoc branches (`roadmap/*`, `jh/*`) where SUVs are cut by hand.

The rule adopted: **an id that has ever existed anywhere a ref can reach is
claimed.** Never reuse one, including an id renumbered away — PLAN-039's
SUV-0014 became SUV-0033, and reusing 0014 would make history ambiguous at
precisely the point someone is reading it to understand a collision. This needs
no reservation state or lockfile, and is one command:

```
git log --all --pretty=format: --name-only -- roadmap/suvs \
  | grep -o 'SUV-[0-9]\{4\}' | sort -u | tail -1
```

Two properties of that command are deliberate:

- **No `--diff-filter=A`.** Git reports a renumber as a *rename*, not an add,
  so filtering on adds misses every id that entered the corpus by being renamed
  into — which is exactly how SUV-0033 came to exist. Caught by a test written
  against the narrower filter, which failed.
- **Reachability, not permanence.** Delete a branch outright and its commits
  become unreachable, so its claim lapses on its own. That is SUV-0020's
  deliberate design — a claim costs nothing to release and needs no cleanup —
  and it is preserved. "Permanent" means *while the work exists*, not forever.

Gaps in the sequence are the expected, harmless cost.

## Why nesting and per-plan ids were rejected

Recorded in full so this is not re-proposed from first principles in six months.
The proposal was: nest SUVs under their plan and renumber to `SUV-043-01`.

1. **ADR-0028 chose relation over nesting on purpose** (`corpus.py:271` records
   the same reasoning): a plan file moves between status folders, so a path
   containing the plan is not a stable address. Nesting couples two independent
   lifecycles and turns one `git mv` into a subtree rewrite.
2. **The corpus would silently mistype every SUV.** `_doc_type()`
   (`corpus.py:141`) types a document by its **first path segment**. Under
   `roadmap/plans/PLAN-043/suvs/`, `top == "plans"` and every SUV becomes a
   *plan* in the index. No error — a wrong answer.
3. **Every cross-document link breaks.** The linker regex is `SUV-\d{4}`
   (`corpus.py:39`). `SUV-043-01` does not match, so `ref_id()` returns `""`
   and each SUV loses its backlinks and its `plan:` edge. The slash form
   `PLAN-043/SUV-01` is worse: it resolves to `"PLAN-043"`, making every SUV
   resolve to its own plan. `next_id`'s regex likewise matches nothing and hands
   out `SUV-0001` forever. All three are silent corruption, not crashes.
4. **The coupling is broad and partly outside the code.** ~72 references to the
   SUV corpus across the console (`server.py` 21, `www/app.js` 29,
   `validator.py` 17, `corpus.py` 4, `taskdef.py` 1); ~230 id occurrences in the
   main repo, 111 across 8 files outside `roadmap/suvs/` — including the dated,
   append-only authoring-gaps discussion PLAN-039 uses as its evidence base;
   plus `related-suvs:` lists that store **filenames**, and branch names, PR
   titles, and git history, which cannot be rewritten at all.

The benefit sought — collision impossibility — is delivered by point 3 above at
a fraction of the cost, as *prevention* rather than *unrepresentability*.

## Consequences

### Positive

- Six months of branch names, PR titles, and commit messages keep resolving.
- Per-plan reading is served where it was actually wanted: on the board.
- Allocation has one rule, stated as one command, that no branch layout can
  invalidate — it is defined over history, not over refs matching a naming
  convention.
- The plan's `related-suvs:` list gains a second job it was already doing
  informally, which raises the cost of leaving the reverse edge unwritten.

### Negative

- `plan-seq` is only as good as the plan's list. A plan that never curates
  `related-suvs:` gets append-order numbering.
- Renumbering-by-reorder means a plan edit changes labels a person may have
  quoted in conversation. Mitigated by the labels never being identifiers.
- Global ids still do not *look* per-plan in filenames or branch names. This
  ADR accepts that permanently.
- `git log --all` costs more than a glob. Immaterial at this corpus size;
  revisit if allocation ever lands in a hot path.

### Neutral

- `roadmap/suvs/<PLAN-NNN>/<status>/` (per-plan *storage* with global ids)
  remains open as a future option at unchanged cost — it is orthogonal to
  everything decided here, and nothing in this ADR deepens the flat-layout
  coupling.
- Gaps in the global sequence become normal and permanent.

## Alternatives considered

- **Per-plan ids (`SUV-043-01`)** — rejected above; four silent-corruption
  modes and an unrewritable history.
- **SUVs nested under the plan** — rejected above and by ADR-0028.
- **Authored `plan-seq:` frontmatter** — rejected: a second ordering source of
  truth that nothing recomputes and every reorder invalidates.
- **A reservation file or id lockfile** — rejected: introduces state that can
  desync from git, needs cleanup when a branch is abandoned, and must itself be
  merged. Git history already *is* the durable claim ledger.
- **Status quo (Option 1 of the 2026-08-25 evaluation)** — accepted for
  storage and identity, rejected as complete: it left the reading problem
  unaddressed and the allocator's ref coverage partial.

## References

- [ADR-0028](0028-suv-as-the-shippable-unit-between-plan-and-task.md) — amended,
  not superseded: its identity, location, and ownership rules stand.
- [`../discussions/2026-08-25-per-plan-suv-numbering-and-storage-feasibility.md`](../discussions/2026-08-25-per-plan-suv-numbering-and-storage-feasibility.md)
  — the priced evaluation this decision resolves.
- PLAN-046 — the plan that implements this ADR.
- SUV-0019 / SUV-0020 — the retrospective units whose interaction produced the
  surviving allocation gap.
- `server.py:2872` (`suv_ids_on_candidate_branches`) — the partial fix.
- `corpus.py:39`, `corpus.py:141`, `corpus.py:271` — the three mechanisms that
  make nesting and renumbering fail silently.
