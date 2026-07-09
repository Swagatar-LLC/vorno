# Server-only deployment (headless / remote)

How to run the fork's trigger server (`apps/server`) headless on Linux or remote
infrastructure — Docker primary, systemd documented — and trigger an agent
session over HTTP from another machine. Implements PLAN-013 (VOR-43 / VOR-35);
architecture recorded in [ADR-0008](../roadmap/decisions/0008-apps-server-headless-deployment-unit.md).

> This is a proof-of-concept recipe, not a productized offering. Multi-tenancy,
> horizontal scaling, k8s, auto-update, and IAM/SSO are explicitly out of scope.

## What runs

`apps/server` is the fork-owned **external trigger surface**: REST+SSE and
WebSocket on one port, per-key `craft_sk_*` auth (SHA-256 hashed at rest),
per-key workspace scoping + permission policy + rate limits. In **standalone
mode** (`CRAFT_STANDALONE=1`) it also composes, in the same process, an in-process
headless `SessionManager` that owns each workspace's `AutomationSystem` — so
scheduled automations and (via PLAN-014) inbound webhooks run with no desktop
app present.

The upstream `packages/server` (full app-server + WebUI + messaging gateway) is a
separate product and is **out of this recipe**. It can share the same CONFIG_DIR,
but standalone mode acquires `{CONFIG_DIR}/.server.lock`, so the two are mutually
exclusive on one config dir (see [ADR-0008](../roadmap/decisions/0008-apps-server-headless-deployment-unit.md)).

## Runtime model

- **Docker (primary):** pinned Bun + Node.js + repo state in one image; volumes
  make the persistence story explicit.
- **systemd (documented alternative):** `bun` on the host, config in the service
  user's home. Simpler where Docker isn't wanted; avoids the container machine-id
  caveat below.
