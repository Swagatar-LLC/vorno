---
id: LEARNING-003
title: Shared package subpath imports must be declared in exports or vite/webui build breaks
date: 2026-06-03
status: active
component: build
related-plans: []
related-decisions: []
---

# LEARNING-003 — Shared package subpath imports must be declared in `exports` or vite/webui build breaks

## Signal

WebUI (`vite build`) fails late in the build with a resolver error naming a `@craft-agent/shared` subpath:

```
[commonjs--resolver] Missing "./config/models" specifier in "@craft-agent/shared" package
    at resolveExportsOrImports (.../vite/dist/node/chunks/dep-*.js)
    at resolveDeepImport (...)
error: script "webui:build" exited with code 1
```

The same import passes `bun test`, `bun build`, and typecheck without complaint. Only the webui/vite build fails.

## Root cause

`packages/shared/package.json` has an `exports` map. **Bun and TypeScript resolve workspace subpath imports leniently** (they fall back to source-relative resolution), so `import ... from '@craft-agent/shared/config/models'` works even when `./config/models` is not listed in `exports`. **Vite/rollup enforce the `exports` map strictly** — an undeclared subpath is a hard resolution failure.

`apps/webui/vite.config.ts` aliases `@` → `apps/electron/src/renderer`, so the webui bundle includes renderer components. When a renderer component (here `CompactModelSelector.tsx`, via `FreeFormInput.tsx`) imports an undeclared shared subpath, it reaches vite for the first time and the build breaks. The trigger was the fast-mode commit `721e28e4` adding `getModelSupportsFastMode` from `@craft-agent/shared/config/models` to the renderer — *not* the upstream merge, which merely surfaced it on the next full build.

At the time, five `config/*` subpaths were imported across the repo but undeclared: `models`, `llm-connections`, `paths`, `server-config`, `storage`. Only `models` broke because it was the only one reaching the webui bundle; the rest were latent.

## Fix

Declare the subpath(s) in `packages/shared/package.json` `exports`:

```jsonc
"./config/models": "./src/config/models.ts",
"./config/llm-connections": "./src/config/llm-connections.ts",
"./config/paths": "./src/config/paths.ts",
"./config/server-config": "./src/config/server-config.ts",
"./config/storage": "./src/config/storage.ts",
```

Then verify:

```bash
bun run webui:build   # vite build --config apps/webui/vite.config.ts
```

## Recurrence

Every time a `@craft-agent/shared/<subpath>` import is added to a renderer component (or anything else the webui bundles) where the subpath isn't already in the `exports` map. Especially likely after upstream syncs or feature work that pulls shared utilities into UI components. Typecheck and bun tests will stay green, so it slips through until a full webui/electron build runs.

## Prevention

- When adding a `@craft-agent/shared/<subpath>` import that any renderer/webui code path can reach, add the matching `exports` entry in the same change.
- Find undeclared-but-imported subpaths:
  ```bash
  grep -rhno "@craft-agent/shared/[a-zA-Z0-9/_-]*" apps packages --include="*.ts" --include="*.tsx" \
    | grep -v "/dist/" | sort -u
  ```
  then diff against the `exports` keys in `packages/shared/package.json`.
- The webui build is the canary; keep `webui:build` in the daily-driver / CI build check so this can't merge silently.

## References

- `packages/shared/package.json` — `exports` map
- `apps/webui/vite.config.ts` — `@` alias → Electron renderer
- `apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx:38` — triggering import
- fast-mode commits `721e28e4`, `37e8813f`
