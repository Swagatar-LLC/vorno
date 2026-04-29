---
name: roadmap-status
description: Render a roadmap overview — counts per status folder, plans in flight, recent transitions, and link health
---

# Skill: roadmap-status

Produce a concise status overview of the roadmap. Useful for standups, weekly reviews, or "where are we?" moments.

## When to invoke

- "What's the roadmap status?"
- "Show me the active plans"
- "Roadmap weekly review"

## Output sections

Render as markdown. Sections, in order:

### 1. Counts

A small summary table:

| Status | Count |
|--------|-------|
| Planned | N |
| In progress | N |
| Blocked | N |
| Done (undocumented) | N |
| Documented | N |
| **Total** | N |

### 2. In progress

For each plan in `roadmap/plans/in-progress/`:
- `PLAN-NNN — title` (DIR-NN, owner, updated YYYY-MM-DD)
- One-line goal (from the frontmatter `title` or the body's Goal section)

### 3. Blocked

For each plan in `roadmap/plans/blocked/`:
- `PLAN-NNN — title` — blocked by: `{blocked-by}`

### 4. Recently moved

Last ~7 days of status-log entries, across all plans, sorted newest first. Read each plan's `## Status log` section, parse dates, filter to recent.

### 5. Direction roll-up

For each direction in `roadmap/directions/`:
- `DIR-NN — title` (status from frontmatter)
- Linked plans by status: e.g., `2 in-progress, 1 done`

### 6. Link health (optional, only if requested)

Walk all plans/decisions/discussions. Flag:
- Frontmatter `status` ≠ folder name
- `related: [PLAN-X]` where the linked plan doesn't exist
- `direction: DIR-NN` where the direction doesn't exist

## Procedure

1. Glob `roadmap/plans/*/PLAN-*.md` and group by parent folder.
2. For each plan, parse frontmatter (id, title, direction, owner, status, updated, blocked-by).
3. For "Recently moved", read each plan's body, find `## Status log`, parse log lines (`- YYYY-MM-DD — ...`), keep entries within ~7 days.
4. Glob `roadmap/directions/DIR-*.md` (or `roadmap/directions/*.md`), parse frontmatter for status and title.
5. Render as markdown. Keep it skimmable; avoid noise.

## Constraints

- Do not modify any files. Read-only.
- If the roadmap is empty, say so cleanly rather than rendering empty tables.
- Treat `_template.md` and `README.md` as not-plans — exclude from counts.

## Tools

- `Glob`, `Read`. (No writes.)
