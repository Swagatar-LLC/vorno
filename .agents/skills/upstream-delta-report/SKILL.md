---
name: upstream-delta-report
description: Refresh roadmap/upstream/delta.md with the current set of files we own that differ from upstream/main, grouped by component
---

# Skill: upstream-delta-report

Compute the current diff between our `main` and `upstream/main`, group by component, and rewrite `roadmap/upstream/delta.md` accordingly.

## When to invoke

- After every `[skill:upstream-sync]` cycle
- When asked "what do we own that upstream doesn't?"
- Quarterly when reviewing the delta posture

## Procedure

### Step 1 — Fetch upstream

```bash
git fetch upstream
```

### Step 2 — Get the file list

```bash
git diff --name-only upstream/main...main > /tmp/delta.txt
```

Note the triple-dot syntax — gives us files where *our* `main` diverges from the merge base. Excludes things upstream changed that we haven't synced yet (those should already be merged).

### Step 3 — Group by component

Bucket each file into one of:

- **Dual-transport HTTP trigger server** — anything under `apps/server/`
- **Documentation** — `*.md` at repo root, anything under `docs/`
- **CI** — anything under `.github/`
- **Electron tweaks** — files under `apps/electron/` we've modified
- **Agent-side fixes** — files under `packages/*/src/` we've modified
- **Governance** — anything under `roadmap/` or `.agents/`
- **Root configuration** — `tsconfig.base.json`, root `AGENTS.md`/`CLAUDE.md`, etc.
- **Lock files** — `bun.lock` (always diverges; mechanical)
- **Other** — anything that doesn't fit above (flag to user)

### Step 4 — Rewrite `roadmap/upstream/delta.md`

Preserve the structure of the existing file:

- `# Upstream delta` heading
- Last refresh date (today)
- `## Major owned components` with subsections per group
- `## Lock file` note
- `## Refresh command` block

Update the date in the "Last refresh" line. Keep the same group ordering. If a group has no files, omit its section.

### Step 5 — Report changes

Tell the user:

- Total files in the delta (vs previous report)
- New groups or new files since last report
- Any "Other" bucket entries that need manual classification

## Constraints

- Don't modify any other roadmap files.
- Don't touch git state (no commits, no checkouts).
- Always include the `bun.lock` note even though it's mechanical — it's expected and helps anyone reading.
- Honor the established grouping — don't invent new categories without surfacing first.

## Tools

- `Bash` for `git diff --name-only`
- `Read` of existing `delta.md` for structure
- `Write` to overwrite `delta.md` (this is one of the few skills that fully overwrites a file)
- `Glob`/`Grep` to verify file paths exist

## Edge cases

- **File deleted on our side** — `git diff` will show it. Note it as "removed" in the appropriate section.
- **File renamed** — check `git log --follow` to confirm. Group under the new path.
- **Massive delta growth** (e.g., >100 new files) — likely indicates we need to break the report into multiple files; surface to user before sprawling.
