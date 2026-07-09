---
id: PLAN-013
title: Server-only deployment path (Linux/remote)
status: planned
direction: DIR-03
owner: jh
created: 2026-07-08
updated: 2026-07-08
related:
  - PLAN-005-webui-tailscale-launcher.md
  - PLAN-014 (per-workspace webhooks — parallel workstream, shared apps/server surface)
blocked-by: []
---

# PLAN-013 — Server-only deployment path (Linux/remote)

## Goal

A clear, reproducible path to running the fork's server stack headless on Linux or remote infrastructure: a working deployment recipe (Docker primary, systemd documented), credential management that does not depend on hand-exported env vars, and validation that a session can be triggered over HTTP from another machine. "Clear path" means this design doc + a working proof-of-concept + docs — **not** full productization.

## Scope

- Decide and document what runs headless (entrypoint choice: `apps/server` vs `packages/server`).
- Runtime recipe: bun on Linux, containerized (primary) and systemd unit (documented alternative).
- Config + credential provisioning without persistent hand-exported env vars: `server-config.json` (hashed API keys), the encrypted credential vault (`credentials.enc`), LLM provider keys.
- Network/security posture: bind address, TLS/reverse-proxy guidance, existing rate limiting.
- Persistence: which state directories need volumes.
- PoC definition with exact validation commands and an unambiguous definition of "working".
- Fix the pre-ADR-0005 hardcoded config-dir literals in the headless launch paths (see Work items).

## Non-goals

