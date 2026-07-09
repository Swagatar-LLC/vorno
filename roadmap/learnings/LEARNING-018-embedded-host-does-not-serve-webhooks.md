---
id: LEARNING-018
title: The packaged (embedded) trigger server does not serve /hooks — POST returns 401, not 202
date: 2026-07-09
status: active
component: electron
related-plans: [PLAN-012, PLAN-014]
related-decisions: [ADR-0007]
---

# LEARNING-018 — the embedded host does not serve `/hooks` (webhook receiver is standalone-only)

## Signal

Curling the webhook receiver on the **packaged desktop app's** own trigger server
returns a `401`, never a `202`:

```
$ curl -s -X POST http://127.0.0.1:34871/hooks/<workspace>/<slug>/<token> -d '{}'
{"error":"Missing Authorization header"}      # HTTP 401
```

This is surprising because (a) the webhook *management UI* shipped in PR #61
(PLAN-014 Phase 3) composes copyable ingest URLs **from the embedded trigger
server's own host/port** (`registerWebhooksHandlers` reads `supervisor.getConfig()`),
and (b) minting a token, writing a `WebhookReceived` matcher, and POSTing to that
exact URL all *look* wired. The provider-facing endpoint the UI hands you simply
isn't listening.

## Root cause

The webhook receiver is composed into the router **only when a `WebhooksHandle` is
passed to `createTriggerServer`**:

```ts
// apps/server/src/router.ts:78 — the /hooks route is gated on `webhooks` being present
if (method === 'POST' && webhooks) {
  const hookParams = matchRoute(path, '/hooks/:workspace/:hookSlug/:token');
  ...
}
```

Two hosts compose the same runtime-neutral core (`createTriggerServer`, ADR-0007),
but only one builds and passes that handle:

- **Standalone Bun host** (`apps/server/src/index.ts:45-51`) — builds
  `createWebhookDispatcher()` + `initWebhooks(...)` and passes `{ webhooks }`.
  `/hooks` **is** served; deliveries dispatch into a per-workspace
  `AutomationSystem` registry. This is PLAN-014 §5's designated "Phase 1 — the
  local E2E path."
- **Embedded Electron host** (`apps/electron/src/main/trigger-server/supervisor.ts:224`)
  calls `createTriggerServer(config, this.hostBridge, { log })` — **no `webhooks`
  option**. So `createRouter(pool, registry, undefined)` never registers `/hooks`,
  and the POST falls through to the auth gate → `401`.

Compounding it: the desktop `HostBridge.onWebhookEvent`
(`apps/electron/src/main/index.ts:1085`) is bound to a **log-only stub** — the code
comment literally reads `// Future (VOR-33): route into the workspace
AutomationSystem via sessionManager.` Even if the route existed, the bridge would
only log, not execute actions.

This is **not a regression.** It is the documented Phase-1 state: PLAN-012 froze the
`onWebhookEvent` seam and wired it to a no-op logger "until VOR-33"; PLAN-014 Phase 1
wired the *standalone* host as the E2E path and explicitly deferred the embedded
executor bindings to the PLAN-013 headless/embedded host work. PR #57's VOR-42
verification never exercised webhooks, so nothing that worked before is broken.

## Fix (deferred — not applied in the verification pass)

The receiver module (`packages/shared/src/automations/webhook-ingest/` +
`apps/server/src/webhooks/init.ts`) is HTTP-agnostic and not Bun-specific, so
closing the gap is mechanically small:

1. In the Electron main bootstrap, build `createWebhookDispatcher()` + `initWebhooks()`
   the same way `apps/server/src/index.ts` does, binding the dispatcher to the real
   desktop `AutomationSystem`/`SessionManager` instead of the log-only stub.
2. Thread the resulting `WebhooksHandle` into the supervisor and pass it through
   `createTriggerServer(config, hostBridge, { log, webhooks })`.
3. Dispose it in the supervisor teardown (mirror `apps/server`'s `shutdown`).

Until then, webhooks only work end-to-end against a **standalone `apps/server`**
process (or the headless deployment PLAN-013 owns), even though the desktop UI
advertises ingest URLs for the embedded server. Anyone verifying webhooks must run
the standalone host — pointing curl at the desktop app's port will always `401`.

## Recurrence

- Any packaged-app webhook test. Bites every time until the embedded host passes a
  `WebhooksHandle` into `createTriggerServer`.
- Any user who creates a hook in the desktop Webhooks UI, copies the shown ingest
  URL, and hands it to a provider (GitHub/Linear/etc.): the provider's POST returns
  401 against the desktop server. The management surface implies a receiver that
  isn't mounted in that process.

## Prevention

- When wiring the embedded webhook executor (the deferred fix above), add a
  packaged-smoke assertion that `POST /hooks/<ws>/<slug>/<token>` returns `202`
  (not `401`) against the embedded host — the inverse of the probe used here.
- Consider a guard in the Webhooks management handler: if the embedded receiver is
  not mounted, surface "receiver runs in the standalone/headless server" in the UI
  rather than a copyable URL that 401s.

## References

- `apps/server/src/router.ts:78` (route gated on `webhooks`).
- `apps/server/src/index.ts:45-51` (standalone builds + passes the handle).
- `apps/electron/src/main/trigger-server/supervisor.ts:224` (embedded omits it).
- `apps/electron/src/main/index.ts:1085` (`onWebhookEvent` = log-only stub).
- PLAN-014 §5 (standalone = Phase-1 E2E path); PLAN-012 (embedded seam, no-op until VOR-33).
- [LEARNING-015](LEARNING-015-packaged-smoke-verify-no-logs-single-instance.md),
  [LEARNING-017](LEARNING-017-electron-build-never-staged-pi-agent-server.md) — sibling
  "looks wired in dev, isn't wired in the packaged/prod host" failure modes.
