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
3. **Find the next ID.** Search all `roadmap/suvs/*/SUV-*.md`, parse `SUV-NNNN`,
   take max + 1. Format as zero-padded **four** digits (`SUV-0001`, `SUV-0042`).
   Plans are three digits, SUVs are four — do not carry the plan width over.
4. **Read the template** at `roadmap/suvs/_template.md`.
5. **Fill the frontmatter** — exactly these keys, in this order:
   - `id`: the new ID
   - `title`: the user's title
   - `status`: `planned`
   - `plan`: the owning `PLAN-NNN`
   - `direction`: inherited from the plan
   - `owner`: plan's owner unless overridden
   - `created` / `updated`: today's date in `YYYY-MM-DD`
   - `related`: empty list (or fill if obvious — sibling SUVs, ADRs)
   - `blocked-by`: empty list
6. **Fill the body:**
   - Replace the `# SUV-NNNN — ...` heading with the real ID and title.
   - Goal: one sentence. If it takes two, split into two SUVs and say so.
   - Scope: name files or surfaces where you can.
   - Acceptance: claims a reviewer can check by reading the diff. Not "works
     well" — "`bun test packages/shared` passes with the new case".
   - Status log: `- YYYY-MM-DD — created in planned/`.
7. **Write the file** to `roadmap/suvs/planned/SUV-NNNN-<kebab-slug>.md`. Slug
   is the kebab-cased title, lowercased, alphanumeric + hyphens, max ~60 chars.
8. **Update the owning plan**, appending the new filename to its `related-suvs:`
   frontmatter list. If the plan has no `related-suvs:` key, add it directly
   after `related:`.
9. **Report:** file path, SUV ID, owning plan, and the next step (typically:
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
- Don't run `git add` or commit. The user (or another skill) commits.

## Batch decomposition

When cutting several SUVs from one plan in a single pass:

- Allocate IDs in one sweep so they don't collide.
- Order them so each is independently shippable — an SUV that only makes sense
  after another still ships on its own; record the ordering in `related:` or
  `blocked-by:`, not by merging them.
- Update the plan's `related-suvs:` once, with all of them.

## Tools you'll typically use

- `Glob` (`roadmap/plans/*/PLAN-NNN-*.md`, `roadmap/suvs/*/SUV-*.md`)
- `Read` for the plan and `roadmap/suvs/_template.md`
- `Write` to create each SUV
- `Edit` to update the plan's `related-suvs:` list

## Example

User: *"Break PLAN-043's first phase down."*

You:

1. Glob → `roadmap/plans/in-progress/PLAN-043-...md`. Read it: `direction: DIR-05`, `owner: jh`.
2. Glob `roadmap/suvs/*/SUV-*.md` → none. Next: `SUV-0001`.
3. Phase P1 is one shippable change: give the console a git repo.
4. Write `roadmap/suvs/planned/SUV-0001-put-the-roadmap-console-under-version-control.md`
   with `plan: PLAN-043`, `direction: DIR-05`.
5. Edit PLAN-043 → `related-suvs: [SUV-0001-put-the-roadmap-console-under-version-control.md]`.
6. Report: "Created SUV-0001 under PLAN-043. Run `[skill:roadmap-plan-advance] SUV-0001 in-progress` when ready."
