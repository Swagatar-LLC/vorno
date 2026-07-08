---
id: LEARNING-010
title: Missing nested `jiti@2.7.0` breaks the pi-agent-server bundle after a Pi SDK bump
date: 2026-07-08
status: active
component: build
related-plans: []
related-decisions: []
---

# LEARNING-010 — Missing nested `jiti@2.7.0` breaks the pi-agent-server bundle

## Signal

After the v0.11.0 upstream merge (Pi SDK `0.79.9` → `0.80.3`), the pi-agent-server
bundle fails:

```
bun build packages/pi-agent-server/src/index.ts --target=bun ...
13 | import { createJiti } from "jiti/static";
                                ^
error: Could not resolve: "jiti/static". Maybe you need to "bun install"?
    at node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:13:28
```

This is **not** the LEARNING-001 signature (`No matching export in ...@earendil-works/...`).
The failing import is a **subpath** (`jiti/static`), and there were **no nested
`@earendil-works` copies** in the workspace packages.

## Root cause

`@earendil-works/pi-coding-agent@0.80.3` depends on **`jiti@2.7.0`** and imports the
`jiti/static` subpath, which **only exists in jiti ≥ 2.7.0**. The root `node_modules/jiti`
resolves to **`2.6.1`** (hoisted from `@tailwindcss/node`, `vite`, and `app-builder-lib`
peers, all of which want `^2.6.1`/`^2.4.2`), and 2.6.1's `package.json` has **no `static`
export**.

`bun.lock` *does* record the correct nested resolution:

```
"@earendil-works/pi-coding-agent/jiti": ["jiti@2.7.0", ...]
```

but the **delta `bun install`** that ran during the merge (`git checkout --theirs bun.lock
&& bun install`, which reported "10 packages installed, Removed: 3") did **not materialize**
the nested `node_modules/@earendil-works/pi-coding-agent/node_modules/jiti` on disk. The
bundler, walking outward from pi-coding-agent, found only root jiti 2.6.1 → no `jiti/static`.

So: it's the LEARNING-001 *class* (nested-dep drift between lockfile and on-disk
`node_modules`), but the inverse shape — a **missing** required nested copy rather than a
**stale** extra one, and it manifests as a **subpath-resolution** failure, not a
missing-named-export failure.

## Fix

Re-run a full `bun install` to materialize the nested copy the lockfile already pins:

```bash
cd /path/to/craft-agents-oss
bun install
# verify the nested copy now exists at the required version:
grep '"version"' node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/package.json
#   → "version": "2.7.0"

# rebuild — now succeeds:
bun build packages/pi-agent-server/src/index.ts --target=bun --outdir=/tmp/pi-build --no-splitting
```

This did **not** change `bun.lock` (the lock already had the right entry; only on-disk
`node_modules` was incomplete). No `rm -rf` was needed — the LEARNING-001 recipe
(delete stale nested `@earendil-works`) does **not** apply here because the problem is
absence, not staleness.

## Recurrence

Likely on any upstream sync that bumps the Pi SDK **when the bump also pulls a nested dep
to a version newer than a hoisted root copy** (here jiti 2.7.0 vs root 2.6.1), *and* the
merge used a partial/delta `bun install`. The tell is a `Could not resolve: "<pkg>/<subpath>"`
error pointing inside `node_modules/@earendil-works/...`.

`pi-agent-server` is **not** built by `validate-pr.yml`, so CI would stay green while a
packaged Pi backend bundle is broken — this only surfaces in the `[skill:upstream-sync]`
Step 5 manual build check. Keep that step.

## Prevention

Considered, not implemented:

1. After every merge, prefer a **full `bun install`** (not the delta that `--theirs` +
   incremental produces) before the pi-agent-server build check.
2. Add the pi-agent-server bundle to a (non-blocking) CI job so nested-dep drift can't hide.

## References

- [LEARNING-001](LEARNING-001-stale-nested-mariozechner-deps.md) — sibling nested-dep-drift
  failure (stale extra copy; missing named export). Same class, different shape.
- `[skill:upstream-sync]` Step 5 — pi-agent-server build check that caught this.
