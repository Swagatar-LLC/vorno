---
id: LEARNING-028
title: Remote WebUI showed onboarding instead of loading — loopback RPC advertised to remote clients + a catch-all onboarding fallback masked the failure
date: 2026-07-15
status: active
component: webui
related-plans: [PLAN-020, PLAN-022]
related-decisions: []
---

# LEARNING-028 — Remote WebUI dead-ended into the onboarding walkthrough

## Signal

The packaged WebUI (PLAN-020) worked when opened on the SAME host, but from
another device (phone/tablet on the LAN, `http://<lan-ip>:3848`):

- Login succeeded, the SPA loaded.
- Then the user landed in the **onboarding / first-run walkthrough** — as if the
  app were unconfigured — on an instance that was fully set up.
- No error toast, no connection banner, nothing in the main log pointing at RPC.

The tell: same-host worked, remote showed onboarding. Two bugs stacked so the
real failure (RPC transport) never surfaced.

## Root cause

Two independent problems, one hiding the other:

1. **The RPC WebSocket was advertised to remote clients but bound to loopback.**
   The WebUI HTTP host (`apps/electron/src/main/webui/host.ts`, `node:http`, port
   3848) can bind `0.0.0.0`, so a remote browser reached the login page and
   authenticated. But after login the SPA fetches `GET /api/config`
   (`apps/electron/src/main/webui/handler.ts`), which returned
   `ws://<request-host>:<rpcPort>` via `resolveWebSocketUrl` — pointing the
   browser at the in-process `WsRpcServer`, which binds `127.0.0.1` only
   (`packages/server-core/src/bootstrap/headless-start.ts` — `rpcHost ??
   CRAFT_RPC_HOST ?? '127.0.0.1'`). A remote client cannot connect to the host's
   loopback, so every RPC call failed — including `getSetupNeeds()`. Same-host
   worked only because there `<request-host>` resolved to a reachable loopback.

2. **A catch-all "show onboarding to be safe" turned infra failure into first-run
   state.** `App.tsx`'s `initialize()` wrapped `getSetupNeeds()` in a try/catch
   whose catch did `setAppState('onboarding')` with the comment *"If check fails,
   show onboarding to be safe."* For the desktop app that catch is nearly
   unreachable (IPC is in-process); for the browser WebUI it fires whenever the
   RPC transport can't connect. So a transport failure was rendered as a genuine
   unconfigured state — the most misleading possible outcome (it invites the user
   to re-run setup on a working instance).

The combination is what made it invisible: bug 1 produced the throw, bug 2
swallowed it into a plausible-looking screen.

## Fix

PLAN-022 legs 1+2:

- **Single-port WS proxy** (do NOT bind the RPC server outward — smaller exposed
  surface). `host.ts` gained an `upgrade` handler that, on path `/ws`, validates
  the `craft_session` login cookie and RAW-TCP splices the upgrade to
  `127.0.0.1:<rpcPort>`, replaying the request line + headers + head bytes. The
  forwarded `Cookie` header re-authenticates at the RPC hop (`WsRpcServer` does
  not restrict upgrade paths and validates the cookie as auth fallback), so auth
  holds twice. `/api/config` now returns the WebUI's OWN origin
  (`ws(s)://<request-host>/ws`, the same host:port the page loaded from), never
  the RPC port. Result: remote access exposes exactly one port; the RPC protocol
  is unchanged (wire-compat contract untouched).
- **Connection-error screen.** `initialize()`'s catch now distinguishes transport
  failure from unconfigured: it queries
  `window.electronAPI.getTransportConnectionState()` and, when the status is not
  `connected`, renders a new `connection-error` app state
  (`ConnectionErrorScreen`) with a Retry button that re-runs init — **never**
  onboarding. Only a live-but-unconfigured backend falls through to onboarding.

## Recurrence

Any time a fork-owned surface advertises a connection endpoint whose bind scope
differs from the client's reachability (loopback advertised to a remote client),
AND any time a top-level `catch` maps "couldn't reach the backend" to a
first-run/empty state. The second pattern — treating an infra error as
"assume nothing is set up" — is the more dangerous general trap: it hides
failures behind a screen that looks intentional.

## Prevention

- Unit tests for the `/ws` upgrade auth (no/invalid cookie → 401, valid → spliced;
  `apps/electron/src/main/webui/__tests__/host.test.ts`) and for the `/api/config`
  origin behavior including `x-forwarded-*` → `wss` (`handler.test.ts`).
- Rule of thumb captured here: a `catch` around a "is this configured?" probe
  must distinguish "the probe couldn't run" (infra) from "the probe says no"
  (state). Defaulting the former to a first-run UI is a bug, not a safe fallback.

## References

- PLAN-022 — `roadmap/plans/in-progress/PLAN-022-webui-remote-access-single-port-proxy-and-tunnel.md`
- PLAN-020 — original packaged WebUI (introduced the loopback-RPC direct connect)
- LEARNING-026 — prior packaged-WebUI trap (Node-vs-Bun redirect + wrong asset path)
- `roadmap/upstream/compatibility.md` — RPC wire-compat contract (unchanged by this fix)
