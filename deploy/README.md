# deploy/ — VORNO trigger server headless deployment

Artifacts for running the fork's `apps/server` (HTTP trigger surface + standalone
headless host) on Linux / remote infrastructure. See
[`docs/server-deployment.md`](../docs/server-deployment.md) for the full,
step-by-step proof-of-concept walkthrough. This file is the quick reference.

| File | Purpose |
|------|---------|
| `Dockerfile` | Lean `apps/server` image (Bun + Node.js; no WebUI/WhatsApp). Build from repo root. |
| `compose.yaml` | Primary runtime recipe. Volumes for CONFIG_DIR, `~/.claude`, machine-id. |
| `systemd/vorno-server.service` | Bare-metal alternative (no Docker). |
| `reverse-proxy/Caddyfile` | Caddy (auto-HTTPS). SSE + WS work transparently. |
| `reverse-proxy/nginx.conf` | nginx (explicit SSE `proxy_buffering off` + WS `Upgrade` map). |

## machine-id (do this first for Docker)

The credential vault (`credentials.enc`) derives its AES key from a machine
identifier. Containers usually lack a real `/etc/machine-id`, so the vault would
fall back to a *guessable* `username:homedir` constant. Mitigation: bind-mount a
persistent, randomly generated machine-id (referenced by `compose.yaml`):

```bash
# From the repo root. Generate ONCE; keep it (mode 0400). Losing it makes an
# existing credentials.enc undecryptable — by design.
head -c16 /dev/urandom | xxd -p > machine-id
chmod 0400 machine-id
```

`machine-id` is git-ignored — never commit it. The systemd path is unaffected
(a real `/etc/machine-id` already exists on the host).

## Docker quick start

```bash
# repo root
head -c16 /dev/urandom | xxd -p > machine-id && chmod 0400 machine-id
docker compose -f deploy/compose.yaml up -d --build

# provision (inside the container; nothing is exported to the host env)
docker compose -f deploy/compose.yaml exec vorno-server \
  bun run apps/server/src/index.ts --provision-llm-key anthropic-api   # paste key, Ctrl-D
docker compose -f deploy/compose.yaml exec vorno-server \
  bun run apps/server/src/index.ts --generate-api-key poc --policy allow-safe
```

Then validate from another machine — see the 5 commands in
[`docs/server-deployment.md`](../docs/server-deployment.md).

## Security posture (summary)

- Never publish the bare port. `compose.yaml` binds `127.0.0.1`; front with the
  reverse proxy or a tailnet.
- All secrets live in `CONFIG_DIR` files (API-key SHA-256 hashes in
  `server-config.json`; provider keys AES-256-GCM in `credentials.enc`). No
  secret-bearing env vars at runtime.
- New keys default to `allow-safe`. `allow-all` on a reachable box is "remote
  code execution for whoever holds the key" — a deliberate operator choice.
