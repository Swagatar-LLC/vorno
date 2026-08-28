---
name: roadmap-suv-create
description: Cut a Shippable Unit of Value out of an owning plan — create SUV-NNNN in roadmap/suvs/planned/ and update the plan's related-suvs list
---

# Skill: roadmap-suv-create

Create a new SUV markdown file in `roadmap/suvs/planned/` from the standard
template, auto-assigning the next sequential `SUV-NNNN` ID, and record the
reverse edge on the owning plan.

An SUV is **what one PR closes** — see
[ADR-0028](../../../roadmap/decisions/0028-suv-as-the-shippable-unit-between-plan-and-task.md)
and [`roadmap/suvs/README.md`](../../../roadmap/suvs/README.md).

## When to invoke

- A plan is moving to `in-progress` and needs decomposing.
- "Break PLAN-043 down"
- "Cut an SUV for the task.yaml validator"
- You have been asked to advance a plan and there is no SUV covering the next
  step. **Create one rather than inventing a scope.**

If the change is a trivial fix, don't create an SUV — just open a PR.

## Inputs

Ask for or infer:

- **plan** (required) — `PLAN-NNN`, the owning plan. There is exactly one, and
  it is not optional. If the user names no plan, ask; do not guess.
- **title** (required) — short imperative, e.g. *"Put the roadmap console under version control"*
- **goal** (optional) — one sentence for the Goal section
- **scope** (optional) — bullet list
- **acceptance** (optional) — checkable claims
- **owner** (default: the plan's owner)

`direction` is **inherited from the owning plan**, never asked for separately.

## Procedure

1. **Locate the owning plan.** Glob `roadmap/plans/*/PLAN-NNN-*.md`. If not
   found, error — an SUV cannot exist without a plan.
2. **Read the plan.** Take `direction` and `owner` from its frontmatter. Read
   enough of the body to keep the SUV's scope inside the plan's.
3. **Find the floor — across every ref and every reservation, not the working
   tree.** Run:

   ```bash
   git fetch origin --prune --quiet
   { git log --all --pretty=format: --name-only -- roadmap/suvs \
       | grep -o 'SUV-[0-9]\{4\}'
     git ls-remote origin 'refs/suv-ids/*' \
       | grep -o 'SUV-[0-9]\{4\}'
   } | sort -u | tail -1
   ```

   Take max + 1. Format as zero-padded **four** digits (`SUV-0001`, `SUV-0042`).
   Plans are three digits, SUVs are four — do not carry the plan width over.

   **Do not glob `roadmap/suvs/` for this.** A glob sees only what is committed
   on the branch you are standing on, and SUVs are routinely cut on unmerged
   `plan/*` branches. On 2026-08-27 a worktree cut from `origin/main` globbed a
   maximum of `SUV-0022` while the true maximum was `SUV-0036` — allocating
   `SUV-0023` would have collided with a unit already shipped on
   `plan/plan-040`. This is the mechanism that minted two `SUV-0014`s.

   **An ID that has ever existed anywhere a ref can reach is claimed**,
   including one later renumbered away. Never reuse one. Gaps are expected and
   fine. Note there is no `--diff-filter=A` in that command on purpose: git
   reports a renumber as a *rename*, so filtering on adds misses every id that
   entered the corpus by being renamed into — which is how SUV-0033 came to
   exist. See
   [ADR-0030](../../../roadmap/decisions/0030-suv-identity-is-global-per-plan-coherence-is-derived.md).

   The floor tells you which ids are **taken**. It does not stop another agent
   reading the same floor at the same moment — that is what step 4 is for. Do
   not skip it.
4. **Reserve the ID on the remote before writing anything.** Reading the floor
   is not allocation. Two workflows that both read before either writes mint the
   same id — the mechanism behind the two `SUV-0014`s. The remote is the only
   serialization point the workflows share, so publish the claim there first:

   ```bash
   id=SUV-0040                                   # the id from step 3
   tree=$(git hash-object -t tree -w /dev/null)  # the empty tree
   claim=$(printf 'reserve %s nonce=%s\n' "$id" "$(uuidgen)" \
            | git commit-tree "$tree")
   git push --atomic origin "${claim}:refs/suv-ids/${id}"
   ```

   The push **succeeds only if nobody has claimed that id**. It is a
   compare-and-swap, not a hope: creating a ref that already exists is a
   non-fast-forward, and the claim commit is parentless with a random nonce so
   it can never fast-forward anything. Real output of a losing claim:

   ```
    ! [rejected]  ff620862 -> refs/suv-ids/SUV-9999 (non-fast-forward)
   error: failed to push some refs to 'https://github.com/Swagatar-LLC/vorno.git'
   ```

   **On rejection you lost the race.** Do not force. Re-run step 3 and claim the
   next id. Repeat until a push succeeds.

   The `uuidgen` nonce is load-bearing, not decoration. Push a claim object that
   is byte-identical to the winner's and git reports `Everything up-to-date` and
   exits `0` — both agents believe they won. The nonce makes an identical claim
   commit impossible.

   A reservation ref is ~50 bytes, is never deleted, and needs no cleanup: an
   abandoned claim just leaves a gap, and ADR-0030 already declares gaps normal.
   Reservations do **not** replace the step 3 history scan — an id can be
   claimed by a commit that predates this namespace — which is why step 3 reads
   the union of both.
5. **Read the template** at `roadmap/suvs/_template.md`.
6. **Fill the frontmatter** — exactly these keys, in this order:
   - `id`: the new ID
   - `title`: the user's title
   - `status`: `planned`
   - `plan`: the owning `PLAN-NNN`
   - `direction`: inherited from the plan
   - `owner`: plan's owner unless overridden
   - `created` / `updated`: today's date in `YYYY-MM-DD`
   - `related`: empty list (or fill if obvious — sibling SUVs, ADRs)
   - `blocked-by`: empty list
7. **Fill the body:**
   - Replace the `# SUV-NNNN — ...` heading with the real ID and title.
   - Goal: one sentence. If it takes two, split into two SUVs and say so.
   - Scope: name files or surfaces where you can.
   - Acceptance: claims a reviewer can check by reading the diff. Not "works
     well" — "`bun test packages/shared` passes with the new case".
   - Status log: `- YYYY-MM-DD — created in planned/`.
8. **Write the file** to `roadmap/suvs/planned/SUV-NNNN-<kebab-slug>.md`. Slug
   is the kebab-cased title, lowercased, alphanumeric + hyphens, max ~60 chars.
9. **Update the owning plan**, appending the new filename to its `related-suvs:`
   frontmatter list. If the plan has no `related-suvs:` key, add it directly
   after `related:`.
10. **Report:** file path, SUV ID, owning plan, and the next step (typically:
    "ready to start? run `[skill:roadmap-plan-advance] SUV-NNNN in-progress`").

## Constraints

- **Every SUV has exactly one owning plan.** No orphans, no multi-parent SUVs.
- Never put an SUV directly in `in-progress/` — every SUV starts in `planned/`.
- **Keep it small.** If Acceptance runs past ~6 items or Scope spans more than
  one surface, split it. An SUV that reads like a plan is scoped like a plan.
- **Stay inside the plan.** An SUV may not introduce scope the owning plan
  doesn't already sanction. If the work genuinely needs it, that is a plan edit
  or a new plan — surface it, don't smuggle it.
- Task definitions go in `roadmap/suvs/definitions/SUV-NNNN.task.yaml` and are
  **not** created by this skill. Don't scaffold an empty one.
- Never overwrite an existing SUV. On slug collision, append `-2`.
- Don't run `git add` or commit. The user (or another skill) commits. The one
  exception is the step 4 reservation push, which touches no branch and no file
  in the working tree — it writes a single ref under `refs/suv-ids/`.

## Batch decomposition

When cutting several SUVs from one plan in a single pass:

- Allocate IDs in one sweep so they don't collide, starting from the all-refs
  floor in step 3 — not from a glob, and not re-derived per SUV.
- **Reserve all N in one atomic push**, before writing any of them. One
  `--atomic` push either claims the whole block or claims none of it, so you
  never end up holding half a range:

  ```bash
  tree=$(git hash-object -t tree -w /dev/null)
  refspecs=()
  for id in SUV-0040 SUV-0041 SUV-0042; do
    claim=$(printf 'reserve %s nonce=%s\n' "$id" "$(uuidgen)" \
             | git commit-tree "$tree")
    refspecs+=("${claim}:refs/suv-ids/${id}")
  done
  git push --atomic origin "${refspecs[@]}"
  ```

  If any id in the block is already claimed, git rejects the whole push —
  verified against this remote, with the uncontended id reported as
  `(atomic push failed)` and left uncreated on the remote. Re-derive the floor
  and re-claim the whole block; do not cherry-pick the ones that would have
  gone through.
- Order them so each is independently shippable — an SUV that only makes sense
  after another still ships on its own; record the ordering in `related:` or
  `blocked-by:`, not by merging them.
- Update the plan's `related-suvs:` once, with all of them.

## Tools you'll typically use

- `Glob` (`roadmap/plans/*/PLAN-NNN-*.md`) to locate the owning plan
- `Bash` (`git log --all …` + `git ls-remote origin 'refs/suv-ids/*'`) for the
  floor — **not** `Glob`, which cannot see ids claimed on other branches
- `Bash` (`git push --atomic origin <claim>:refs/suv-ids/SUV-NNNN`) to reserve
  the id. This is the one push this skill makes; it publishes no file content,
  only the claim.
- `Read` for the plan and `roadmap/suvs/_template.md`
- `Write` to create each SUV
- `Edit` to update the plan's `related-suvs:` list

## Example

User: *"Break PLAN-043's first phase down."*

You:

1. Glob → `roadmap/plans/in-progress/PLAN-043-...md`. Read it: `direction: DIR-05`, `owner: jh`.
2. `git log --all …` plus `git ls-remote origin 'refs/suv-ids/*'` for claimed
   ids → none anywhere. Floor is empty, so the candidate is `SUV-0001`.
3. Reserve it: `git push --atomic origin "${claim}:refs/suv-ids/SUV-0001"` →
   `* [new reference]`. The id is now yours; a concurrent breakdown that read
   the same empty floor gets `! [rejected] … (non-fast-forward)` and moves to
   `SUV-0002`.
4. Phase P1 is one shippable change: give the console a git repo.
5. Write `roadmap/suvs/planned/SUV-0001-put-the-roadmap-console-under-version-control.md`
   with `plan: PLAN-043`, `direction: DIR-05`.
6. Edit PLAN-043 → `related-suvs: [SUV-0001-put-the-roadmap-console-under-version-control.md]`.
7. Report: "Created SUV-0001 under PLAN-043. Run `[skill:roadmap-plan-advance] SUV-0001 in-progress` when ready."
