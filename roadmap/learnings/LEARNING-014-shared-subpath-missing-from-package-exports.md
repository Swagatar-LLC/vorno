---
id: LEARNING-014
title: A @craft-agent/shared subpath that tsc resolves can still break `bun build` if it's not in package.json exports
date: 2026-07-09
status: active
component: build
related-plans: [PLAN-014]
related-decisions: []
---

# LEARNING-014 — A @craft-agent/shared subpath that tsc resolves can still break `bun build` if it's not in package.json exports

## Signal

`cd apps/server && bunx tsc --noEmit` passes clean, but the required bundle step fails:

```
error: Could not resolve: "@craft-agent/shared/statuses/storage". Maybe you need to "bun install"?
    at /Users/.../apps/server/src/webhooks/executors.ts:22:52
```

(The build gate command that surfaces it:
`bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting`.)

## Root cause

`packages/shared/package.json` has an explicit `exports` map. When `exports` is
present, `bun build` enforces it strictly: a subpath not listed as an export key
cannot be resolved, even though the file exists on disk at the obvious location.

TypeScript with `moduleResolution: "bundler"` is more lenient in this repo's
setup and resolved `@craft-agent/shared/statuses` / `.../statuses/storage`
directly to the file — so `tsc --noEmit` gave a false all-clear. Other code
(e.g. `packages/server-core`) imports `@craft-agent/shared/statuses` and never
gets bundled by `bun build apps/server`, so the gap stayed latent until an
`apps/server` file imported that subpath and hit the bundle gate.

`./statuses` and `./statuses/storage` were simply missing from the exports map,
while sibling modules (`./sessions`, `./labels`, `./labels/storage`, …) were
present.

## Fix

Add the subpath(s) to `packages/shared/package.json` `exports` (additive, safe):

```jsonc
"./sessions": "./src/sessions/index.ts",
"./statuses": "./src/statuses/index.ts",          // add
"./statuses/storage": "./src/statuses/storage.ts", // add
"./projects": "./src/projects/index.ts",
```

Then re-run the bundle gate to confirm:

```bash
bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting
```

Alternatively, import only through already-exported subpaths (e.g. reach status
helpers via a module that IS exported) — but adding the missing export is the
correct fix since `statuses` is a first-class public module.

## Recurrence

Every time `apps/server` (or any `bun build`-bundled entry) adds an import of a
`@craft-agent/shared` subpath that isn't in the exports map. `tsc` will not warn
you. Most likely when wiring new features that reach into shared modules the
trigger server hadn't used before (statuses, and any future additions).

## Prevention

- Always run the build-check gate locally, not just `tsc` — they disagree on
  export enforcement. The CI `build-check` job would have caught it, but the
  local `tsc`-only loop will not.
- When importing a new `@craft-agent/shared/<subpath>`, grep
  `packages/shared/package.json` for that key first; if absent, add it.

## References

- [LEARNING-003](LEARNING-003-shared-subpath-exports-vite-enforced.md) — the
  vite/webui variant of the same root cause (subpath must be in `exports`). This
  entry is its `bun build` sibling and adds the tsc-passes-but-bundle-fails
  false-negative detail.
- PLAN-014 — `apps/server/src/webhooks/executors.ts` imported
  `@craft-agent/shared/statuses/storage`, surfacing the missing export.
