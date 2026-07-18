---
id: ADR-0013
title: Hosted workspace server AuthN/AuthZ — single-principal now, multi-user-ready seams, three trust zones
status: proposed
date: 2026-07-18
supersedes: []
superseded-by: []
---

# ADR-0013 — Hosted workspace server AuthN/AuthZ — single-principal now, multi-user-ready seams, three trust zones

## Context

PLAN-023 productizes a self-hosted app-server that hosts a user's workspaces, with the desktop attaching as a thin client (`CRAFT_SERVER_URL`) and phones on the WebUI. Phase 0 is design-only: the AuthN/AuthZ and instance/workspace-management architecture, recorded before any implementation.

What is true in the tree today: the app-server (`packages/server` via `bootstrapServer`, `packages/server-core/src/bootstrap/headless-start.ts`) authenticates with a single bearer `CRAFT_SERVER_TOKEN` on the WS RPC and a WebUI password → `craft_session` JWT cookie — both admitting *the* user, with no principal concept past the edge. The credential vault (`credentials.enc`) is AES-256-GCM keyed via PBKDF2 from `getStableMachineId()`, machine-bound by design, with a weak `username:homedir` fallback in containers. WebUI-initiated source OAuth pins its provider-facing `redirect_uri` to the upstream-owned relay (`https://agents.craft.do/auth/callback`, `packages/core/src/branding.ts`). No durable server instance identity exists (`serverId` defaults to `'headless'`), and no workspace git-sync code exists.

Constraints: multi-user implementation is out of scope but the architecture must not preclude it; all new surface is additive under the `vorno:*` namespace (ADR-0012); the repo is public, and Jeff holds go/no-go on one-way doors.

The full boxes-and-arrows, with code grounding and diagrams, is [`docs/hosted-workspace-architecture.md`](../../docs/hosted-workspace-architecture.md). This ADR records the decisions.

## Decision

