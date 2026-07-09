---
id: ADR-0008
title: apps/server is the fork's headless deployment unit; Docker primary
status: proposed
date: 2026-07-08
supersedes: []
superseded-by: []
---

# ADR-0008 — `apps/server` is the fork's headless deployment unit; Docker primary

## Context

The approved "Inbound Webhooks & Headless Server — Design Spec" (Notion, approved
2026-07-06) requires the fork to run headless/hosted (VPS/container/cloud), not
only Electron-spawned. PLAN-013 operationalizes the deployment half of that spec.

The repo has **two** server stacks, and they are different products:

- **`apps/server`** — the fork-owned external **trigger surface**: REST+SSE + a
  WebSocket transport on one port; per-key `craft_sk_*` auth (SHA-256 hashed at
  rest in `server-config.json`), per-key workspace scoping + permission policy +
  rate limits. Strict CI test suite + a `bun build` gate.
- **`packages/server` + `packages/server-core`** — upstream's full headless
  **app-server**: `MessageEnvelope` RPC for the Electron thin-client / WebUI /
  CLI, `SessionManager`, messaging gateway, WebUI hosting, built-in TLS, and a
  `bootstrapServer` that acquires `{CONFIG_DIR}/.server.lock`.

What is true in the tree: `apps/server` runs its **own** session stack
(`SessionPool`/`AgentSession` wrapping `CraftAgent`) and, until now, had no
in-process `server-core` `SessionManager` — so automations/webhooks could not run
without a desktop host. `AutomationSystem` is constructed only inside
`SessionManager` (per workspace), and its receiver seam (`onPromptsReady`) is a
constructor callback.

ADR-0007 already decided the **host-adapter** shape: the trigger server is
constructed by its host through a seam; embedded (Electron) binds the
`onWebhookEvent` callback to the desktop `AutomationSystem`/`SessionManager`,
standalone binds it to headless instances. This ADR decides the **deployment
unit and runtime** for the standalone case.

## Decision

