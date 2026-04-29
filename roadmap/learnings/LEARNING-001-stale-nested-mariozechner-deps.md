---
id: LEARNING-001
title: Stale nested `@mariozechner/*` deps in workspace packages
date: 2026-04-29
status: active
component: build
related-plans: []
related-decisions: []
---

# LEARNING-001 — Stale nested `@mariozechner/*` deps in workspace packages

## Signal

Bun build fails inside `packages/pi-agent-server/src/index.ts` (or similar consumer) with errors like:

```
❌ Pi agent server build failed: 29 |   createReadToolDefinition,
       ^
error: No matching export in "node_modules/@mariozechner/pi-coding-agent/dist/index.js" for import "createReadToolDefinition"
    at /Users/jeffhampton/dev/craft-agents-oss/packages/pi-agent-server/src/index.ts:29:3
```

Multiple imports report "No matching export" simultaneously. The exports listed *do* exist in the latest published version — checking root `node_modules/@mariozechner/pi-coding-agent/dist/index.js` shows them. The disconnect is at resolution time.

## Root cause

Bun's monorepo resolution sometimes installs **stale nested copies** of `@mariozechner/*` packages in individual workspace packages' `node_modules/` directories, while the root `node_modules/` resolves to a newer version. Bundlers walking outward from the workspace package pick up the older nested copy first.

Observed pattern (post-v0.8.x upstream syncs):

| Workspace | Stale nested version | Root version |
|-----------|----------------------|--------------|
| `packages/shared/node_modules/@mariozechner/pi-ai` | `0.56.2` | `0.70.2` |
| `packages/server-core/node_modules/@mariozechner/pi-ai` | `0.56.2` | `0.70.2` |
| `packages/pi-agent-server/node_modules/@mariozechner/{pi-ai,pi-agent-core,pi-coding-agent}` | `0.56.2` | `0.70.2` |

The pattern is the same as the `max_output_tokens` type-check error noted in `roadmap/upstream/HEAD.md` — different package, same mechanism.

## Fix

Remove the stale nested copies; root resolution will then take over.

```bash
cd /path/to/craft-agents-oss
rm -rf \
  packages/shared/node_modules/@mariozechner \
  packages/server-core/node_modules/@mariozechner \
  packages/pi-agent-server/node_modules/@mariozechner

# Verify only the root copy remains
find . -path "*/node_modules/@mariozechner" -type d 2>/dev/null | grep -v "\.git"

# Re-run the build that failed; it should now succeed.
```

`bun install` after the deletion will not restore the stale copies (it picks the resolved-correct version, which already exists at root).

## Recurrence

Likely to recur on:

- Each upstream sync that bumps `@mariozechner/*` versions in `package.json`
- Some `bun install` runs after switching branches that have different `bun.lock` content
- Cold-clone followed by certain failed/partial installs

Roughly once per upstream sync cycle, based on observed history.

## Prevention

Considered, not yet implemented:

1. **Postinstall hook** in root `package.json` that runs the cleanup command. Risk: masks other resolution issues.
2. **`bun-cleanup-stale-deps.sh` script** in `scripts/` so the fix is one command instead of three. Lower risk; cosmetic.
3. **Upstream PR** — this is a bun monorepo resolution quirk; arguably belongs as a bun-side fix or a published pattern. Not our problem to solve solo.

For now: the fix is documented here, `roadmap/upstream/HEAD.md` references this learning, and the `[skill:upstream-sync]` skill should run a verification step after each merge.

## References

- `roadmap/upstream/HEAD.md` — "Standard conflicts seen" section
- The earlier `max_output_tokens` instance in `packages/shared` that was a sibling instance of the same root cause
- [bun.sh docs on workspace resolution](https://bun.com/docs/install/workspaces)
