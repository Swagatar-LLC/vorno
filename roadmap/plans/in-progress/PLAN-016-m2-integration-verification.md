---
id: PLAN-016
title: M2 local product — end-to-end integration & QA (VOR-45)
status: in-progress
direction: none
owner: jh
created: 2026-07-09
updated: 2026-07-09
related: [PLAN-012, PLAN-013, PLAN-014, PLAN-015, LEARNING-011, LEARNING-015, LEARNING-017, LEARNING-018]
blocked-by: []
---

# PLAN-016 — M2 local product: end-to-end integration & QA (VOR-45)

Board ticket **VOR-45**. This note records the **automatable half** of the M2
final-build integration verification: build the final artifact off `main @ 54257b12`
(all M2 work, PRs #51–#61), verify the bundle stages what it must, and smoke-verify
the packaged app end-to-end against throwaway isolation. Jeff owns the **visual half**
(tray glyph, on-screen FORK badge, Settings pages, live SSE) — listed at the end.

The pass composes the acceptance surfaces of PLAN-012 (tray/embedded trigger server),
PLAN-013 (provisioning CLI, landing page), PLAN-014 (webhooks), and PLAN-015
(production logging) into one packaged-build run.

## VOR-45 integration verification (automatable half) — 2026-07-09

### Build

- Recipe (LEARNING-011 canonical): `PATH="/opt/homebrew/opt/node@22/bin:$PATH" CRAFT_DEV_RUNTIME=1 NODE_OPTIONS=--max-old-space-size=16384 bash apps/electron/scripts/build-dmg.sh arm64` — **exit 0**, no collector OOM (electron-builder 26.15.x file-traversal collector).
- Artifacts:
  - **`apps/electron/release/Craft-Agents-arm64.dmg` — 240 MB** (the DMG Jeff installs from for the visual pass)
  - `apps/electron/release/Craft-Agents-x64.dmg` — 234 MB (config emits both arches; harmless)
  - App: `apps/electron/release/mac-arm64/Craft Agents.app`
- Bundled runtime: Electron 39.2.7 / **Node 22.21.1** (product version 0.11.0, trigger-server 0.4.0).

### Bundle contents (staging)

| Item | Result | Evidence |
|---|---|---|
| pi-agent-server staged (PR #60 / LEARNING-017) | PASS | `Contents/Resources/app/resources/pi-agent-server/index.js` (25.4 MB) + `app/dist/resources/...` |
| session-mcp-server staged (PR #60) | PASS | `Contents/Resources/app/resources/session-mcp-server/index.js` (4.4 MB) |
| Claude Agent SDK | PASS | `node_modules/@anthropic-ai/claude-agent-sdk` **v0.3.197** |
| Native `claude` binary | PASS | `claude-agent-sdk-binary/claude` (224 MB) |
| ripgrep | PASS | `@vscode/ripgrep/bin/rg` (4.3 MB) |
| Vendored bun | PASS | `app/vendor/bun/bun` (57.5 MB) |
| Main bundle | PASS | `dist/main.cjs` (43.8 MB) |
| Webhook IPC group (PR #61) | PASS | `craft-fork:webhooks` ×4 in `main.cjs` (+ bootstrap-preload) |
| Logging IPC group (PLAN-015) | PASS | `craft-fork:logging` ×4 in `main.cjs`; `settings.advanced` in renderer |
| Trigger-server IPC group (PLAN-012) | PASS | `craft-fork:triggerServer` ×7 in `main.cjs` |
| FORK badge accent | PASS | `#c2410c` present in shipped `main-*.js` renderer bundle |
| Fork features in renderer | PASS | `webhook` ×28, `logLevel` ×7, `Remote Access` ×2, `keepAlive` present |

### Method (LEARNING-015 + PLAN-015)

Ran against a **throwaway** config dir + userData dir to avoid the single-instance
lock bouncing the launch (`CFG=$(mktemp -d)`, `UDD=$(mktemp -d)`; launch
`CRAFT_CONFIG_DIR=$CFG "$BIN" --user-data-dir=$UDD`). A prior QA instance and Jeff's
daily-driver were left untouched (distinct userData dirs). Port **34871** for the
embedded server. **New this pass:** verification reads
`$CFG/logs/main-2026-07-09.log` directly — PLAN-015 turned packaged builds
log-diagnosable, closing the LEARNING-015 gap (previously all electron-log transports
were off in production).

### Checklist results

| # | Item | Result | Evidence |
|---|------|--------|----------|
| 3a | Packaged app launches; `$CFG/logs/main-<today>.log` exists with startup lines (PLAN-015 packaged proof) | **PASS** | Plain single-line format `<ISO> LEVEL [scope] msg`; shell-env → i18n → `[config-dir] Using /tmp/... CRAFT_CONFIG_DIR override` → bootstrap → workspace create → clean shutdown all present. This is itself a first-time verification target. |
| 3b-1 | Autostart reconcile (`enabled:true`, port 34871) binds on relaunch | **PASS** | `lsof` shows `Craft Agents` LISTEN 127.0.0.1:34871 ~2 s after launch; log: `[trigger-server] autostart (enabled=true)` + `running on 127.0.0.1:34871`. |
| 3b-2 | `GET /health` → 200 with fork fingerprint | **PASS** | `{"status":"ok","fork":"trigger-server","version":"0.4.0",...}` HTTP 200. |
| 3b-3 | `GET /` landing page (PR #59) → 200 `text/html`, no key material | **PASS** | `content-type: text/html; charset=utf-8`, `cache-control: no-store`, `<title>Trigger Server</title>`, 3.2 KB; only `craft_sk_YOUR_KEY_HERE` placeholder, no real secrets. `/index.html` also 200 HTML. |
| 3b-4 | `/api/*` without key → 401 | **PASS** | `GET /api/workspaces`, `POST /api/sessions`, and a bogus `craft_sk_` bearer all 401. |
| 3c | Provisioning CLI (`--generate-api-key`) from this worktree against `$CFG` → authorized 200 live | **PASS** | CLI wrote hash to the shared `server-config.json`; `Bearer <key>` on `/api/workspaces` returned 200 (My Workspace) with **no restart** (router `loadServerConfig()` per request). Only the SHA-256 hash persisted. |
| 3d | Webhook E2E (202 / 200-dup / 404 matrix + history) | **PASS** (standalone host) | See "Webhooks" below. Embedded host does **not** serve `/hooks` — see finding. |
| 3e | Port conflict → error, not crash; **verifiable in the log** (PLAN-015) | **PASS** | Squatted 34871 with a dumb TCP listener, relaunched: app process stayed alive (`ps` SN), squatter kept the port (no theft), and the log carried `ERROR [main] [trigger-server] start failed: Port 34871 is in use by another application`. Previously (LEARNING-015) this line was invisible in packaged builds. |
| 3e-2 | Recovery after freeing the port | **PASS** | Killed squatter + relaunched → bound 34871 in ~2 s, `/health` 200. |
| 3f | Clean quit: port freed, no orphans | **PASS** | SIGTERM → exit in ~1 s; `lsof :34871` empty; no processes from the throwaway userData; log shows `Cleanup complete` + `[trigger-server] stopped` + `Window closed`. |

### Webhooks (3d) — run against the standalone host

Because the packaged **embedded** host does not mount the webhook receiver
(finding below), the webhook E2E ran against a **standalone `apps/server`** launched
from this worktree with the same `CRAFT_CONFIG_DIR=$CFG` (port 34872,
`CRAFT_TRIGGER_ENABLED=1`) — PLAN-014 §5's designated Phase-1 local E2E path. A
`WebhookReceived` matcher with a `set-status` action (targeting a deliberately fake
session id) was written into `$CFG/workspaces/my-workspace/automations.json`; the
token was minted via `apps/server/scripts/mint-hook-token.ts` (workspace resolved by
id, since the dir slug `my-workspace` ≠ the registered name `My Workspace`).

| Case | Expect | Result |
|---|---|---|
| Happy path (`x-delivery: d-001`) | 202 | **202** `{"eventId":"vor45hook:d-001"}` |
| Duplicate same delivery id | 200 | **200** `{"duplicate":true}` |
| Wrong token | 404 | **404** `{"error":"not found"}` |
| Unknown slug | 404 | **404** |
| Unknown workspace | 404 | **404** |
| Second unique delivery (`d-003`) | 202 | **202** |

Durable state written to the workspace: `automations-history.jsonl` recorded both
deliveries' action outcome — `{"type":"set-status","outcome":"deferred:target-not-found","eventId":"vor45hook:d-001",...}`
(correct: the fake session doesn't exist, so the action defers; ingest still 202);
`webhooks-dedup.jsonl` holds d-001/d-003 (the duplicate was not re-appended);
`webhooks-ingest.jsonl` persisted the queue.

### Findings

1. **Embedded host does not serve `/hooks` → captured as [LEARNING-018].** POSTing to
   the **packaged desktop app's** own trigger server returns **401**, not 202 — the
   supervisor calls `createTriggerServer(config, hostBridge, { log })` without a
   `WebhooksHandle`, and `HostBridge.onWebhookEvent` is a log-only stub
   (`// Future (VOR-33)`). This is the documented Phase-1 state (standalone is the
   E2E path), **not a regression** (PR #57 never tested webhooks). But the PR #61
   Webhooks UI advertises copyable ingest URLs pointing at the embedded server that
   currently 401 — worth closing in the PLAN-013 embedded-executor work. Deferred fix
   sketched in LEARNING-018.
2. **Cosmetic:** the port-conflict `ERROR` log line ends with a trailing `undefined`
   (supervisor logger wrapper forwards a second, absent `err` arg to `mainLog.error`).
   Harmless; grep-able either way.

### Needs Jeff's eyes (visual half — not programmatically verifiable)

- Tray glyph appearance/legibility (light + dark mode; stopped/running/error variants).
- Tray menu contents + interaction feel (Start/Stop/Retry, Copy URL, ⌥-Restart).
- FORK badge visually on-screen (the rust `#c2410c` bar; structurally confirmed shipped).
- Settings → **Remote Access** and Settings → **Advanced** (log level selector, open/reveal log folder) rendered interaction.
- Settings → Automations → **Webhooks** UI (hook CRUD, token show-once). The ingest URL it shows targets the embedded server, which **now receives** as of PR #63 (see addendum).
- Full SSE event stream against a real workspace + LLM connection.

## Addendum — delta re-verification after PR #63 (embedded webhooks) — 2026-07-09

PR #63 (`jh/2026-07-09_embedded-hooks-receiver`) resolved finding #1 / [LEARNING-018]:
the embedded host now composes the shared webhook dispatcher + receiver with
desktop-bound executors and threads the `WebhooksHandle` into `createTriggerServer`.
Rebuilt the **final M2 DMG** off `main @ f5392bf8` and re-ran only the delta.

- **DMG (final M2 artifact for Jeff's sign-off):** `apps/electron/release/Craft-Agents-arm64.dmg` — **240 MB**, exit 0, no OOM. `main.cjs` grew 43.8 → 45.9 MB (the embedded webhook wiring). Bundle quick pass unchanged and green: pi-agent-server (26.7 MB) + session-mcp-server (4.6 MB), SDK 0.3.197, native binary 224 MB, ripgrep, vendored bun; `craft-fork:webhooks`/`logging`/`triggerServer` (4/4/7) in `main.cjs`; FORK accent `#c2410c` in renderer.
- **Webhook E2E against the EMBEDDED packaged server** (server enabled in throwaway `$CFG`, port 34871; hook + minted token; curl the ingest URL the desktop advertises):

  | Case | Before (PR #62 verify) | Now | Result |
  |---|---|---|---|
  | Happy path (`x-delivery: e-001`) | 401 (not mounted) | **202** `{"eventId":"vor45hook2:e-001"}` | **FIXED** |
  | Duplicate delivery | — | **200** `{"duplicate":true}` | PASS |
  | Wrong token | — | **404** `{"error":"not found"}` | PASS |

  The delivery routed through the **live desktop `SessionManager`**: `automations-history.jsonl` recorded `{"type":"set-status","outcome":"deferred:target-not-found",...}` for the fake session id (correct — action defers, ingest still 202); `webhooks-dedup.jsonl` recorded `e-001`.
- **Port-conflict log cosmetic fix confirmed:** the ERROR line is now exactly
  `ERROR [main] [trigger-server] start failed: Port 34871 is in use by another application`
  — **no trailing `undefined`** (verified with a `undefined$` match). App stayed alive, squatter kept the port (no theft). Clean quit: port freed, no orphans.

Net: all of VOR-45's automatable half is green, and the one finding is closed and
re-verified in the packaged build. This DMG is the final M2 artifact.

## Status log

- `2026-07-09` — created in `in-progress/`. Ran the VOR-45 automatable verification
  against a real arm64 DMG built with the canonical LEARNING-011 recipe (240 MB, exit
  0, no OOM). Bundle staging complete (subprocess servers, SDK 0.3.197 + native binary
  + ripgrep + vendored bun, all three `craft-fork:*` IPC groups, FORK accent). All
  packaged smoke items passed: PLAN-015 packaged log file proven (startup + full
  `[trigger-server]` lifecycle **including the port-conflict ERROR line** — the
  LEARNING-015 closure); autostart, `/health` fork fingerprint, `/` landing page,
  `/api` 401, provisioning-CLI key live-authorized, port-conflict error-without-crash
  + recovery, clean quit no orphans. Webhook E2E (202/200-dup/404 matrix + history)
  passed against the standalone host. One finding captured as LEARNING-018 (embedded
  host doesn't mount `/hooks`); LEARNING-015 annotated as superseded on its no-logs
  half. No regressions vs PR #57. Visual half handed to Jeff.
- `2026-07-09` — delta re-verification after PR #63 (see Addendum). Rebuilt the final
  M2 DMG off `main @ f5392bf8`; the embedded packaged server now serves `/hooks`
  (**202/200/404**, routed through the live `SessionManager`), closing LEARNING-018;
  port-conflict log line's trailing `undefined` gone. This DMG is the final M2 artifact
  for Jeff's sign-off.
