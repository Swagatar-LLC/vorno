---
id: LEARNING-009
title: Per-app tsconfig paths silently break cross-package re-exports (TS2305 "no exported member")
date: 2026-07-03
status: active
component: build/typecheck
related-plans: []
related-decisions: []
---

# LEARNING-009 — Per-app tsconfig paths silently break cross-package re-exports

## Signal

A new module (`packages/core/src/branding.ts`, re-exported via
`packages/shared/src/branding.ts` as `export * from '@craft-agent/core/branding'`)
typechecks clean in `packages/shared` and `packages/ui`, but `apps/electron`'s
`tsc` reports ~40 new errors of the form:

```
Module '"@craft-agent/shared/branding"' has no exported member 'PRODUCT_NAME'.
Module '"../branding.ts"' has no exported member 'DOCS_MCP_URL'.
```

— including at *relative* import sites inside `packages/shared` itself, when
those files are pulled into electron's program.

## Root cause

Each app/package in this monorepo carries its **own** `paths` map instead of
extending `tsconfig.base.json`'s. `apps/electron/tsconfig.json` mapped
`@craft-agent/shared/*` but **not** `@craft-agent/core/*`. Under electron's
program, the re-export specifier `@craft-agent/core/branding` fell through to
node_modules resolution; when that fails (or resolves stale), `export * from`
degrades to an empty export set, so every downstream consumer errors with
TS2305 — pointing at the *consumer*, not at the unresolvable specifier.

Two compounding traps:

1. **The error points at the wrong place.** TS2305 at 40 consumer sites; the
   actual problem is one missing `paths` entry for the transitive package.
2. **A worktree has no node_modules until `bun install` runs**, so
   package-exports fallback resolution behaves differently than in the main
   checkout — a check that passes in one tree can fail in a fresh worktree.

## Fix

Add the missing mapping to `apps/electron/tsconfig.json`:

```json
"@craft-agent/core": ["../../packages/core/src/index.ts"],
"@craft-agent/core/*": ["../../packages/core/src/*"]
```

(and the new subpath to `packages/core/package.json#exports` for runtime/bundler
resolution: `"./branding": "./src/branding.ts"`).

## Rule of thumb

When adding a module in package A that package B re-exports, check the
`tsconfig.json` `paths` of **every app that typechecks B's sources directly**
(electron includes `packages/shared/src` via `include`), not just A's and B's.
If TS2305 "no exported member" appears en masse for symbols you can see in the
file, suspect specifier resolution of an intermediate `export * from`, not the
exports themselves. Also run `bun install` in fresh worktrees before trusting
typecheck results.
