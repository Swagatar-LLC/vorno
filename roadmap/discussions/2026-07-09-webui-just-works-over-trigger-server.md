---
date: 2026-07-09
participants: [jh, craft-agent]
topic: Making the remote WebUI "just work" from the trigger server
related-plans: [PLAN-005, PLAN-012, PLAN-013]
related-decisions: [ADR-0007]
related-tickets: [VOR-48]
---

# Making the remote WebUI "just work" over the trigger server — 2026-07-09

## Context

VOR-48 (Jeff's QA) surfaced two remote-access papercuts, both now fixed in this PR:
the raw `{"error":"Missing Authorization header"}` at the server root, and the
missing inline explainer on **Settings → Remote Access**. The root now serves a
friendly, unauthenticated landing page.

Jeff's third note — *"the WebUI should 'just work' somehow"* — is bigger than a
landing page and is **explicitly out of scope for implementation** in this PR.
This note records the realistic path so the follow-up plan starts grounded.

## The two servers today

There are two distinct HTTP servers in the fork, and the confusion Jeff hit comes
from them looking like one:

| | Upstream headless server (`packages/server`) | Fork trigger server (`apps/server`) |
|---|---|---|
| Purpose | Serve the full WebUI + drive the app remotely | REST/webhook automation surface |
| Serves WebUI bundle? | **Yes** — `apps/webui/dist` via `CRAFT_WEBUI_DIR` | No |
| Browser auth | Login page + password cookie | n/a (API keys only) |
| Browser transport | `server-core` RPC over WS (`MessageEnvelope`), cookie auth on upgrade | Same `MessageEnvelope` WS *and* REST `/api/*` with `craft_sk_` bearer |
| Config dir | Acquires exclusive `~/.craft-agent/.server.lock` | None — runs **inside Electron main** |

Key evidence:
- WebUI static + login + `/api/config` (advertises the browser-facing `wsUrl`):
  `packages/server-core/src/webui/http-server.ts:138-405`.
- WebUI browser client fetches `/api/config` then opens a `WsRpcClient` with
  cookie auth: `apps/webui/src/App.tsx:75-86`, `apps/webui/src/adapter/web-api.ts:72-80`.
- Exclusive lock that blocks running `packages/server` beside the desktop app:
  `packages/server-core/src/bootstrap/headless-start.ts:122,179-240`; released on
  Electron quit at `apps/electron/src/main/index.ts:98`.
- The fork trigger server already speaks the **same** `MessageEnvelope` WS protocol
  (`apps/server/src/transport/ws-protocol.ts:41-51`) — but against its **own**
  `SessionPool`, deliberately separate from the desktop's live `SessionManager`
  (`apps/server/src/core/create-trigger-server.ts:103-105`).
- The embedded trigger-server host runs in Electron main with the live
  `sessionManager` in closure scope: `apps/electron/src/main/index.ts:1083-1099`,
  `apps/electron/src/main/trigger-server/host.ts`.

## Why the naïve options fall short

1. **Just static-serve `apps/webui/dist` from the trigger server.** The bundle is
   only half of it. The WebUI expects `/api/config`, a cookie login, and a WS RPC
   endpoint wired to the **full** `server-core` handler surface. The trigger
   server exposes REST + a narrower WS channel set against its *own* pool, so the
   WebUI would either fail to connect or show the trigger server's throwaway
   sessions, not the desktop's real ones.

2. **Run `packages/server` (which already serves the WebUI) as the remote-access
   server.** It acquires `~/.craft-agent/.server.lock` and cannot coexist with the
   desktop app on the same config dir. The desktop *is* the running host. This is
   the exact mutual-exclusion PLAN-005 designed around (`webui:serve` /
   `daily-driver` run the headless server *instead of* desktop). Not viable for a
   "toggle it on in the desktop" story.

## Recommendation

**Co-host the WebUI on the embedded trigger-server host, bridged to the desktop's
live `SessionManager`.** The embedded host is the one place that already (a) runs
inside Electron main with the real `sessionManager` in scope and (b) needs no
`.server.lock` because it isn't a second process. That sidesteps the lock conflict
that kills option 2 and the "wrong sessions" problem of option 1.

Concretely, the embedded host would gain:
- Static serving of `apps/webui/dist` (with packaged-build path resolution like
  `CRAFT_WEBUI_DIR`), plus the `login.html` + `/api/config` endpoints.
- A **browser auth** path distinct from automation API keys — either a WebUI
  password (as PLAN-005 uses) or an API-key → short-lived session-cookie exchange.
  Automation `craft_sk_` keys must never be pasted into a browser in cleartext.
- The WebUI's WS RPC routed to the **live `SessionManager`** via the existing
  `HostBridge` seam (already the injection point for webhook/session routing),
  rather than the trigger server's parity `SessionPool`. Practically this means
  mounting the `server-core` handler surface (or extending the fork ws-protocol to
  the WebUI's channel set) against the real manager.
- `/api/config` deriving `wsUrl` from the request origin so it works unchanged for
  localhost, `0.0.0.0` LAN, and Tailscale.

Keep the automation REST API (`/api/*` + bearer) and the WebUI RPC on distinct
path prefixes so the two auth models never collide. No upstream wire-compat break —
this reuses upstream `server-core` handlers and the existing `MessageEnvelope`
protocol — but it widens the fork-owned server's surface, so it warrants an **ADR
touchpoint** alongside ADR-0007.

## Rough scope

Two plans, ~multi-day:

- **Plan A — static WebUI + config on the embedded host.** Serve the bundle +
  `login.html`, add `/api/config` (origin-derived `wsUrl`), and the browser-auth
  exchange. Landing-page "Open WebUI" link when co-hosting is enabled. Ships a
  *reachable, authenticating* WebUI shell.
- **Plan B — RPC bridge to the live SessionManager.** Route the WebUI's WS RPC
  through `HostBridge` to the desktop's real `SessionManager` so the browser sees
  the same workspaces/sessions as the desktop. This is the load-bearing part.

## Interim (today, no new code)

- The **landing page** shipped in this PR already orients anyone who opens the
  remote URL in a browser (status + how to authenticate + where keys live).
- The **supported "real WebUI over the network" path today** remains PLAN-005's
  `bun run webui:serve` / `daily-driver` — the headless `packages/server` bound to
  a Tailscale IP, run *instead of* the desktop app. Document this as the current
  answer to "I want the actual WebUI remotely" until Plans A/B land.

## Open questions

- Browser auth: reuse the PLAN-005 `CRAFT_WEBUI_PASSWORD` model, or mint
  browser sessions from an API key? The latter unifies the key story but needs a
  cookie/session layer the trigger server doesn't have yet.
- Do we deprecate the fork trigger server's parity `SessionPool` for the embedded
  host once the `SessionManager` bridge exists, or keep it for standalone
  (PLAN-013) deployments where there is no desktop `SessionManager`?
