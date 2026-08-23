---
id: PLAN-041
title: Server-homed instances with auth (STUB)
status: planned
direction: DIR-05
owner: jh
created: 2026-08-22
updated: 2026-08-22
related:
  - PLAN-013-server-only-deployment.md (shipped foundation)
  - PLAN-023-hosted-workspace-server.md (archived; Phase 0 remains authoritative)
  - PLAN-039-workflow-definitions-reusable-parameterized-tasks.md
  - PLAN-040-integrate-headroom.md
blocked-by:
  - PLAN-039
  - PLAN-040
---

# PLAN-041 — Server-homed instances with auth *(stub)*

> **Stub.** This plan is deliberately unscoped. It exists so the DIR-05
> milestone (PLAN-039/PLAN-040) is designed with this destination in mind —
> definition ownership, instance identity, and storage seams must not preclude
> it. Do not start; expand into a real plan (goal/scope/approach/acceptance)
> when the DIR-05 milestone is done.

## Sketch

Workspaces and workflow definitions homed on headless server instances
(PLAN-013's deployment unit, PLAN-023's hosted-workspace direction), with:

- **Instance identity + authentication** — who may connect to an instance,
  beyond today's single WebUI password.
- **Run coordination** — which instance owns which workflow run; leasing so
  two workers never dispatch the same node; fencing for zombie instances.
  *This is the point where the storage question (SQLite-with-WAL vs. a real
  multi-writer store) actually becomes a durability-adjacent decision — not
  before.*
- **Multi-instance configuration** — a configuration layer for managing
  several instances without a heavyweight external service.
- **A trustable hostable unit** — the instance packaged as a one-command
  deploy target (`fly.toml`, `render.yaml`) suitable for shopping to
  hosting platforms, with referral/partnership arrangements per instance
  started as the business angle. Post-milestone; see the note in DIR-05.

## How this lands: incrementally, not as one build

Product-owner framing (2026-08-22): instance-level **user awareness**,
**access control on workflow files**, and **proper workflow versioning** do
not arrive as a single server-auth epic. They land **incrementally, via
ADRs and guiding principles** — each DIR-05-era design decision (definition
identity, storage layout, run records) carries a short "server-homed
consequences" note, so that by the time this stub becomes a real plan, most
of the architecture is already settled on paper and the build is small.
Expanding this stub should begin by collecting those notes, not by
designing from scratch.

## Salvaged from prior plans (PLAN-045 Pass 1)

This stub says expansion "should begin by collecting those notes, not by
designing from scratch." Pass 1 of PLAN-045 collected them. The architecture
work below is **already done on paper** — PLAN-023 Phase 0 shipped
`docs/hosted-workspace-architecture.md` and ADR-0013 (accepted with conditions);
its Phases 1–3 never built. Read those two documents before expanding this stub.
← `PLAN-023-hosted-workspace-server.md`

**Settled architecture to inherit (do not re-derive)**

- **The app-server is the hosted-workspace unit**, not the trigger server:
  `bootstrapServer()` already serves the WebUI SPA, speaks the
  `MessageEnvelope` RPC both clients use, has built-in TLS
  (`CRAFT_RPC_TLS_CERT/KEY`), and takes the single-writer lock.
- **Three trust zones drawn explicitly**: (a) the transport token admitting a
  client to RPC/WebUI, (b) the vault holding LLM + source credentials, (c) the
  per-source OAuth tokens. Which zone a secret lives in, who reads it, and what
  compromising each grants.
- **Portable vs host-bound state.** Workspaces/config/sessions/sources/skills
  are plain files and rsync-able; `credentials.enc` is machine-bound by design
  (PBKDF2 over `getStableMachineId()`) and must be re-provisioned, never copied;
  `~/.claude` must stay *paired* with `CONFIG_DIR` or resume lineage breaks
  (ADR-0005 §4). This table is the migration constraint.
- **Secrets never ride env vars at runtime** — they live only in `CONFIG_DIR`
  (PLAN-013), and no inline secrets belong in root config; secret-bearing kinds
  go to the vault (ADR-0019 forward constraint, recorded but never implemented).
  ← `PLAN-013-server-only-deployment.md`,
  `PLAN-029-storage-provider-config-and-management-surfaces.md`

**Directly on-point for run coordination / leasing**

- **The lock question is already half-answered and half-open.**
  `bootstrapServer` acquires `{CONFIG_DIR}/.server.lock` (one app-server per
  config dir), but **`apps/server` takes no lock at all**, and PLAN-013
  recorded that concurrent-writer semantics against shared session state are
  *unvalidated* — "an open question, not a promise." That is precisely where
  leasing and fencing must start.
  ← `PLAN-013`, `PLAN-023`
