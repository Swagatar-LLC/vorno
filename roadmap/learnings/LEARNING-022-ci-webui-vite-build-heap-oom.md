---
id: LEARNING-022
title: WebUI Vite build OOMs on CI runners without a NODE_OPTIONS heap default in build-dmg.sh
date: 2026-07-13
status: active
component: build
related-plans: []
related-decisions: []
---

# LEARNING-022 — WebUI Vite build OOMs on CI runners without a NODE_OPTIONS heap default in build-dmg.sh

## Signal

The release workflow's "Build Vorno (arm64)" step (which runs `apps/electron/scripts/build-dmg.sh`) dies during the **webui** Vite build on GitHub's macOS runners:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 1: 0x102ee22c4 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [/opt/homebrew/Cellar/node@22/22.23.1/lib/libnode.127.dylib]
error: script "webui:build" was terminated by signal SIGABRT (Abort)
error: script "electron:build" exited with code 134
##[error]Process completed with exit code 134.
```

Key discriminator vs [LEARNING-011](LEARNING-011-electron-builder-bun-collector-oom.md): the GC trace tops out at **~2 GB** (`Mark-Compact (reduce) 2039.2 (2088.0) -> ...`) — a *bounded* heap hitting Node's default ceiling — not LEARNING-011's *unbounded* collector walk that climbs to whatever ceiling you give it. Here, more heap genuinely fixes it.

## Root cause

The webui Vite build legitimately needs more than Node's default old-space heap (~2 GB on the runner's node@22). Local builds never hit this because the operator's recipe (from LEARNING-011) always exported `NODE_OPTIONS=--max-old-space-size=16384` at the *invocation* — but that env lived in shell history / skill docs, not in the script. CI ran `build-dmg.sh` bare, so every Node child process (Vite renderer/webui builds, electron-builder) got the default heap and the largest one (webui) hit the ceiling.

First observed on release run [29299946732](https://github.com/Swagatar-LLC/craft-agents-oss/actions/runs/29299946732) — the first-ever CI packaging run for v0.11.2. It could never have been seen locally.

## Fix

Bake the heap default into `build-dmg.sh` itself so every entry point (local or CI) inherits it, while still respecting a caller override:

```bash
# apps/electron/scripts/build-dmg.sh (after .env loading, before arg parsing)
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
```

Shipped in commit `5b01bc70` (PR [#75](https://github.com/Swagatar-LLC/craft-agents-oss/pull/75)). 4096 MB is enough for the webui build on macos-14 runners; callers who need more (e.g. the LEARNING-011 belt-and-suspenders 16384) can still export their own `NODE_OPTIONS`.

## Recurrence

- If a future upstream sync rewrites/replaces `build-dmg.sh` and drops the export, the very next tag-triggered CI release will fail the same way.
- If webui bundle growth outpaces 4096 MB, the same signature returns — bump the default in the script, not in the workflow.

## Prevention

- The default lives in the script, not the CI workflow or a skill doc, so every invocation path is covered.
- When reviewing upstream-sync diffs, treat `build-dmg.sh` env-setup lines as fork-critical (same class as the FORK badge).

## References

- Commit `5b01bc70` — `fix(release): default NODE_OPTIONS heap in build-dmg.sh (CI webui OOM)` (PR #75)
- Failed run: https://github.com/Swagatar-LLC/craft-agents-oss/actions/runs/29299946732
- [LEARNING-011](LEARNING-011-electron-builder-bun-collector-oom.md) — the *other* packaging OOM (unbounded collector walk; heap bumps do NOT fix that one)
- General lesson (echoes LEARNING-011's recurrence note): environment required for a build to succeed must live **in the build script**, not in the invoker's shell.
