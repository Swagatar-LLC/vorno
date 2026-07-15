---
id: LEARNING-029
title: Tailscale serve fronts the Web UI with one rule on a loopback bind
date: 2026-07-15
status: active
component: webui
related-plans: [PLAN-022, PLAN-005]
related-decisions: []
---

# LEARNING-029 — Tailscale serve fronts the Web UI with one rule on a loopback bind

## Signal

When wiring the managed secure tunnel (PLAN-022 leg 4), the non-obvious questions
were: what is the *current* `tailscale serve` syntax, how many serve rules does an
HTTP+WebSocket app need, and does the Web UI have to bind `0.0.0.0` for the tunnel
to reach it. Getting any of these wrong produces a tunnel that silently doesn't
carry WebSocket traffic, a mixed-content failure in the browser, or an
over-exposed LAN bind that wasn't necessary.

```
# What you'd see if you got it wrong:
#  - ws:// blocked from an https:// page (mixed content) → RPC never connects
#  - a second serve rule for /ws that isn't needed → confusion / port math
#  - webui.host forced to 0.0.0.0 "so tailscale can reach it" → wrong, over-exposed
```

## Root cause

Three things that training data / intuition get wrong:

1. **Serve CLI changed in Tailscale 1.52.** The modern background form is
   `tailscale serve --bg --https=443 http://127.0.0.1:<port>`; teardown is
   `tailscale serve --https=443 off` (re-run the original command with `off`
   appended — the target arg is optional but the original flags are required).
   `tailscale serve reset` wipes ALL rules (too broad for a targeted teardown).
   Status/URL: `tailscale status --json` → `.Self.DNSName` (a FQDN with a trailing
   dot — strip it) gives `https://<machine>.<tailnet>.ts.net`.

2. **One serve rule covers HTTP *and* WebSocket** *because* of the single-port WS
   proxy (PLAN-022 leg 1). The browser's WS-RPC upgrade goes through the same
   Web UI port at `/ws`, so `tailscale serve` proxying that one port carries both.
   `serve` terminates TLS, so the proxied origin is `https`; `/api/config` mirrors
   `x-forwarded-proto: https` back as `wss` (see `resolveProxiedWsUrl` in
   `apps/electron/src/main/webui/handler.ts`), so the browser upgrades correctly
   with no mixed-content error. No second rule, no port arithmetic.

3. **`tailscale serve` proxies to `127.0.0.1`, so the Web UI stays on loopback.**
   The tunnel does not require `webui.host = 0.0.0.0`. Keeping the default
   loopback bind is the *smaller* exposed surface: only the tailnet (authenticated
   by Tailscale) can reach the machine, and the Web UI listener itself is never on
   a LAN interface. PLAN-005 (dev tooling) bound a headless server to the Tailscale
   *IP*; the productized path is the opposite — bind loopback, let `serve` front it.

## Fix

Commands the `TunnelManager` runs (`apps/electron/src/main/webui/tunnel.ts`), via
`execFile` (never a shell — no interpolation), each with a 15s timeout:

```bash
# up — front the loopback Web UI port with HTTPS in the background:
tailscale serve --bg --https=443 http://127.0.0.1:<port>

# url — read the public tailnet name back (Self.DNSName, strip trailing dot):
tailscale status --json

# down — clear just this rule (best-effort; logs on failure, never throws):
tailscale serve --https=443 off
```

CLI detection: probe `tailscale version` on `PATH` first, then fall back to the
macOS app-bundle CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
Degrade gracefully — absent CLI ⇒ `state: 'unavailable'` with install guidance;
`serve` failure (not logged in / HTTPS not enabled on the tailnet) ⇒ `state:
'error'` with the first stderr line surfaced verbatim.

## Recurrence

Any future tunnel provider (cloudflared etc.) added under `webui.tunnel.provider`,
or any change to the WS-proxy path, re-raises the "one rule vs. two" and
"loopback vs. all-interfaces" questions. Also bites on a Tailscale major bump if
the serve CLI changes again (it did at 1.52).

## Prevention

- `tunnel.ts` has an injectable `exec`/`locateBinary` seam and unit tests
  (`tunnel.test.ts`) asserting the *exact* argv for up/off — a syntax drift fails
  the test, not a user's tunnel.
- The docs section "Secure tunnel (Tailscale serve)" in
  `docs/webui-remote-access.md` states the loopback-is-fine fact explicitly so it
  isn't re-litigated.
- Verify serve syntax against `tailscale.com/kb/1242` (serve reference) before
  editing the commands; do not trust model memory for CLI flags.

## References

- PLAN-022 leg 4 (this work); PLAN-005 (superseded dev-tooling approach).
- `apps/electron/src/main/webui/tunnel.ts`, `handler.ts` (`resolveProxiedWsUrl`).
- Tailscale serve reference: https://tailscale.com/kb/1242 ; serve CLI docs:
  https://tailscale.com/docs/reference/tailscale-cli/serve
- LEARNING-028 (the loopback-RPC/onboarding trap the single-port proxy fixed).