- The image installs **Node.js in addition to Bun** because the Claude Agent SDK
  spawns a subprocess out of `node_modules`. Verifying that subprocess's exact
  runtime resolution under bun-on-Linux is a named checkpoint (see
  [Remaining verification](#remaining-verification-real-deployment)).

## Config & credentials — no persistent env-var secrets

All persistent secrets live in files inside `CONFIG_DIR` (a mounted volume /
service home), never in unit files, compose files, shell profiles, or the repo.

| Secret | Where | Form |
|--------|-------|------|
| API keys (`craft_sk_*`) | `{CONFIG_DIR}/server-config.json` | SHA-256 hashes only (plaintext shown once at generation) |
| LLM provider keys | `{CONFIG_DIR}/credentials.enc` | AES-256-GCM, key derived from a machine identifier |

Provision them headless with the entrypoint flags (no UI, no route changes):

```
bun run apps/server/src/index.ts --provision-llm-key <slug> [--from-file PATH]  # else stdin
bun run apps/server/src/index.ts --generate-api-key <name> [--policy P] [--workspaces a,b] [--max-concurrent N]
bun run apps/server/src/index.ts --show-config
```

- The LLM key arrives on **stdin** or `--from-file` (a Docker/systemd secret) — it
  never touches argv, shell history, or `ps`.
- The generated `craft_sk_*` is printed **once**; only its hash is stored.
- Policies: `deny-all`, `allow-safe` (default), `allow-all`.
- Canonical Anthropic API-key slug: `anthropic-api`.

### The container vault caveat (machine-id)

`credentials.enc` is **machine-bound**: you cannot copy it from a Mac to a Linux
box — the derived key differs and decryption fails, by design. Provision on the
target host. In a container, Linux key derivation reads `/var/lib/dbus/machine-id`
then `/etc/machine-id`, then falls back to a *guessable* `username:homedir`
constant. Mitigation baked into the recipe: bind-mount a persistent, random
machine-id file. Generate it once (see [`deploy/README.md`](../deploy/README.md)):

```bash
head -c16 /dev/urandom | xxd -p > machine-id && chmod 0400 machine-id
```

This also makes the vault survive image rebuilds. The systemd path is unaffected
(a real `/etc/machine-id` exists).

## Persistence — volumes

| Path | Contents | Volume |
|------|----------|--------|
| `CONFIG_DIR` (`/data/vorno-agent` in container; `~/.vorno-agent` on metal) | `config.json`, `server-config.json`, `credentials.enc`, `workspaces/{id}/` | **Yes — essential** |
| `~/.claude` (service user HOME) | Claude Agent SDK resume store (ADR-0005: never re-keyed) | **Yes** |
| `/etc/machine-id` | Vault key derivation anchor (container only) | Bind-mount, read-only |

Keep `CONFIG_DIR` and `~/.claude` **paired** on the same host — splitting them
breaks `claudeSessionId` resume references (ADR-0005 §4).

## Network / security

- **Never expose the bare port.** `server-config.json` defaults to
  `host: 127.0.0.1`; `compose.yaml` maps `127.0.0.1:3847`. Front with:
  - **Tailscale** (recommended single-operator): bind localhost, reach via the
    tailnet; WireGuard provides encryption.
  - **Reverse proxy with TLS**: [`deploy/reverse-proxy/Caddyfile`](../deploy/reverse-proxy/Caddyfile)
    (auto-HTTPS; SSE + WS transparent) or [`deploy/reverse-proxy/nginx.conf`](../deploy/reverse-proxy/nginx.conf)
    (explicit SSE `proxy_buffering off` + WS `Upgrade` map).
- `apps/server` has no built-in TLS — acceptable because the recipe never exposes
  it directly.
- Auth + rate limiting already exist (per-key bearer, sliding-window rpm, concurrent
  caps). Scope keys with `--workspaces` so a trigger key can't touch other workspaces.
- `/health` is unauthenticated (liveness); it leaks version + session counts.
  Restrict at the proxy if that matters.
- **Identity model for M2: machine-to-machine `craft_sk_*` keys only.** IAM/SSO is
  parked. `allow-all` on a reachable box means remote code execution for whoever
  holds the key — a deliberate operator choice.

## Non-secret runtime overrides

These are env-driven because the bind address / enablement are not secrets and the
config file may live in a volume provisioned separately from the runtime env:

| Env | Effect |
|-----|--------|
| `CRAFT_CONFIG_DIR` | Config dir (ADR-0005 escape hatch; always wins). Container sets `/data/vorno-agent`. |
| `CRAFT_STANDALONE` | `1`/`true`/`yes`/`on` → compose the headless SessionManager + AutomationSystem. |
| `CRAFT_TRIGGER_ENABLED` | Enable/disable without editing `server-config.json` (fresh-volume boot). |
| `CRAFT_TRIGGER_HOST` / `CRAFT_TRIGGER_PORT` | Override the persisted bind address/port. Invalid port is ignored with a warning. |

---

## Proof-of-concept — Docker

### Setup (on the Linux host / VM)

```bash
# repo root
head -c16 /dev/urandom | xxd -p > machine-id && chmod 0400 machine-id
docker compose -f deploy/compose.yaml up -d --build
```

Provision inside the container (or pre-provision the volume):

```bash
docker compose -f deploy/compose.yaml exec vorno-server \
  bun run apps/server/src/index.ts --provision-llm-key anthropic-api   # paste key, Ctrl-D
docker compose -f deploy/compose.yaml exec vorno-server \
  bun run apps/server/src/index.ts --generate-api-key poc --policy allow-safe
# → prints craft_sk_… once; store it in your own vault. Export it locally as $CRAFT_KEY.
```

Confirm the startup log shows the config-dir resolution (ADR-0005):

```bash
docker compose -f deploy/compose.yaml logs vorno-server | grep '\[config-dir\]'
# → [config-dir] Using /data/vorno-agent — CRAFT_CONFIG_DIR environment override
```

Create/verify a workspace named `poc` in the volume (a workspace is a directory
under `{CONFIG_DIR}/workspaces/` plus an entry in `config.json`).

### Validation — run every command from a different machine than the server

```bash
# 1. Liveness
curl -s https://<host>/health          # or http://<tailscale-ip>:3847/health
# → {"status":"ok", ...}

# 2. Auth is enforced
curl -s -o /dev/null -w '%{http_code}' https://<host>/api/sessions   # → 401

# 3. Trigger a session over HTTP
curl -s -X POST https://<host>/api/sessions \
  -H "Authorization: Bearer $CRAFT_KEY" -H 'Content-Type: application/json' \
  -d '{"workspaceId":"poc","permissionPolicy":"allow-safe"}'
# → 201 {"sessionId": "..."}

# 4. Send a message and stream the response over SSE
curl -s -X POST https://<host>/api/sessions/$SID/messages \
  -H "Authorization: Bearer $CRAFT_KEY" -H 'Content-Type: application/json' \
  -d '{"message":"Reply with the single word PONG."}'
curl -N -H "Authorization: Bearer $CRAFT_KEY" https://<host>/api/sessions/$SID/events
# → assistant events culminating in a completed turn containing "PONG"

# 5. Survives restart with no re-provisioning
docker compose -f deploy/compose.yaml restart vorno-server && repeat 1–4 with the same key
```

**"Working" =** all five pass from a remote machine, with zero secret-bearing env
vars in the compose/unit files or shell profile, and the build check green:

```bash
bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting
```

## Proof-of-concept — systemd (bare metal)

1. Install `bun` to `/usr/local/bin/bun`; clone the repo to `/opt/craft-agents-oss`;
   `bun install --frozen-lockfile`.
2. Create the `vorno` service user. On bare metal the ADR-0005 fork default
   `~/.vorno-agent` is honored with **no env var** — the real `/etc/machine-id`
   makes the vault key strong.
3. Provision as the service user (`sudo -u vorno bun run apps/server/src/index.ts --provision-llm-key anthropic-api`, etc.).
4. Install the unit: `cp deploy/systemd/vorno-server.service /etc/systemd/system/ &&
   systemctl daemon-reload && systemctl enable --now vorno-server`.
5. Front with the reverse proxy; validate with the same 5 commands.

## Remaining verification (real deployment)

The following require a real LLM key on a real Linux host and are **not** covered
by the CI-verifiable build/tests or the local (macOS Docker) smoke:

- **Steps 3–4 with a live turn** — a session actually spawning and streaming
  `PONG` over SSE. This exercises the **Claude Agent SDK node-subprocess runtime
  resolution under bun-on-Linux** — the first checkpoint. The lean image installs
  Node.js defensively; confirm the SDK resolves and spawns its CLI correctly.
- **Vault round-trip across restart *and* image rebuild** — provision a real key,
  restart + rebuild, confirm sessions still resolve credentials (machine-id mount
  working).
- **SSE through the reverse proxy** — confirm Caddy/nginx stream `/events` without
  buffering under a real turn.
- **Idle-session eviction vs long-running triggers** — sessions idle >30 min are
  evicted; tune if long remote work needs it.
- **MCP / Pi tool sessions** — the lean image does not pre-build the
  `session-mcp-server` / `pi-agent-server` / WhatsApp bundles. Sessions using
  those tools need the fuller `Dockerfile.server` image or an added build step.
