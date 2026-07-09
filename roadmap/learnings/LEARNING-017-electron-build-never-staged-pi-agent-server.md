---
id: LEARNING-017
title: electron:build never staged pi-agent-server; dead staging helpers + config-dir-dependent repro hid it
date: 2026-07-09
status: active
component: build
related-plans: []
related-decisions: []
---

# LEARNING-017 — `electron:build` never staged pi-agent-server (dead helpers, config-dir-masked repro)

## Signal

Creating an automation, or using the "Automation Configuration" edit-popover chat,
fails immediately in a prod/packaged build:

```
piServerPath not configured. Cannot spawn Pi subprocess.
```

Thrown at `packages/shared/src/agent/pi-agent.ts:430` (`spawnSubprocess`), because
`getBackendRuntime(this.config).paths?.piServer` is `undefined`.

## Root cause

**Two independent facts combined to make this look like a backend-selection bug
when it was actually a build-staging bug.**

1. **The backend was selected correctly.** The failing (fork QA) build ran against
   a *separate config dir* — `~/.craft-agent-swagatar` (set by `electron:prod` /
   documented in `[skill:electron-prod-build]`), **not** `~/.craft-agent`. That
   config's only/default LLM connection was `anthropic-api` with
   `providerType: 'pi_compat'` (local Ollama `granite4:latest`). `pi_compat` maps
   to agent provider `pi` (`factory.ts` `providerTypeToAgentProvider`), so **every**
   session — normal chat, the automation-config popover chat, and automation test
   runs — correctly built a `PiAgent`. Inspecting `~/.craft-agent` (which has a
   `claude-max`/anthropic default) shows anthropic and *cannot* reproduce — the
   wrong-config-dir is the trap. There is **no** backend-selection defect.

2. **The Pi subprocess bundle was never produced by the prod/packaged build.**
   `resolveServerPath(hostRuntime, 'pi-agent-server')` (`runtime-resolver.ts`):
   - packaged → `resources/pi-agent-server/index.js`
   - non-packaged (prod-mode `electron:start`/`electron:prod`, and the `.dmg`
     via `build-dmg.sh`) → walk-up for `packages/pi-agent-server/dist/index.js`

   Neither existed. `electron:build` = main + preload + renderer + resources +
   assets — **none of those build or stage the subprocess servers.** The staging
   helpers `buildMcpServers` / `copyPiAgentServer` / `copySessionServer`
   (`scripts/build/common.ts`) existed but were **dead code** — their only callers
   were `scripts/build-server.ts` (the *headless* server) and
   `scripts/electron-dev.ts` (which has its *own* `buildMcpServers`). So **only
   `electron:dev` ever built the Pi/session servers**; `electron:start`,
   `electron:prod`, `build-dmg.sh`, and `electron:dist:mac` never did.
   `apps/electron/resources/{pi-agent-server,session-mcp-server}` are gitignored
   build artifacts (unlike `bridge-mcp-server`, which is committed — that's why
   only Pi/session broke).

Why it hid so long: dev always worked, and prod QA had only ever exercised
**Claude** connections (no `piServer` needed) until this first `pi_compat`
local-LLM QA pass.

## Fix

Wire the existing helpers into the electron build via a new step
`scripts/electron-build-subprocess.ts`, invoked by `electron:build` **before**
`electron:build:resources`:

```jsonc
// package.json
"electron:build:subprocess": "bun run scripts/electron-build-subprocess.ts",
"electron:build": "... electron:build:renderer && electron:build:subprocess && electron:build:resources && electron:build:assets",
```

The script (host-platform `BuildConfig`) runs:
- `buildMcpServers(config)` → builds `packages/{session-mcp-server,pi-agent-server}/dist/index.js`
  (covers the non-packaged prod-mode walk-up), then
- `copySessionServer(config)` + `copyPiAgentServer(config)` → stage into
  `apps/electron/resources/*` (covers packaged `.app`/`.dmg`, matching the
  `electron-builder.yml` `files` globs `resources/pi-agent-server/**/*` and
  `resources/session-mcp-server/**/*`).

Because every packaging entrypoint (`electron:start`, `electron:prod`,
`dist:mac` → `build-dmg.sh`, `electron:dist:mac`) calls `electron:build`, they all
inherit the fix.

**koffi is vestigial here.** `copyPiAgentServer` warns "koffi not found in
node_modules" and the pi-agent-server build passes `--external koffi`, but koffi
is **not in `bun.lock`** and the built bundle has **zero** `koffi` references —
the current Pi SDK (0.80.x) doesn't use it. The warning is harmless; do not chase
it.

No `resolveServerPath` `.ts`-source fallback was added: staging always builds
`packages/*/dist`, so a dev fallback would be redundant and wouldn't help a real
`.dmg` anyway.

## Recurrence

- Any change that removes the `electron:build:subprocess` step, renames the helper
  functions, or drops a helper call. Guarded by
  `packages/shared/src/agent/backend/__tests__/electron-build-stages-subprocess-servers.test.ts`
  (asserts the pipeline wiring + all three helper invocations).
- Any future `pi`/`pi_compat`-backed feature tested only in `electron:dev` will
  *look* fine and still be broken in prod/packaged. **Always QA Pi features in a
  prod/packaged build**, and remember the fork uses `~/.craft-agent-swagatar`.

## Prevention

- Regression test above (runs in CI's `test-shared` threshold job).
- When debugging "wrong backend" reports, **confirm which `CRAFT_CONFIG_DIR` the
  failing build used** before trusting a connection/provider hypothesis — the fork
  and upstream stable have different config dirs with different default connections.

## References

- [LEARNING-011](LEARNING-011-electron-builder-bun-collector-oom.md) — packaging is
  the fork's most fragile surface; canonical packaged path is `build-dmg.sh`.
- [LEARNING-015](LEARNING-015-packaged-smoke-verify-no-logs-single-instance.md) —
  packaged smoke-verify recipe (throwaway `CRAFT_CONFIG_DIR` + `--user-data-dir`).
- `[skill:electron-prod-build]` — `electron:prod` sets `CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar`.
- Board VOR-47.
