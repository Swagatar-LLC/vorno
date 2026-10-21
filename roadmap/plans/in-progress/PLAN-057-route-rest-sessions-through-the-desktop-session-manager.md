---
id: PLAN-057
title: Route REST API sessions through the desktop SessionManager
status: in-progress
direction: DIR-03
owner: jh
created: 2026-10-21
updated: 2026-10-21
related: [PLAN-012, PLAN-013, PLAN-014, ADR-0007]
related-suvs: [SUV-0074-run-api-sessions-in-the-desktop-app.md]
blocked-by: []
---

# PLAN-057 — Route REST API sessions through the desktop SessionManager

## Goal

A session created through the desktop's Remote Access REST API can, behind an
opt-in setting, run as a real desktop session: `browser_tool` works, the
workspace's skills and sources are wired as in a UI session, and the session is
visible in the session list.

## Scope

- Persisted setting `routeSessionsToDesktop` in `server-config.json`, default
  `false`, toggled in Settings → Remote Access ("Run API sessions in the desktop
  app").
- Implement the reserved `HostBridge.createSession` seam (ADR-0007, PLAN-012
  open question 2) in the embedded host, backed by `SessionManager.createSession`
  / `sendMessage` / `cancelProcessing` / `respondToPermission` / `deleteSession`.
- The core adopts the host's session handle into its `SessionPool`, so every
  `/api/sessions*` route, per-key concurrency, ownership and idle eviction work
  the same for both kinds.
- The SSE contract (`event: <type>` + JSON `AgentEvent`, closes on `complete` or
  `error`) is unchanged.

## Non-goals

- The WebSocket session protocol (`/ws`, `/rpc`) keeps the core pool.
- The standalone server (`apps/server` without Electron) never routes: it has no
  host `createSession`.
- No change to `AgentEvent`, `MessageEnvelope` or channel names.

## Approach

```
POST /api/sessions ──▶ router ──(flag on && hostBridge.createSession)──▶ host.createSession
                         │                                              (SessionManager)
                         └──(otherwise)──▶ SessionPool.create (AgentSession, as today)
both kinds ──▶ SessionPool entry {session, apiKeyId}  ◀── all /api/sessions/:id routes
```

Policy mapping (same as the core pool): deny-all → `safe`, allow-safe → `ask`,
allow-all → `allow-all`. Permission requests during a REST turn: allow-all
approves; allow-safe approves the pool's read-only command allowlist; every
other request is held as pending for the REST client (`GET /pending`,
`POST /permissions`) and is never approved silently. Releasing, aborting or
deleting the session denies whatever is still pending.

## Acceptance

- [ ] Setting off (default) or standalone: REST sessions use the core pool, unchanged.
- [ ] Setting on: `POST /api/sessions` creates a SessionManager session; all session routes work on it.
- [ ] Workspace check, policy cap, per-key concurrency and per-key ownership hold for routed sessions.
- [ ] `browser_tool` is available in a routed session; a pool session still reports it unavailable.
- [ ] Tests for the route-through (both settings), policy mapping, and browser-tool difference.
- [ ] `docs/http-trigger-server.md` documents the setting and a placeholder-only curl check.

## Status log

- `2026-10-21` — created in `planned/`
- `2026-10-21` — moved from planned to in-progress
