---
id: LEARNING-014
title: Smoke-verifying the packaged app needs userData isolation and can't rely on logs
date: 2026-07-09
status: active
component: electron
related-plans: [PLAN-012]
related-decisions: []
---

# LEARNING-014 — Smoke-verifying the packaged app needs userData isolation and can't rely on logs

Two non-obvious things bit while running the PLAN-012 / VOR-42 packaged-build smoke checklist against a real DMG while Jeff's daily-driver app was also running. Neither is derivable from an error message — both surface as *silence*.

## Signal

Symptom 1 — the launched `.app` produces no output and immediately exits; the trigger server never binds:

```
$ CRAFT_CONFIG_DIR=/tmp/vor42-cfg "…/Craft Agents.app/Contents/MacOS/Craft Agents" > /tmp/app.log 2>&1 &
$ lsof -nP -iTCP:34871 -sTCP:LISTEN        # (nothing)
$ wc -c /tmp/app.log                       # 0
$ pgrep -fl "<my-worktree>.*MacOS/Craft Agents"   # (my instance gone — bounced)
```

Symptom 2 — even when the app *does* run, the trigger-server supervisor writes nothing you can grep:

```
$ ls /tmp/vor42-cfg/logs/          # auto-update.log, messaging-gateway.log — but NO main.log
$ grep -i "trigger-server\|running on\|autostart\|EADDRINUSE" /tmp/app.log   # (no matches)
```

## Root cause

1. **Single-instance lock bounces the second instance.** `apps/electron/src/main/index.ts:323` calls `app.requestSingleInstanceLock()` and `app.quit()`s when it loses. The lock is keyed on Electron's **userData** dir (default `~/Library/Application Support/Craft Agents`), which is shared by app *name*, independent of `CRAFT_CONFIG_DIR`. So a verification launch while the daily-driver (or upstream-stable-named build) is running loses the lock and quits instantly — empty log, no port, no process. `CRAFT_CONFIG_DIR` does **not** isolate this; it only moves `~/.vorno-agent`, not Chromium's userData.

2. **Packaged (production) builds disable all electron-log transports.** `apps/electron/src/main/logger.ts:65-67` sets `log.transports.file.level = false` **and** `log.transports.console.level = false` in the production branch. In a packaged `.app` (`app.isPackaged === true`) there is therefore no `main.log` on disk and no `mainLog` output on stdout. Every `mainLog.info('[trigger-server] running on …')`, the port-conflict message, autostart reconcile — all invisible. The only lines in captured stdout are Chromium/renderer console noise (`ELECTRON_ENABLE_LOGGING=1` shows those, not electron-log).

## Fix

Isolate the verification instance with its own userData dir (Chromium switch, separate from `CRAFT_CONFIG_DIR`), and verify behavior through the **HTTP surface + `ELECTRON_RUN_AS_NODE`**, never through logs:

```bash
APP="…/release/mac-arm64/Craft Agents.app"
BIN="$APP/Contents/MacOS/Craft Agents"
CFG=$(mktemp -d); UDD=$(mktemp -d)

# 1. Launch with an isolated singleton lock — does NOT touch the daily-driver.
CRAFT_CONFIG_DIR="$CFG" "$BIN" --user-data-dir="$UDD" >/tmp/app.log 2>&1 &

# 2. Verify state via the server itself, not logs:
curl -s http://127.0.0.1:<port>/health                    # {"status":"ok","fork":"trigger-server",…}
lsof -nP -iTCP:<port> -sTCP:LISTEN                         # bound by "Craft Agents"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/api/workspaces   # 401 (no key)

# 3. Runtime facts (Node version, API presence) via the packaged Electron's own Node:
ELECTRON_RUN_AS_NODE=1 "$BIN" -e 'console.log(process.versions.node, typeof require("http").Server.prototype.closeAllConnections)'
```

For a port-conflict / error-state test where the log would normally carry the message, assert the *observable* instead: after occupying the port, the app process stays alive (`ps -p <pid>`) and does **not** steal the port (`lsof` still shows the squatter) — that is the "surface error, don't crash" contract, log or no log.

## Recurrence

- Any packaged-build smoke test run on a machine where a same-named Craft Agents build is already open (daily-driver, upstream stable). Always bites unless `--user-data-dir` is passed.
- Any attempt to diagnose a packaged-build failure by reading logs. There are none by design. Recurs for every future packaged-verification ticket until/unless production logging policy changes.

## Prevention

- Bake `--user-data-dir=$(mktemp -d)` into any packaged smoke-verify recipe (alongside the existing `CRAFT_CONFIG_DIR=$(mktemp -d)` from LEARNING-011's build recipe).
- If packaged-build observability for the supervised trigger server is wanted (so a failed autostart is diagnosable in the field), that is a **policy change** to `logger.ts` — e.g. keep the file transport enabled at `info` for the `main`/`trigger-server` scopes even in production, writing under `CONFIG_DIR/logs/`. Flagged to the orchestrator; not changed here because altering app-wide production logging is out of scope for a verification pass.

## References

- PLAN-012 §8 (packaged verification checklist) and its §10 results section.
- LEARNING-011 — canonical build recipe (the `CRAFT_CONFIG_DIR=$(mktemp -d)` half of the isolation story).
- `apps/electron/src/main/index.ts:323` (single-instance lock); `apps/electron/src/main/logger.ts:65-67` (production transports disabled).