- **Webhook endpoints and action vocabulary** — owned by PLAN-014 (see "Boundary with PLAN-014" below).
- Multi-tenancy, horizontal scaling, orchestration platforms (k8s), managed-cloud recipes.
- Auto-update of the deployed server; redeploy is the update mechanism for the PoC.
- Packaging a standalone binary (`bun build --compile`) — noted as a future option only.
- WebUI/Observatory serving from the remote host (PLAN-005 covers the tailnet WebUI pattern; a remote merge of the two is future work).
- Messaging gateway (WhatsApp/Telegram) in the headless deployment — explicitly out for the PoC (`packages/server` concern; `apps/server` doesn't load it).

## What exactly runs headless — entrypoint decision

The repo has **two** server stacks. They are different products:

| | `apps/server` (fork-owned) | `packages/server` + `packages/server-core` (upstream) |
|---|---|---|
| Role | External **trigger surface**: REST+SSE + WebSocket on one port; create sessions, send messages, stream events | Full headless **app server**: upstream `MessageEnvelope` RPC for Electron thin-client / WebUI / CLI, SessionManager, messaging gateway, WebUI hosting |
| Auth | Per-key `craft_sk_*` API keys, SHA-256 hashed at rest in `server-config.json`, per-key workspace scoping + permission policy + rate limits | Single bearer `CRAFT_SERVER_TOKEN` (+ optional WebUI password/JWT cookie) |
| Config | `{CONFIG_DIR}/server-config.json` (`apps/server/src/config.ts`) | Env vars (`CRAFT_RPC_HOST/PORT`, `CRAFT_SERVER_TOKEN`, TLS cert/key paths, …) |
| TLS | Not built in | Built in (`CRAFT_RPC_TLS_CERT/KEY/CA`), refuses non-localhost bind without TLS unless `--allow-insecure-bind` |
| Lock | Takes no `.server.lock` | `bootstrapServer` acquires `{CONFIG_DIR}/.server.lock` |
| CI | Strict tests (`apps/server && bun test`) + build check | Upstream-owned, threshold-based |

**Decision: `apps/server` is the headless deployment unit for this plan.** Rationale:

1. It is the fork-owned surface with real multi-key auth, scoping, and rate limiting — the right posture for a box reachable from elsewhere.
2. "Trigger a session over HTTP from another machine" (the acceptance demo) is exactly its job.
3. It is the surface PLAN-014's webhooks build on; one deployment story serves both plans.
4. Its strict test suite and the `bun build` check give us CI guardrails the upstream stack doesn't.

`packages/server` remains supported as an *optional companion* (thin-client desktop / WebUI access to the same box, per the PLAN-005 pattern) but is **out of the PoC**. It can share the same `CONFIG_DIR` with `apps/server` — `apps/server` takes no `.server.lock` — but concurrent-writer semantics against shared session state are unvalidated; running both simultaneously is an open question, not a promise.

## Runtime: bun on Linux; Docker primary, systemd documented

**Recommendation: Docker (or Podman/OCI) as the primary recipe; a systemd unit documented as the bare-metal alternative.**

- Docker wins on reproducibility (pinned bun + node + repo state in one image), on remote-host ergonomics (one artifact to ship), and on making the persistence story explicit (volumes).
- systemd + `bun install` on the host is simpler where Docker isn't wanted (small VPS, home server) and avoids the container machine-id caveat below. It is documented, tested once manually, but not the CI-validated path.
- The image must include **Node.js in addition to bun**: the Claude Agent SDK spawns a CLI subprocess out of `node_modules`, and (if `packages/server` is ever co-deployed) the WhatsApp worker is explicitly Node-only. Verifying the SDK subprocess's exact runtime resolution under bun-on-Linux is a named PoC checkpoint, not an assumption.

### Dockerfile sketch (PoC — refine during implementation)

```dockerfile
FROM oven/bun:1-debian

# Claude Agent SDK spawns a node subprocess; install Node LTS.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root service user; HOME anchors ~/.claude (SDK resume store).
RUN useradd -m -u 1001 vorno
USER vorno
WORKDIR /app

COPY --chown=vorno:vorno package.json bun.lock ./
COPY --chown=vorno:vorno packages ./packages
COPY --chown=vorno:vorno apps/server ./apps/server
RUN bun install --frozen-lockfile

ENV CRAFT_CONFIG_DIR=/data/vorno-agent
EXPOSE 3847
CMD ["bun", "run", "apps/server/src/index.ts"]
```

Compose sketch:

```yaml
services:
  vorno-server:
    build: .
    ports:
      - "127.0.0.1:3847:3847"   # localhost-only; reverse proxy or tailnet in front
    volumes:
      - vorno-data:/data/vorno-agent     # CONFIG_DIR: config, server-config, credentials.enc, workspaces
      - vorno-home:/home/vorno           # ~/.claude SDK resume store
      - ./machine-id:/etc/machine-id:ro  # stable vault key derivation (see Credentials)
volumes:
  vorno-data:
  vorno-home:
```

### systemd unit sketch (documented alternative)

```ini
[Unit]
Description=VORNO agent trigger server (apps/server)
After=network-online.target
Wants=network-online.target

[Service]
User=vorno
WorkingDirectory=/opt/craft-agents-oss
ExecStart=/usr/local/bin/bun run apps/server/src/index.ts
Restart=on-failure
RestartSec=5
# No Environment= secrets: config + credentials live in ~vorno/.vorno-agent
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/vorno

[Install]
WantedBy=multi-user.target
```

On bare metal the fork default `~/.vorno-agent` (ADR-0005) is honored with **no env var at all**. In the container we use the documented `CRAFT_CONFIG_DIR` escape hatch to point at a named volume — explicit beats guessing the container HOME, and ADR-0005 defines the override as always winning.

## Config and credential management

Principle: **all persistent secrets live in files inside `CONFIG_DIR` (mounted volume / service home), never in unit files, compose files, shell profiles, or the repo.** Env vars appear only transiently during provisioning, if at all.

### 1. Server config + API keys — already file-based, already safe at rest

`{CONFIG_DIR}/server-config.json` holds `enabled`, `host`, `port`, rate limits, and API keys as **SHA-256 hashes only** (`apps/server/src/config.ts` — plaintext is shown once at generation). Nothing here needs env vars. Gap: key generation currently requires the Electron UI or an inline TypeScript snippet — unacceptable headless. Work item: a `--generate-api-key` CLI path (see Work items).

### 2. LLM provider credentials — the encrypted vault, provisioned on the server

Credentials (Anthropic/OpenAI/etc. API keys, OAuth tokens, source credentials) live in `{CONFIG_DIR}/credentials.enc` — AES-256-GCM, key derived via PBKDF2 from a machine identifier (`packages/shared/src/credentials/backends/secure-storage.ts`). Two deployment-critical consequences:

1. **The vault is machine-bound.** You cannot copy `credentials.enc` from a Mac to a Linux box — the derived key differs and decryption fails (by design). Credentials must be provisioned **on the target host**, which needs a headless seeding path (work item below).
2. **Containers usually lack a machine-id.** Linux derivation reads `/var/lib/dbus/machine-id`, then `/etc/machine-id`, then falls back to `username:homedir` — which in a container is a *guessable constant* (e.g. `vorno:/home/vorno`), reducing the vault to obfuscation. Mitigation baked into the recipe: bind-mount a persistent, randomly generated `machine-id` file (`head -c16 /dev/urandom | xxd -p > machine-id`, mode 0400) into `/etc/machine-id`. This also makes the vault survive image rebuilds. The systemd path is unaffected (real machine-id exists).

**Provisioning flow (no persistent env vars):**

```
operator (once, on the server / via ssh):
  bun run apps/server/src/index.ts --provision-llm-key anthropic   # reads key from stdin
  bun run apps/server/src/index.ts --generate-api-key ci-trigger --policy allow-safe
        ├─ writes vault entry into credentials.enc (machine-bound)
        ├─ appends hashed key to server-config.json
        └─ prints craft_sk_… once; operator stores it in their own vault
runtime:
  server reads everything from CONFIG_DIR; environment carries no secrets
```

The provisioning subcommands are new (work item). Reading from stdin (or `--from-file /run/secrets/...` for Docker-secrets users) keeps keys out of shell history and `ps`.

### 3. What we explicitly avoid

- `ANTHROPIC_API_KEY`-style exports in unit files or shell rc — works, but rots, leaks via `systemctl show -p Environment`, and contradicts the acceptance criteria.
- Secrets in the image or repo (hard rule).
- Plaintext key material in `server-config.json` (already impossible — hashes only).

## Network / security posture

- **Default stance: never expose the bare port.** `server-config.json` defaults to `host: 127.0.0.1`; keep it there and front with either:
  - **Tailscale** (recommended for personal/single-operator use, consistent with PLAN-005): bind `127.0.0.1`, access via `tailscale serve` / direct tailnet routing; WireGuard provides wire encryption.
  - **Reverse proxy with TLS** (Caddy recommended for auto-HTTPS, nginx documented): proxy `https://host → 127.0.0.1:3847`, including SSE (`proxy_buffering off` / flush intervals) and WebSocket upgrade for `/ws`.
- `apps/server` has no built-in TLS; that is acceptable *because* the recipe never exposes it directly. If direct exposure is ever needed, that's a follow-up feature, not a PoC hack.
- **Auth and rate limiting already exist**: Bearer `craft_sk_*` per request, per-key sliding-window requests/minute and concurrent-session caps (`apps/server/src/middleware/auth.ts`). The recipe documents key scoping (`workspaceIds`, `permissionPolicy`) so a trigger key for one workspace can't touch others.
- `/health` is unauthenticated by design (liveness probes); it leaks version + session counts. Recipe note: restrict at the proxy if that matters for the deployment.
- Container hardening: non-root user, read-only rootfs where feasible, no `--privileged`. systemd hardening flags in the unit sketch above.
- Agent blast radius: sessions execute tools on the server host. The recipe defaults new keys to `allow-safe` and documents that `allow-all` on a remote box means "remote code execution for whoever holds the key" — deliberate operator choice.

## Persistence — what needs volumes

| Path | Contents | Volume? |
|---|---|---|
| `CONFIG_DIR` (`/data/vorno-agent` in container; `~/.vorno-agent` on metal) | `config.json` (workspaces, LLM connections), `server-config.json`, `credentials.enc`, `workspaces/{id}/` (sources, skills, session metadata) | **Yes — the essential volume** |
| `~/.claude` (service user HOME) | Claude Agent SDK native resume store; ADR-0005: never re-keyed, never restructured | **Yes** (mount HOME or `~/.claude` specifically) |
| Agent working directories | Wherever sessions `workingDirectory` points (repos, scratch) | Yes if session work should survive redeploys |
| `/etc/machine-id` | Vault key derivation anchor (container only) | Bind-mount, read-only |
| Logs | stdout/stderr → `docker logs` / `journald` | No (PoC); rotation is a productization concern |

## PoC definition — what "working" demonstrably means

The implementation phase delivers, in-repo (suggested: `deploy/` with `Dockerfile`, `compose.yaml`, `systemd/vorno-server.service`, `docs/server-deployment.md`):

**Setup (Linux host or remote VM):**

1. `docker compose up -d --build` on the target host.
2. Provision inside the container (or pre-provision the volume):
   `docker compose exec vorno-server bun run apps/server/src/index.ts --provision-llm-key anthropic` (paste key), then `--generate-api-key poc --policy allow-safe`; create/verify a workspace in the volume.
3. Confirm startup log line `[config-dir] Using /data/vorno-agent — CRAFT_CONFIG_DIR override` (ADR-0005 resolution logging).

**Validation — every command run from a different machine than the server:**

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

# 5. Survives restart with no re-provisioning (credentials + config persist)
docker compose restart vorno-server && repeat steps 1–4 with the same key
```

**"Working" =** all five pass from a remote machine, with zero secret-bearing env vars in the compose file, unit file, or shell profile, and the repo build check still green:

```bash
bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting
```

## Work items (implementation-phase decomposition)

1. **Fix pre-ADR-0005 config-dir literals in headless launch paths.**
   - `scripts/webui-serve.ts:21` hardcodes `~/.craft-agent` and `:96` pins `CRAFT_CONFIG_DIR` to it at spawn. Change: respect an existing `CRAFT_CONFIG_DIR` from the environment; otherwise default to the fork's `CONFIG_DIR` from `packages/shared/src/config/paths.ts`. (PLAN-005 designed the sharing deliberately pre-ADR-0005; post-ADR-0005 the *default* must be the fork dir, with sharing upstream's dir an explicit opt-in via the env var.)
   - Related literal found during this design: `packages/server/src/index.ts` `getMessagingDir` builds `join(homedir(), '.craft-agent', 'workspaces', …)` — should route through `CONFIG_DIR`. Small, same-PR fix candidate; verify against upstream-merge surface first.
2. **Headless provisioning CLI on `apps/server`** — additive flags, no route changes: `--generate-api-key <name> [--policy …] [--workspaces …]`, `--provision-llm-key <connection-slug>` (stdin / `--from-file`), `--show-config`. Unit tests alongside existing strict suite.
3. **Optional env overrides for host/port** (`CRAFT_TRIGGER_HOST` / `CRAFT_TRIGGER_PORT` or config-file-only — decide during implementation; config-file-only is acceptable since the file lives in the volume). Non-secret, so either is compliant.
4. **`deploy/` artifacts**: Dockerfile, compose.yaml, systemd unit, machine-id generation note, Caddy + nginx snippets (SSE + WS upgrade), `docs/server-deployment.md` walking the PoC end-to-end.
5. **PoC execution + verification checkpoints**: SDK node-subprocess resolution under bun-on-Linux (image contents), vault round-trip in-container across restart *and* image rebuild, SSE through the reverse proxy, idle-session eviction behavior under long-lived deployments.
6. **ADR — "apps/server is the fork's headless deployment unit; Docker primary"**: warranted (deployment architecture + entrypoint commitment). Authored in the implementation phase with the then-next free ADR number — PLAN-012's workstream may claim 0007 in parallel, so this doc deliberately does not reserve a number.

## Boundary with PLAN-014 (per-workspace webhooks)

Both plans land code in `apps/server`. Division of ownership:

- **PLAN-013 owns**: deployment/runtime recipe, config-dir correctness, credential provisioning, CLI flags on the entrypoint, `deploy/` + deployment docs. Code changes are additive and confined to `apps/server/src/index.ts` (flag parsing), `config.ts` (provisioning helpers), `scripts/webui-serve.ts`, and new `deploy/` files.
- **PLAN-014 owns**: webhook endpoints, routing (`src/router.ts`, `src/routes/*`), action vocabulary, payload schemas. PLAN-013 does not touch `src/routes/` or `src/router.ts`.
- **Sequencing**: independent until merge; second-to-land rebases. The only shared file risk is `src/config.ts` if PLAN-014 adds webhook config — coordinate by keeping PLAN-013's additions to new exported functions (no reshaping of `ServerConfig` beyond what provisioning needs). Whatever PLAN-014 deploys rides this plan's recipe unchanged — webhooks are just more routes on the same port.

## Wire compatibility

No protocol surface changes. The WS transport keeps mirroring upstream's close codes (4001–4005); REST/SSE is fork-owned and additive; `craft_sk_*` is already recorded as fork-owned in `roadmap/upstream/compatibility.md`. Any future protocol additions from this line of work use the `craft-fork:*` namespace per the contract. The `bun build apps/server` check and the strict `apps/server` test suite remain CI gates.

## Acceptance

- [ ] Design doc merged (this file) with entrypoint decision, Docker-primary/systemd-documented recommendation, and credential model recorded.
- [ ] PoC: all five validation steps pass from a machine other than the server, on Linux (container) — session triggered over HTTP, response streamed over SSE.
- [ ] No secret-bearing env vars required at runtime; secrets live only in `CONFIG_DIR` files (hashed or vault-encrypted); no secrets in the repo.
- [ ] Headless deployment honors ADR-0005 (`~/.vorno-agent` default on metal; explicit `CRAFT_CONFIG_DIR` in the container; resolution logged at startup).
- [ ] `scripts/webui-serve.ts` config-dir fix landed (respects existing `CRAFT_CONFIG_DIR`, defaults to fork `CONFIG_DIR`).
- [ ] `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting` passes; `apps/server` strict tests pass, including new provisioning-CLI tests.
- [ ] `docs/server-deployment.md` (or equivalent) reproduces the PoC from a clean Linux host.
- [ ] ADR for the deployment architecture authored and accepted (number assigned at implementation time).
- [ ] No changes to `apps/server/src/routes/` or `src/router.ts` (PLAN-014's surface).

## Risks / open questions

- **SDK subprocess runtime on Linux/bun** — the Claude Agent SDK's CLI subprocess resolution under bun-on-Linux in a container is unverified; the image includes Node defensively. First PoC checkpoint.
- **Container vault key strength** — mitigated by the mounted machine-id file, but an operator who skips that step silently gets the weak `username:homedir` derivation. Consider a startup warning when the fallback is active (candidate addition to work item 2).
- **`~/.claude` growth and session resume across redeploys** — resume depends on both the HOME volume and `CONFIG_DIR` staying paired; splitting them across hosts breaks `claudeSessionId` references (ADR-0005 §4). Recipe pairs the volumes; doc calls it out.
- **Concurrent `apps/server` + `packages/server` on one config dir** — no lock conflict, but shared-state writer semantics unvalidated. Out of PoC; revisit when remote WebUI access is wanted.
- **Idle eviction vs long triggers** — sessions idle >30 min are evicted (`apps/server/src/index.ts`); fine for triggers, but long-running remote work may need tuning exposed via config later.
- **LLM OAuth (Claude subscription auth) headless** — provisioning flow above covers API keys; OAuth flows need a browser and are out of scope for the PoC (API-key connections only). Flagged for productization.
- **Upstream merge surface** — `deploy/` and CLI flags are fork-only additions; the `webui-serve.ts` and `getMessagingDir` fixes slightly widen the upstream diff. Both are small and documented in `upstream/delta.md` at implementation time.

## Status log

- `2026-07-08` — created in `planned/` (design doc; PoC deferred to implementation phase)
