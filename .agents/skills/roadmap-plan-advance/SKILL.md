---
name: roadmap-plan-advance
description: Advance a plan to a new status by performing git mv between folders and rewriting frontmatter status, with a status-log entry
---

# Skill: roadmap-plan-advance

Move a plan from one status folder to another, keeping frontmatter and folder name in sync. Append a status-log entry. Optionally stage for commit.

## When to invoke

- "Move PLAN-007 to in-progress"
- "PLAN-002 is blocked on tldraw license review"
- "Mark PLAN-001 done"

## Inputs

- **plan-id** (required) — `PLAN-NNN`
- **target-status** (required) — one of `planned`, `in-progress`, `blocked`, `done`, `documented`
- **note** (optional) — context for the status-log entry. For `blocked`, this should describe what blocks it.
- **blocked-by** (only when target = `blocked`) — array of strings (other plan IDs, links, "external decision X")

## Allowed transitions

```
planned     → in-progress
in-progress → blocked
in-progress → done
blocked     → in-progress
blocked     → planned    (rarely — if we de-prioritized)
done        → documented
documented  → (terminal — no further transitions)
```

Reject other transitions with a clear error. Don't allow self-transitions (already in target folder).

## Procedure

1. **Locate the plan.** Glob `roadmap/plans/*/PLAN-NNN-*.md`. If not found, error.
2. **Verify transition allowed.** Reject if illegal.
3. **Read** the file. Parse frontmatter.
4. **Update frontmatter:**
   - `status`: target value
   - `updated`: today's date
   - For `blocked`: set `blocked-by` to the user-provided array.
   - For non-`blocked`: clear `blocked-by` to `[]`.
5. **Append a status-log entry** at the end of the body's `## Status log` section:
   - `- YYYY-MM-DD — moved from {old-status} to {target-status}{: note if provided}`
6. **Move the file** with `git mv` from `roadmap/plans/{old-status}/...` to `roadmap/plans/{target-status}/...`. Same filename.
7. **Don't commit.** Report what was moved and remind the user to commit when ready (suggest message: `roadmap: PLAN-NNN → {target-status}`).

## Constraints

- The `git mv` and the frontmatter rewrite must both succeed. If the rewrite fails after `git mv`, restore (mv back) before erroring.
- Status-log is append-only. Never edit or remove existing entries.
- Don't reformat unrelated parts of the file.
- If the plan's frontmatter is malformed, surface the parse error rather than silently fixing.

## Tools you'll typically use

- `Glob` to locate the plan
- `Read` to load + parse
- `Bash` for `git mv`
- `Edit` to rewrite frontmatter and append status log

## Examples

```
roadmap-plan-advance PLAN-001 in-progress
  → roadmap/plans/planned/PLAN-001-canvas-session-spectator-v0.md
  → roadmap/plans/in-progress/PLAN-001-canvas-session-spectator-v0.md
  + frontmatter status: planned → in-progress
  + status-log: "- 2026-04-28 — moved from planned to in-progress"

roadmap-plan-advance PLAN-002 blocked --blocked-by "tldraw license review"
  → moves to blocked/, sets blocked-by, logs note
```

## Edge cases

- **Plan in `documented/`**: terminal. Reject transition.
- **Multiple `## Status log` sections**: append to the last one.
- **No `## Status log` section**: append `## Status log\n\n- YYYY-MM-DD — moved from ... to ...` at end of file.
- **Frontmatter `status` already matches target**: no-op, log a warning, don't move file.