- **`SessionPool` vs `SessionManager` convergence** has been an open question in
  three plans now (PLAN-012 §6, PLAN-013/ADR-0008, PLAN-023). Two session stacks
  on one host cannot both own run leases. Settle it here or it will be settled
  by accident. ← `PLAN-012-tray-server-supervision.md`, `PLAN-013`, `PLAN-023`
- **The standalone server enforces automation closure through
  `checkStatusAction` rather than the SessionManager choke point** — so the
  ADR-0021 invariant is single-point *per host*, not globally single-point.
  Multi-instance makes that a real divergence.
  ← `PLAN-031-status-invariants-at-the-choke-point.md`

**Identity, auth, and the vault**

- **Client-owned vault key (the zero-trust option).** Alongside the
  machine-bound default, support a user-supplied/generated key shown once and
  never again — decoupling the vault from the host machine-id and making
  migration and restore portable. Lost key = re-auth everything; the one-time
  reveal must make that unmistakable. Machine-bound stays the default.
  ← `PLAN-023`
- **A registered-origin registry keyed on `instanceId`, exact origins only —
  no wildcards, no raw-URL trust.** The relay plan already specifies this, and
  deliberately shares *one* pairing ceremony between two consumers rather than
  inventing a second. Instance identity should be minted once and reused.
  ← `PLAN-036-vorno-owned-oauth-redirect-relay.md`
- **An endpoint constant is the address of a *service*, never of a *resource*.**
  Flipping a base-URL constant strands every resource created under the old one.
  Instance-homed workspaces will have resources with instance-scoped URLs;
  persist the resource's own origin beside its id from day one.
  ← `PLAN-035-vorno-hosted-session-shares.md` (LEARNING-057)
- **`safeStorage` encryption of the WebUI password at rest** was scoped as a
  follow-up and never landed — an open security residue that an
  authentication plan should not inherit silently.
  ← `PLAN-020-webui-autostart-tray-port.md`
- **A trust boundary gets a security review before code, never simplified
  away.** ← `PLAN-027-interactive-surfaces-mcp-apps-bridge.md`
- **A public endpoint needs a privacy policy first.** Swagatar becomes data
  controller the moment user data lands on infrastructure it operates; this is
  a legal gate, not a follow-up. ← `PLAN-035`

**Sync, upgrade, backup**

- **git push/pull is the only sanctioned sync fabric — never file-sync working
  trees between hosts** — and the provider interface (token acquisition +
  remote URL construction) is defined once, provider-agnostic, so GitLab is
  first-class rather than bolted on. ← `PLAN-023`
- **Two unanswered lifecycle questions** carried from PLAN-023 and still
  unanswered: the **upgrade story** for an instance holding live workspaces and
  resume state (image bump + volume-compatibility guarantee + `config.json`
  schema migration), and **backup/restore** of a server `CONFIG_DIR` that now
  holds the user's whole working life.

**The hostable unit**

- **PLAN-013's two checkpoints were never closed** and gate any hosted claim:
  (1) a live LLM turn completing end-to-end in-container, and (2) SDK
  node-subprocess resolution under bun-on-Linux. ← `PLAN-013`
- **Non-technical setup shape**: one-command install/compose with a wizard that
  generates the WebUI password + server token and prints/QR-encodes the
  connection URL, plus a desktop first-run "Connect to your online Vorno?"
  extending the existing `CRAFT_SERVER_URL` thin-client path. ← `PLAN-023`
- **Field observability is thinner than it looks.** The standalone server logs
  to stdout only (journald/launchd is the sink; the shared logging helpers are
  a documented but unused seam), OS-level log integration was deferred, and the
  auth log has no source-IP. A remote instance nobody can diagnose is a support
  burden. ← `PLAN-015-production-logging.md`,
  `PLAN-033-hermetic-config-dir-for-test-runs.md`
- **TLS termination** is either the app-server's own
  (`CRAFT_RPC_TLS_CERT/KEY`), a reverse proxy, or `tailscale serve`;
  `tailscale cert` issuance was named as future work and never done.
  ← `PLAN-005-webui-tailscale-launcher.md`, `PLAN-023`

## Status log

- `2026-08-22` — created as a stub behind the DIR-05 milestone.
- `2026-08-22` — amended from product-owner review of PR #171: user awareness / access control / versioning land incrementally via ADRs + guiding principles; hostable-unit + deploy-target partnership note added.
