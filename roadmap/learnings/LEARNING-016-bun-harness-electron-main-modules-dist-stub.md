---
id: LEARNING-016
title: Electron main-process modules can run under plain Bun for verification — stub the missing dist with ELECTRON_OVERRIDE_DIST_PATH
date: 2026-07-09
status: active
component: electron
related-plans: [PLAN-015]
related-decisions: []
---

# LEARNING-016 — Electron main-process modules can run under plain Bun for verification — stub the missing dist with ELECTRON_OVERRIDE_DIST_PATH

While verifying PLAN-015's production logging (which lives in `apps/electron/src/main/logger.ts`), running the module under plain Bun — the only practical way to unit-exercise a main-process module's real behavior without booting the whole app — died at import time.

## Signal

```
error: Electron failed to install correctly, please delete node_modules/electron and try installing again
      at getElectronPath (…/node_modules/electron/index.js:17:15)
      at <anonymous> (…/node_modules/electron-log/src/main/index.js:3:7)
```

Any Bun/Node script that (transitively) imports `electron-log/main` — or anything else that does a bare `require('electron')` — hits this in a fresh worktree.

## Root cause

Two stacked facts:

1. **`bun install` in a fresh worktree does not reliably produce `node_modules/electron/dist/`** — the postinstall download can be skipped or partially hoisted (here: `dist/` contained only `LICENSES.chromium.html` + `version`, no `Electron.app`, no `path.txt`). Re-running `node node_modules/electron/install.js` exited 0 without repairing it (its `isInstalled()`/cache logic short-circuits).
2. The `electron` npm package's `index.js` **throws at require time** when `path.txt`/dist are missing — *unless* `ELECTRON_OVERRIDE_DIST_PATH` is set, in which case it just returns a joined path string with **no existence check**.

Meanwhile `electron-log` is deliberately runtime-agnostic: it only ever touches `this.electron.app?.…` etc. with optional chaining and try/catch, so it degrades to Node fallbacks (`os.homedir()` paths) when the "electron" export isn't a real API object. The only blocker is the throwing `require`, not any actual Electron dependency.

## Fix

Point `ELECTRON_OVERRIDE_DIST_PATH` at any existing directory; `require('electron')` then resolves to a harmless string and electron-log (and similar defensive libraries) fall back to Node behavior:

```bash
cd apps/electron
CFG=$(mktemp -d)
ELECTRON_OVERRIDE_DIST_PATH=/tmp \
CRAFT_CONFIG_DIR="$CFG" \
CRAFT_IS_PACKAGED=true \
bun /tmp/plan015-harness.ts   # imports src/main/logger.ts directly
```

`CRAFT_IS_PACKAGED=true` flips `resolveDebugMode()` into the production branch, so the packaged-build code path is exercised without building a DMG (complements LEARNING-015's "verify via HTTP surface" for full-app checks).

## Recurrence

- Any harness/test that imports an `apps/electron/src/main/*` module under Bun/Node in a worktree where the Electron binary was never downloaded.
- Only works for modules whose electron usage is defensive (electron-log). Modules importing `electron`'s real API (`app`, `shell`, `BrowserWindow`) at top level still need the real runtime.

## Prevention

- Reuse the recipe above for future main-process verification harnesses (PLAN-015's harness is the reference: rotation, redaction, live level change, pruning — 16 checks, no Electron binary).
- If a real binary is required, budget for `node node_modules/electron/install.js` being flaky in worktrees; deleting `node_modules/electron` and re-running `bun install` is the reliable path.

## References

- PLAN-015 (production logging) — the harness this was built for.
- LEARNING-015 — packaged-app smoke verification (the full-app counterpart).
- `node_modules/electron/index.js:getElectronPath` (the `ELECTRON_OVERRIDE_DIST_PATH` escape hatch); `node_modules/electron-log/src/main/ElectronExternalApi.js` (defensive electron access).
