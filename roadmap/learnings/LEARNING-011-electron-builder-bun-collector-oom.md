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

## Part 2 — the 26.15.x build packages but the app won't launch ("Cannot find module")

Fixing the OOM was necessary but **not sufficient**. The 26.15.x build produces a `.dmg`, but launching the packaged app crashes immediately:

```
Error: Cannot find module '@anthropic-ai/claude-agent-sdk'
  (from Contents/Resources/app/dist/main.cjs)
```

### Part 2 root cause

Two independent facts combine:

1. `apps/electron/build:main` bundles the main process with esbuild but **externalizes the SDK**: `--external:@anthropic-ai/claude-agent-sdk`. So `main.cjs` keeps a **static top-level `require("@anthropic-ai/claude-agent-sdk")`** and depends on it being present in `node_modules` at runtime.
2. `electron-builder.yml` ships that SDK (plus the arch-matched native binary alias `claude-agent-sdk-binary` and `@vscode/ripgrep`) via **`extraResources`** with `from: node_modules/@anthropic-ai/claude-agent-sdk` — **not** via the file collector (`files:` explicitly excludes `node_modules/**`, because electron-builder auto-excludes node_modules since v20.15.2).

Under the repo's bun **hoisted** linker (`bunfig.toml → linker = "hoisted"`), those packages are installed at the **monorepo root** `node_modules`, so `apps/electron/node_modules/@anthropic-ai/…` does not exist. electron-builder logs `file source doesn't exist from=…/node_modules/@anthropic-ai/claude-agent-sdk` and **silently skips** the missing `extraResources`, producing a bundle with **no SDK** → runtime `require` throws at launch. (The earlier "empty collection" symptom is the same missing-source condition, not a broken files filter.)

Corollary: **`bun run electron:dist:dev:mac` alone can never produce a runnable app** on this repo. It only runs electron-builder; it does not stage the hoisted deps into `apps/electron/node_modules` first. The 172 MB dmg produced in Part 1 packaged fine but was **not launchable** — a runnable arm64 dmg is ~259 MB because it includes the ~217 MB `claude` native binary that staging brings in.

### Part 2 fix — use the upstream-canonical staging path

`apps/electron/scripts/build-dmg.sh` (aka `bun run --cwd apps/electron dist:mac`) exists precisely to stage the hoisted deps into `apps/electron/node_modules` before electron-builder runs: it copies the SDK core from root `node_modules`, resolves the arch-matched native binary to the stable `claude-agent-sdk-binary` alias, copies `@vscode/ripgrep`, copies the interceptor sources, and downloads the pinned vendored Bun — then packages.

Run it adapted for unsigned local use (no `op`/`.env` needed; the script's 1Password + signing branches no-op when absent; the forced `CSC_IDENTITY_AUTO_DISCOVERY=true` finds no valid Developer ID and cleanly skips signing):

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" \
  CRAFT_DEV_RUNTIME=1 NODE_OPTIONS=--max-old-space-size=16384 \
  bash apps/electron/scripts/build-dmg.sh arm64
```

Verified end-to-end: bundle now contains `Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk` (v0.3.197), `claude-agent-sdk-binary/claude` (217 MB), and `@vscode/ripgrep/bin/rg`; `require.resolve('@anthropic-ai/claude-agent-sdk')` from `dist/` resolves into the bundle; the packaged main process boots through full init (shell-env → i18n → config-dir → CLI tools → proxy) with **no "Cannot find module"**.

Gotchas hit while running it: `set -e` + a stale `release/mac-arm64` made the initial `rm -rf` fail with "Directory not empty" — clear `apps/electron/{release,vendor,packages,node_modules/@anthropic-ai}` by hand and re-run. And the script calls `bun install` / `npx electron-builder`, so keep `node@22` on PATH (see the node@25/simdjson gotcha above).

### Part 2 prevention

- The `electron-prod-build` skill's flavor table was corrected: **`electron:dist:dev:mac` does NOT yield a shareable/runnable artifact** — use `dist:mac` (build-dmg.sh) for anything you launch or hand to a user.
- If a one-command dev-runtime packaging flow is ever wanted, it must first stage the SDK/ripgrep into `apps/electron/node_modules` (the build-dmg.sh steps) — a bare electron-builder invocation will always ship an SDK-less bundle under the hoisted linker.

## References

- electron-builder collector cycle-guard fixes: 26.3.4 / 26.9.1 / 26.11.0 line; stricter-collector follow-ups tracked in electron-builder issues #9654 and #9445.
- `apps/electron/scripts/build-dmg.sh` — canonical staging + packaging path (Part 2).
- `apps/electron/electron-builder.yml` — `extraResources` SDK staging + `files: "!node_modules/**"` (why staging is mandatory).
- electron-builder auto-excludes `node_modules` from `files` since v20.15.2: https://github.com/electron-userland/electron-builder/issues/3104
- [`roadmap/learnings/LEARNING-001`](LEARNING-001-stale-nested-mariozechner-deps.md) — sibling "bun monorepo tree confuses an external tool" failure mode.
- [`roadmap/upstream/compatibility.md`](../upstream/compatibility.md) — why the `^26.0.12` pin means 26.15.x is a lockfile-only, in-contract bump.
