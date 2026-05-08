# `apps/webui` — browser-based Craft Agent UI

The Electron renderer, served over the network by `packages/server` and reached from any browser. Same React/Tailwind UI as the desktop app, talking to the same WS RPC backend.

## `webui:serve` — Tailscale launcher

`bun run webui:serve` (script: [`scripts/webui-serve.ts`](../../scripts/webui-serve.ts)) spins up the headless server bound to your **Tailscale IPv4** on port **9100**, sharing `~/.craft-agent` with the upstream desktop release. Reach it from your iPad (or any tailnet device) at `http://<machine-tailscale-ip>:9100`.

### One-time setup

1. **Install Tailscale** and `tailscale up` on this Mac.
2. **Build the upstream desktop app once** (or run it) so `~/.craft-agent/` exists with workspaces, sources, credentials, etc.
3. **Generate a server token** (long random):
   ```bash
   bun run packages/server/src/index.ts --generate-token
   ```
4. **Pick a short web login password.** This is what you'll type on the iPad.
5. **Export both into your shell** (e.g., `~/.zshrc`) — keep the values in your password vault, not in this repo:
   ```bash
   export CRAFT_SERVER_TOKEN="<long-random-token>"
   export CRAFT_WEBUI_PASSWORD="<short-password>"
   ```

### Running

```bash
bun run webui:serve
```

It will:

1. Detect your Tailscale IPv4 via `tailscale ip -4` (fails fast if Tailscale isn't up).
2. Build the agent subprocesses (`server:build:subprocess`).
3. Build the WebUI bundle (`webui:build`) — every run, no stale-bundle confusion.
4. Start `packages/server` bound to the Tailscale IP, with `--allow-insecure-bind`.

You'll see something like:

```
[webui-serve] WebUI: http://100.x.y.z:9100
[webui-serve] Config dir: /Users/you/.craft-agent
[webui-serve] Bind: 100.x.y.z:9100 (Tailscale, --allow-insecure-bind)
```

Open that URL on any tailnet device and log in with `CRAFT_WEBUI_PASSWORD`.

`Ctrl-C` to stop.

### Why no TLS?

Tailscale already encrypts everything on the wire (WireGuard). Plain HTTP/WS *inside* the tunnel is fine for personal use. The browser will show "Not secure" — that's about TLS, not about the actual network path. If you ever want a green padlock, `tailscale cert` can issue a real cert for `<host>.<tailnet>.ts.net`; out of scope for v1.

### Why share `~/.craft-agent` with the upstream desktop release?

So the WebUI sees the same workspaces, sessions, sources, skills, and credentials as the desktop app — no parallel state, no migration. The Swagatar fork's own runs use `~/.craft-agent-swagatar` (see `electron:dev`/`electron:prod`), which keeps fork experimentation isolated from this shared dir.

> **Mutual exclusion warning.** The session store is not designed for two concurrent writers against the same workspace. **Don't run the desktop app and `webui:serve` at the same time** against `~/.craft-agent` — quit one before starting the other.

### Other env vars

`packages/server` reads many env vars (TLS, WhatsApp worker, debug, etc.). See the header comment in [`packages/server/src/index.ts`](../../packages/server/src/index.ts) for the full list. The launcher only sets what's needed for the Tailscale-WebUI use case.