1. **The app-server (`packages/server` via `bootstrapServer`) is the hosted-workspace unit.** The ADR-0008 trigger server remains the machine-to-machine trigger surface; the two coexist on one host only with distinct CONFIG_DIRs (both take `.server.lock`, making same-dir concurrency impossible by construction).
2. **Single-principal AuthN now; multi-user is a named future reached through existing seams, never the wire.** Today's model (bearer token + WebUI password/JWT) ships unchanged. The multi-user path is fixed as: the edge callbacks (`validateToken` / `validateSessionCookie`) widen from boolean to principal-returning; the principal rides server-side connection state keyed by `clientId`; `MessageEnvelope` never gains an identity field. **The workspace is the AuthZ unit** — future ACLs are `principal → workspace → role`, enforced at the single choke point where handlers resolve a `workspaceId`, keeping `SessionManager` principal-unaware until multi-user actually lands. No per-user vaults, per-user config dirs, or principal wire fields are built now.
3. **Three trust zones are the credential vocabulary:** Zone A transport secrets (server token, WebUI password, JWT — today rooted in one secret; deployment guidance is to set `CRAFT_WEBUI_PASSWORD` distinct from the server token), Zone B the vault (machine-bound `credentials.enc`), Zone C per-source OAuth tokens (stored in the vault; external blast radius). Multi-user AuthN, when it comes, lives in Zone A only.
4. **A client-owned vault key becomes an opt-in alternative to the machine-bound key; machine-bound stays the default.** The key is generated server-side, revealed once in the UI within a limited window, held only by the user thereafter; lost key = re-auth everything, stated at reveal time. `credentials.enc` gains a versioned header recording key-mode and KDF parameters. This is the zero-trust, migration-friendly path and the real fix for the container machine-id weakness.
5. **Hosted instances get durable identity, additively:** a random `instanceId` (+ user-editable display name) persisted in the CONFIG_DIR (`instance.json`), carried in the existing `serverId` envelope field, with richer metadata on a new `vorno:server:info` channel. Instance identity is never derived from machine id and is distinct from user identity (an instance is a place; a user is a principal — 1:1 now, 1:N later without touching instance identity).
6. **First-run onboarding forks at provider selection:** "set up this computer" (existing flow) vs. "connect to your online Vorno" (URL + pairing token, later QR; skips local credential setup; persists a known-instance entry in local config with the pairing token in the desktop's local vault). `CRAFT_SERVER_URL` remains the always-wins escape hatch. Connection failures route to the PLAN-022 connection-error screen, not the local-setup walkthrough.
7. **Git remotes are pluggable behind a three-method provider interface** — token acquisition, remote-URL construction, credential presentation — over git-HTTPS only, with provider tokens stored as ordinary Zone C vault credentials. GitHub ships first but nothing in the interface may assume GitHub semantics; GitLab is the proving second provider. Git push/pull is the only sync fabric; working trees are never file-synced.

## Consequences

### Positive

- Multi-user is reachable by widening existing seams (edge callbacks, connection state, one AuthZ choke point) with zero wire changes — ADR-0012's additive rule holds even for the largest named future.
- The client-owned key decouples vault portability from host identity: backups restore across hosts, container deployments stop degrading to the weak fallback, and a leaked volume yields no credentials.
- Instance identity gives QR pairing, known-instance lists, and multi-source workspace disambiguation a stable key that survives redeploys, without leaking hardware identity.
- One provider interface keeps GitLab (and any git-HTTPS host) first-class rather than bolted onto GitHub-shaped code.

### Negative

- A client-owned-key vault is locked after restart until the user supplies the key — hosted automations stall until unlock. Inherent to the model; surfaced at opt-in.
- Lost client key = re-auth every source and LLM credential. A real footgun carried deliberately; mitigated by UI ceremony, not by escrow (escrow would defeat the zero-trust point).
- SSH-only git hosts are out of scope while git-HTTPS is the sole transport.
- The vault file format gains a versioned header — a migration surface that didn't exist before.

### Neutral

- Reusing `serverId` for `instanceId` is upstream-compatible, but once pairing flows key on it the choice is locked by deployed clients (flagged as a one-way door).
- The Zone A root-secret coupling (JWT signed by the server token; password defaulting to it) is accepted for now; splitting the WebUI password is deployment guidance, not a code change.
- Phase 2 must still remove the `agents.craft.do` relay coupling for self-hosted OAuth (Vorno-owned client IDs / relay); this ADR only fixes where the tokens land (the server's vault) and which zone they live in.

## Alternatives considered

- **Principal on the wire (identity field in `MessageEnvelope`)** — rejected: breaks the additive rule for no benefit; the server already has per-connection state (`clientId`) where a principal belongs, and envelope identity invites clients to assert rather than be resolved.
- **Per-user config dirs / per-user vaults now** — rejected as speculative structure (YAGNI); the workspace-as-AuthZ-unit design reaches shared workspaces without partitioning storage, and partitioning is the hardest thing to unwind if the model changes.
- **Machine-id-derived instance identity** — rejected: leaks hardware identity onto the wire and dies on container rebuilds; a random persisted UUID has neither problem.
- **Key escrow / recovery for the client-owned key** — rejected: any server-side recovery path reintroduces exactly the trust the option exists to remove. Lost key = re-auth is the honest contract.
- **SSH as a git transport** — deferred, not rejected forever: HTTPS+token is the one path all providers support and the only one whose credential fits the existing vault; SSH key management is a separate product surface.

## References

- PLAN-023 — Hosted Workspace Server (this is its Phase 0 deliverable).
- [`docs/hosted-workspace-architecture.md`](../../docs/hosted-workspace-architecture.md) — full architecture with code grounding and diagrams.
- ADR-0005 — config-dir discipline and `~/.claude` pairing (migration constraint honored here).
- ADR-0008 — trigger server as the headless trigger unit (coexistence via distinct CONFIG_DIRs).
- ADR-0012 — additive `vorno:*` namespace (`vorno:server:info`, instance metadata).
- PLAN-013 / PLAN-022 — deployment machinery and remote-access surfaces this design builds on.