**`apps/server` is the fork's headless deployment unit, extended with an opt-in
standalone mode (`CRAFT_STANDALONE=1`) that composes an in-process headless
`server-core` `SessionManager` (which owns each workspace's `AutomationSystem`)
alongside the existing trigger path. Docker is the primary runtime recipe;
systemd is documented as the bare-metal alternative. `packages/server` remains an
optional companion, out of the PoC.**

Rationale for `apps/server` as the unit:

1. It is the fork-owned surface with real multi-key auth, scoping, and rate
   limiting — the right posture for a box reachable from elsewhere.
2. "Trigger a session over HTTP from another machine" is exactly its job.
3. It is the surface PLAN-014's webhooks build on; one deployment story serves
   both plans.
4. Its strict test suite and `bun build` check give CI guardrails the upstream
   stack doesn't.

Elaboration of the standalone composition (PLAN-013 open-question decisions):

- **`.server.lock`: standalone acquires it.** Once this process owns an in-process
  `SessionManager` writing workspace/session state under `CONFIG_DIR`, a
  concurrently launched `packages/server` (which also takes the lock) would be a
  second writer to the same state. Taking the lock makes the two hosts mutually
  exclusive on a shared config dir — the correct writer-safety posture. The pure
  trigger path (standalone **off**) keeps taking no lock, preserving today's
  behavior exactly. Implementation reuses `server-core`'s `acquireServerLock`
  (now exported) so the PID-reuse / previous-boot / Docker-PID-1 staleness
  handling is identical.
- **Two session stacks run in parallel, not converged.** The trigger
  `SessionPool` and the standalone `SessionManager` sit side by side in one
  process. Convergence is a larger refactor, deferred; documented as future work.
- **The `onWebhookEvent` seam lives at the host layer** (per ADR-0007's
  HostBridge model), instantiated by the standalone host with a logging stub —
  **not** threaded into the upstream-synced `AutomationSystem`/`SessionManager`.
  This avoids upstream-merge churn and collision with PLAN-014's automations
  work; PLAN-014 injects the real dispatcher and owns everything downstream.
- **Config-dir correctness (ADR-0005).** On bare metal the fork default
  `~/.vorno-agent` is honored with no env var; in the container the documented
  `CRAFT_CONFIG_DIR` escape hatch points at a named volume. Resolution is logged
  at startup (`[config-dir] Using … — …`).
- **Non-secret runtime overrides are env-driven** (`CRAFT_TRIGGER_HOST/PORT`,
  `CRAFT_TRIGGER_ENABLED`) so a container can boot against a fresh volume and
  bind without editing the persisted file. Secrets never ride env vars.

Runtime: Docker (or Podman/OCI) primary — pinned Bun + Node.js + repo state in one
image, volumes make persistence explicit. systemd + `bun install` on the host is
the documented alternative and avoids the container machine-id caveat. The image
includes **Node.js in addition to Bun** because the Claude Agent SDK spawns a
subprocess out of `node_modules`.

## Consequences

### Positive

- One deployment story serves both PLAN-013 (triggers/automations) and PLAN-014
  (webhooks) — webhooks are just more routes on the same port.
- No Electron host required for automations/webhooks; the spec's standalone mode
  is realized as a peer host of the same core.
- Secrets live only in `CONFIG_DIR` files (API-key hashes, AES-GCM vault); the
  recipe requires zero secret-bearing env vars at runtime.
- CI guardrails (strict `apps/server` tests + `bun build`) cover the deployment
  unit; the lean image is smaller than `Dockerfile.server` (no WebUI/WhatsApp).

### Negative

- Two session stacks in one process is a real (if bounded) complexity cost until
  convergence.
- Exporting `acquireServerLock` slightly widens the fork's `packages/server-core`
  delta; the `webui-serve.ts` / `getMessagingDir` fixes widen the diff too. All
  small, additive, in-process (not wire), recorded in `upstream/delta.md`.
- The lean image does not pre-build the MCP/Pi/WhatsApp helper bundles, so tool-
  heavy sessions need the fuller image or an added build step.

### Neutral

- The container vault key is only as strong as its machine-id: an operator who
  skips the bind-mounted `machine-id` silently gets the weak `username:homedir`
  derivation. Called out in the recipe.
- The Claude Agent SDK subprocess runtime resolution under bun-on-Linux is a named
  verification checkpoint, not an assumption; Node.js is installed defensively.

## Alternatives considered

- **`packages/server` as the deployment unit** — it has TLS and the full RPC
  surface, but single-bearer-token auth (no per-key scoping/rate limits), a
  heavier image (WebUI + messaging), an upstream-owned threshold-based test suite,
  and it is not the surface webhooks build on. Rejected as the primary unit; kept
  as an optional companion.
- **A standalone binary (`bun build --compile`)** — attractive for distribution,
  but out of scope for the PoC; noted as a future option.
- **Thread `onWebhookEvent` through `AutomationSystem`/`SessionManager` options**
  (as the PLAN-013 design note suggested) — cleaner conceptually, but edits two
  upstream-synced files and collides with PLAN-014's parallel automations work.
  Superseded by ADR-0007's host-layer HostBridge seam.

## References

- PLAN-013 — Server-only deployment path (this ADR's implementation).
- PLAN-014 — Per-workspace webhooks (rides this recipe; owns `onWebhookEvent`
  payload semantics).
- ADR-0005 — Fork default config dir `~/.vorno-agent` + `CRAFT_CONFIG_DIR` escape
  hatch (honored by the recipe).
- ADR-0007 — Trigger-server host adapter (embedded vs standalone host; the
  `onWebhookEvent` seam this ADR instantiates for the standalone case).
- "Inbound Webhooks & Headless Server — Design Spec" (Notion, approved 2026-07-06).
- `roadmap/upstream/compatibility.md` — no protocol surface changes; `craft_sk_*`
  and REST/SSE are fork-owned.
- `deploy/` + `docs/server-deployment.md` — the artifacts and PoC walkthrough.
