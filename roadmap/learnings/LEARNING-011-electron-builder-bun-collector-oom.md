---
id: LEARNING-011
title: electron-builder 26.4.0 node-module collector OOMs on bun symlink store
date: 2026-07-08
status: active
component: build
related-plans: []
related-decisions: []
---

# LEARNING-011 — electron-builder 26.4.0 node-module collector OOMs on bun symlink store

## Signal

`bun run electron:dist:dev:mac` (and the raw `electron-builder --config electron-builder.yml --mac` call it wraps) dies during dependency collection with:

```
<--- Last few GCs --->
... Mark-Compact (reduce) 8090.3 (8149.8) -> 8090.2 (8094.8) MB ...
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
/bin/bash: line 1: NNNNN Abort trap: 6   CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --config electron-builder.yml --mac
error: script "electron:dist:dev:mac" exited with code 134
```

Immediately preceded in the log by:

```
• note: bun does not support any CLI for dependency tree extraction, utilizing NPM node module collector instead
```

Key diagnostic: the OOM is **independent of Node version** (reproduced identically on Homebrew `node` 25.1.0 and `node@22` 22.23.1) and **independent of heap ceiling** — memory climbs unbounded to whatever `--max-old-space-size` allows (observed dying at ~4 GB default, ~8 GB, and ~16 GB) then aborts. That signature rules out "just bump the heap" and points at an unbounded walk, not a large-but-finite tree.

## Root cause

Two compounding factors:

1. **The collector, not the runtime.** electron-builder 26.4.0's `NPM node module collector` (the fallback it selects because bun exposes no dependency-tree CLI) walks `node_modules` recursively **without the cycle-guard / memoization** that later releases added. Bun's default **isolated linker** materializes dependencies as a symlink store (`node_modules/.bin`-style symlinks and per-package `node_modules/` links pointing back into a shared store), which contains link cycles and heavy fan-out. The pre-guard collector follows those symlinks and revisits the same subtrees indefinitely, allocating until the V8 heap is exhausted — hence unbounded growth regardless of Node version or heap size.
2. **Dual-arch amplification.** The fork's `electron:dist:dev:mac` script packages **both `arm64` and `x64`**, so the already-pathological walk runs twice per invocation, roughly doubling peak allocation and wall-clock before the abort.

The earlier hypothesis "Node 25 breaks packaging" was **wrong** and is recorded here to save the next person the detour: Node 25 *is* independently broken on this machine (see the related gotcha below), but swapping to Node 22 did **not** fix the packaging OOM — the collector is the actual cause.

## Fix

**Bump electron-builder to 26.15.x — lockfile only.** Upstream pins `electron-builder: ^26.0.12`, so `26.15.3` is already in range; no `package.json` change is needed and wire-compatibility is preserved. The 26.15.x line replaced the OOM-prone npm collector with a **`file traversal collector`** ("using manual traversal of node_modules to build dependency tree") that terminates cleanly on the bun symlink store.

```bash
cd /path/to/craft-agents-oss
bun update electron-builder            # bun.lock: electron-builder 26.4.0 -> 26.15.3
# husky's prepare script shells out to `node`; if the default node is broken,
# run installs with a working node on PATH:
PATH="/opt/homebrew/opt/node@22/bin:$PATH" bun install
cat node_modules/electron-builder/package.json | grep '"version"'   # -> 26.15.3
```

Winning build recipe (single-arch + generous heap + working Node on PATH):

```bash
# 1. compile the main/renderer bundles (Node 22 so the post-build verify step works)
PATH="/opt/homebrew/opt/node@22/bin:$PATH" \
  CSC_IDENTITY_AUTO_DISCOVERY=false CRAFT_DEV_RUNTIME=1 \
  bun run electron:build

# 2. package (run from apps/electron; electron-builder lives in ROOT node_modules/.bin)
cd apps/electron
NODE_OPTIONS=--max-old-space-size=16384 \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  PATH="/opt/homebrew/opt/node@22/bin:$PATH" \
  ../../node_modules/.bin/electron-builder --config electron-builder.yml --mac --arm64
```

Artifacts land in `apps/electron/release/` (not `dist/`): `Craft-Agents-arm64.dmg` (+ `.app` under `release/mac-arm64/`). Note: the config still emits **both** arches even with `--arm64` passed, so an `x64` dmg is produced too; harmless for a dev-runtime build. `NODE_OPTIONS=16384` is belt-and-suspenders — 26.15.x no longer needs it, but it costs nothing and guards against regressions.

## Related gotcha — broken Homebrew `node` 25 (simdjson)

While diagnosing this, the default Homebrew `node` (25.1.0) was itself unusable — any invocation aborts with:

```
dyld[NNNNN]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib
  Referenced from: /opt/homebrew/Cellar/node/25.1.0_1/bin/node
  Reason: tried: ... (no such file) ...  (installed simdjson is 4.6.4 → provides .30, not .29)
```

This broke `electron:build`'s post-bundle **verification** step and husky's `prepare` hook (both shell out to bare `node`). Workaround used everywhere here: prefix commands with `PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. Permanent fix (not done — outside build-only scope): `brew reinstall node` (or `brew uninstall node` and rely on `node@22`). This is why Node 25 *looked* like the culprit — it fails loudly and separately from the collector OOM.

## Recurrence

- Any packaging attempt on a bun-installed tree while electron-builder is < ~26.3.4/26.9.1 (the versions that introduced the collector cycle-guard/memoization). Will recur if a future `bun.lock` regen or upstream sync pins electron-builder back below 26.15.x.
- The Node-25/simdjson breakage recurs on any machine whose Homebrew `simdjson` is upgraded past what the installed `node` formula links against; re-linking `node` or a `brew upgrade node` clears it.

## Prevention

- Keep electron-builder resolved at **≥ 26.15.x** in `bun.lock`. Upstream's `^26.0.12` allows it, so no ADR / compatibility break.
- Bake the winning recipe (single-arch + `NODE_OPTIONS` + `node@22` on PATH) into `.agents/skills/electron-prod-build/SKILL.md` so agents don't rediscover it.
- Consider adding a `bunfig.toml` `[install] linker = "hoisted"` if the symlink store causes further collector-adjacent grief (flattens the tree, removes cycles). Not needed once on 26.15.x, but it's the fallback lever (was ATTEMPT 3 in the triage ladder).

## References

- electron-builder collector cycle-guard fixes: 26.3.4 / 26.9.1 / 26.11.0 line; stricter-collector follow-ups tracked in electron-builder issues #9654 and #9445.
- [`roadmap/learnings/LEARNING-001`](LEARNING-001-stale-nested-mariozechner-deps.md) — sibling "bun monorepo tree confuses an external tool" failure mode.
- [`roadmap/upstream/compatibility.md`](../upstream/compatibility.md) — why the `^26.0.12` pin means 26.15.x is a lockfile-only, in-contract bump.
