---
name: roadmap-plan-create
description: Create a new plan in roadmap/plans/planned/ from the standard template, with auto-assigned ID and frontmatter
---

# Skill: roadmap-plan-create

Create a new plan markdown file in `roadmap/plans/planned/` from the standard template, auto-assigning the next sequential `PLAN-NNN` ID.

## When to invoke

The user (or you) wants to capture a new piece of work as a plan. Triggers:

- "Let's plan out X"
- "Capture a plan for Y"
- "Add a plan: Z"
- After a discussion that converges on a unit of work

If the work is trivial (< half a day), don't create a plan — just do the work or open a PR directly.

## Inputs

Ask for or infer:

- **title** (required) — short imperative, e.g. *"Canvas Session — spectator v0.1"*
- **direction** (required) — one of `DIR-NN` from `roadmap/directions/`. If unclear, list the active ones and ask.
- **owner** (default: `jh`) — handle or initials
- **brief** (optional) — one-line description for the Goal section
- **scope** (optional) — bullet list

## Procedure

1. **Find the next ID.** Search all `roadmap/plans/*/PLAN-*.md` files, parse `PLAN-NNN`, take max + 1. Format as zero-padded three digits (`PLAN-001`, `PLAN-042`).
2. **Read the template** at `roadmap/plans/_template.md`.
3. **Fill the frontmatter:**
   - `id`: the new ID
   - `title`: the user's title
   - `status`: `planned`
   - `direction`: e.g. `DIR-01`
   - `owner`: the user's handle or `jh`
   - `created` / `updated`: today's date in `YYYY-MM-DD` (use the user-provided current date)
   - `related`: empty list (or fill if obvious)
   - `blocked-by`: empty list
4. **Fill the body:**
   - Replace `# PLAN-NNN — Short imperative title` with the real title.
   - If `brief` provided, set the Goal section.
   - If `scope` provided, populate Scope.
   - Add an initial Status log entry: `- YYYY-MM-DD — created in planned/`.
5. **Write the file** to `roadmap/plans/planned/PLAN-NNN-<kebab-slug>.md`. The slug is the kebab-cased title, lowercased, alphanumeric + hyphens only, max ~60 chars.
6. **Update the linked direction**, adding the new plan to its `related-plans:` frontmatter list.
7. **Report** to the user: file path, plan ID, and the next concrete next step (typically: "ready to start? run `roadmap-plan-advance PLAN-NNN in-progress`").

## Constraints

- Never overwrite an existing plan. If a plan with the same slug exists, append a numeric suffix (`-2`).
- Never put a plan directly in `in-progress/` — every plan starts in `planned/`.
- Keep the body sections present even if empty — placeholder text is fine for downstream skills.
- Don't run `git add` or commit. The user (or another skill) commits.

## Tools you'll typically use

- `Glob` (`roadmap/plans/*/PLAN-*.md`) to find the next ID
- `Read` (`roadmap/plans/_template.md`) for the template
- `Write` to create the new plan
- `Edit` to update the direction's `related-plans:` list

## Example

User: *"Capture a plan for adding tldraw to the renderer, in DIR-01."*

You:

1. Glob → finds `PLAN-001`. Next: `PLAN-002`.
2. Read template.
3. Title: "Add tldraw to renderer". Slug: `add-tldraw-to-renderer`.
4. Write `roadmap/plans/planned/PLAN-002-add-tldraw-to-renderer.md`.
5. Edit `roadmap/directions/01-canvas-session.md` → `related-plans: [PLAN-001-..., PLAN-002-add-tldraw-to-renderer.md]`.
6. Report: "Created PLAN-002. Run `[skill:roadmap-plan-advance] PLAN-002 in-progress` when ready to start."
