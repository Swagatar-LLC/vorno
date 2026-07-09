---
id: ADR-0007
title: Trigger-server host adapter — in-process embedded host in Electron, Bun standalone host
status: proposed
date: 2026-07-08
supersedes: []
superseded-by: []
---

# ADR-0007 — Trigger-server host adapter: in-process embedded host in Electron, Bun standalone host

## Context

The fork's HTTP trigger server (`apps/server`) must run in two host modes per the approved "Inbound Webhooks & Headless Server — Design Spec" (Notion, approved by Jeff 2026-07-06):

1. **Embedded** — the Electron desktop app manages the server lifecycle (tray supervision, PLAN-012), and the receiver-to-automation seam is a **constructor-injected callback** (`onWebhookEvent`, same shape as `AutomationSystem`'s `onPromptsReady`) wired to the desktop host's `AutomationSystem`/`SessionManager`.
2. **Standalone** — headless on a VPS/container with its own in-process headless `AutomationSystem` + `SessionManager` (PLAN-013 scope). Nothing may assume the Electron host exists.

What is true today (verified at `ec74ea3e`):

- `apps/electron/src/main/server-lifecycle.ts` is dead code: it spawns `apps/server/src/index.ts` from TS source via vendored bun, is imported by nothing, and `apps/server` source is not in the packaged bundle — it can never work packaged.
- The server core is runtime-thin: a fetch-style router; only `Bun.serve` and the `ServerWebSocket` typing in `ws-transport.ts` are Bun-specific.
- Electron main already hosts node HTTP+WS (`packages/server-core/src/transport/server.ts` uses `ws` over `node:http`, bundled into `main.cjs`).
- Packaging changes are the fork's most fragile surface (LEARNING-011: collector OOM, silent `extraResources` skips, mandatory staging).

The forces: the spec's callback seam is process-local by definition; the packaged build must work reliably; the standalone mode must share the same server code; supervision must give truthful status.

## Decision

**The trigger server is constructed by its host through a host-adapter seam. The embedded host runs the server in-process in the Electron main process on `node:http` + `ws`; the standalone host keeps the Bun entry. The child-process spawn seam (`server-lifecycle.ts`) is deleted, not wired up.**

Elaboration:

- `apps/server` gains `createTriggerServer(config, hostBridge)` returning a runtime-neutral fetch handler plus WS protocol hooks; `ws-transport.ts` splits into protocol logic and a per-runtime socket adapter (Bun `ServerWebSocket` | npm `ws`).
- `HostBridge` carries the spec's injected callbacks (`onWebhookEvent`, and later optional session routing). Embedded binds them to the desktop `AutomationSystem`/`SessionManager`; standalone binds them to headless instances.
- Supervision (start/stop/status/port-conflict/error states) is an in-process lifecycle controller in Electron main, surfaced via tray and `craft-fork:triggerServer:*` IPC (PLAN-012).
- The standalone Bun entry (`apps/server/src/index.ts`) recomposes on the same core, behavior-identical (dual transport, auth middleware, WS close codes 4001–4005).

## Consequences

### Positive

- The spec's constructor-callback seam works literally as specified — webhook events reach the desktop automation system with no bridge protocol.
- Zero packaging changes: the embedded host compiles into `main.cjs` via the existing esbuild step; no new binaries, no electron-builder edits, no LEARNING-011 exposure. Packaged-build correctness is structural, then smoke-verified.
- One process → one resolution of fork settings (PLAN-011 keep-alive, fast mode, subprocess-env contract) for server-triggered sessions.
- Truthful supervision: status is object state; port conflicts surface synchronously from `listen()`.
- Standalone mode is a peer host of the same core, not a fork of it.

### Negative

- Server load shares the UI process's event loop. Bounded by design (localhost-first, per-key rate limits, body caps), but a real cost.
- A node fetch-bridge and a `ws` socket adapter must be written and maintained (~100 lines + transport split) — the standalone Bun path no longer exercises the exact embedded listener code.
- Hard host-level faults in the embedded listener degrade to an `error` state rather than being isolated in a child process.

### Neutral

- The vendored bun runtime stays in the package for its existing uses; the child-process fallback (bun child + RPC bridge over the local `WsRpcServer`) remains cheap to revive if isolation ever becomes necessary.
- Escalation path if main-process load bites: move the same host behind Electron `utilityProcess` — the host-adapter seam makes that a host swap, not a redesign.

## Alternatives considered

- **Wire up the spawn seam (bundle `apps/server` + bun, supervise a child process)** — cheaper than feared (bun already vendored; server bundles to one 14.6 MB file), but the callback seam cannot cross a process boundary, forcing a bespoke child→main forwarding protocol the spec's design explicitly avoided; sessions/settings resolve in a second process; every bundling change re-enters LEARNING-011 territory. Rejected.
- **Electron `utilityProcess` host** — crash isolation without bundling a runtime, but requires both the node listener port *and* a MessagePort bridge for the seam; costs of both options with the benefits of neither at current traffic. Kept as the documented escalation path.
- **Keep `server-lifecycle.ts` as-is** — provably non-functional in packaged builds; carries a raw env forwarding pattern (`ANTHROPIC_API_KEY` into child env) inferior to the in-process path. Rejected.

## References

- PLAN-012 — Tray-based server supervision (embedded host implementation of this decision).
- "Inbound Webhooks & Headless Server — Design Spec" (Notion, approved 2026-07-06) — embedded/standalone amendment; `onWebhookEvent` seam.
- LEARNING-011 — electron-builder collector OOM + mandatory staging (why packaging changes are the fragile surface).
- ADR-0001 (fork relationship), ADR-0005 (`~/.vorno-agent` config isolation), `roadmap/upstream/compatibility.md` (`craft-fork:*` namespace rule).
- PLAN-013 (standalone/headless host, VOR ticket "Headless server mode"); VOR-38/41/42 board tickets.
