---
id: LEARNING-021
title: Embedded trigger-server health-checks the configured port, so port 0 always fails despite a successful bind
date: 2026-07-13
status: active
component: electron
related-plans: [PLAN-018]
related-decisions: []
---

# LEARNING-021 — Embedded trigger-server health-checks the configured port, so port 0 always fails despite a successful bind

## Signal

With `server-config.json` containing `"port": 0` (ask the OS for a free port), the embedded trigger server binds successfully but the supervisor immediately tears it down:

```
[trigger-server] start failed / lastError: Server started but failed its health check
```

Remote Access settings show state `error` with that message. A fixed port (e.g. `9100`) works fine.

## Root cause

`apps/electron/src/main/trigger-server/supervisor.ts` (`startInternal`) health-checks the **configured** port, not the **bound** port:

```ts
await host.listen(config.host, config.port);
// ...
const healthy = await this.selfHealthCheck(healthHost, config.port); // config.port === 0
```

`EmbeddedHost.listen()` (`host.ts`) returns `Promise<void>` and never reads `httpServer.address()` back, so the OS-assigned port is unknowable to the supervisor; the probe hits `http://127.0.0.1:0/health` and fails. It then stores `this.boundPort = config.port` (also 0), so even status reporting would lie.

The standalone stack already does this correctly — `packages/server-core/src/transport/server.ts` reads the port back in the listen callback:

```ts
this.httpServer.listen(this.requestedPort, this.host, () => {
  const addr = this.httpServer!.address()
  if (typeof addr === 'object' && addr) { this._port = addr.port }
  ...
})
```

Only the Electron-embedded host path lacks the read-back.

## Fix

(Implemented by PLAN-018.) Make `EmbeddedHost.listen()` return the actual bound port:

```ts
// host.ts — in onListening:
const addr = httpServer.address();
resolve(typeof addr === 'object' && addr ? addr.port : port);
```

and in `supervisor.ts` use the returned value for the health check, `boundPort`, GET_STATUS, and the log line:

```ts
const actualPort = await host.listen(config.host, config.port);
const healthy = await this.selfHealthCheck(healthHost, actualPort);
...
this.boundPort = actualPort;
```

Configured non-zero ports are unaffected (`addr.port === config.port`). Workaround until the fix ships: use an explicit free port instead of `0`.

## Recurrence

Any new host adapter (ADR-0007 seam) that wraps a listener without exposing `address().port` reintroduces this for port 0. Also bites anyone who sets `port: 0` expecting standalone-server semantics.

## Prevention

- PLAN-018 adds a supervisor test that starts with `port: 0` and asserts `running` + a real reported port — the regression trips CI.
- When adding host adapters, treat "listen() returns the bound port" as part of the seam contract (matches `WsRpcServer`'s behavior).

## References

- PLAN-018 — carries the fix + tests.
- ADR-0007 — trigger-server host adapter seam (where the contract belongs).
- `packages/server-core/src/transport/server.ts` — the correct read-back pattern.
