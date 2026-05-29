# Wire / protocol compatibility commitments

Per [ADR-0001](../decisions/0001-fork-relationship-with-upstream.md), we commit to wire/protocol compatibility with upstream as long as feasible. This file lists the contracts we honor and how each direction respects them.

## Contracts we honor

| Contract | Source of truth | Compatibility commitment |
|----------|-----------------|---------------------------|
| `MessageEnvelope` | [`packages/shared/src/protocol/types.ts`](../../packages/shared/src/protocol/types.ts) | Wire-compatible. We add fields only via additive changes. |
| `AgentEvent` union | [`packages/core/src/types/message.ts`](../../packages/core/src/types/message.ts) | Wire-compatible. New event types must round-trip through upstream parsers (unknown types ignored, not errored). |
| RPC channel names (`sessions:*`, `messaging:*`, etc.) | `packages/shared/src/protocol/channels.ts` | We do not rename or remove existing channels. We may add new ones under our own namespace prefix (e.g., `craft-fork:*`) to avoid collisions. |
| Source schema (`config.json` + `guide.md`) | `packages/shared/src/sources/` | Fully compatible. Our additions are skill-side only. |
| Skill schema (`SKILL.md` frontmatter) | Convention | **Will extend additively** in [DIR-02](../directions/02-skill-contributions.md). New `contributes:` block is opt-in; existing skills behave unchanged. |
| API key format (`craft_sk_*`) | `apps/server/src/config.ts` | Owned by us; upstream doesn't have an equivalent. No conflict. |
| WebSocket close codes (4001–4005) | `apps/server/src/transport/ws-transport.ts` | We mirror upstream's `WsRpcServer` codes. |
| Binary encoding (`__craftRpcType: 'u8'`) | Shared codec | Uses the upstream codec verbatim. |

## Direction-specific notes

### Direction 1 (Canvas Session)

- **Renderer-only change.** No protocol modifications. Subscribes to existing `AgentEvent` stream.
- Per-session canvas layout sidecar (`session.canvas.json`) lives outside the protocol — local file, not synced via the wire.
- ✅ Fully compatible.

### Direction 2 (Skill Contributions)

- Adds a `contributes:` block to skill frontmatter — additive; old skills load unchanged.
- Custom tools registered by skills must obey the existing tool-call protocol (`tool_start`/`tool_result` events).
- New shape types are renderer-side; they don't appear on the wire.
- ✅ Fully compatible.

### Direction 3 (Observatory)

- New client of existing dual-transport server. Speaks `MessageEnvelope` 1.0.
- Subscribes to existing `sessions:event` channel via `pushToWorkspace` targeting.
- May add new RPC channels under `craft-fork:observatory:*` for layout sync — namespace-scoped, no collision with upstream.
- Automerge sync state is local to the Observatory, not on the wire.
- ✅ Fully compatible.

## When to break compatibility

A new ADR is required to break any of the above. Triggers that *might* warrant it:

- Upstream introduces a contract that's actively harmful to our directions.
- An external standard (e.g., MCP evolves to subsume part of our wire) supersedes the contract entirely.
- We discover the contract has a security flaw upstream hasn't fixed.

In all cases, the path is: open a draft ADR, propose a `craft-fork:*` namespace alternative, run them in parallel, deprecate the upstream contract on our side only after a transition window.

## Audit log

| Date | Audit | Outcome |
|------|-------|---------|
| 2026-04-28 | Post-v0.8.12 merge full audit | All contracts intact. Messaging gateway adds new channels we don't yet implement; no conflict. |
| 2026-05-17 | Post-v0.9.4 merge audit (PR #23) | All contracts intact. New `packages/shared/src/agent/core/rtk-{detector,rewrite}.ts` are local Bash-execution rewriters (not wire-side). `pre-tool-use.ts` modifications keep the original tool-call envelope unchanged (rewrite is opt-in, post-permission). No protocol additions to `channels.ts` / `routing.ts` / `dto.ts` that affect us — the channel adds in `routing.ts`/`channels.ts` are upstream's messaging-access set we already account for in DIR-03's namespace plan. Pi SDK 0.73.0 → 0.73.1 is a minor; Codex WS→SSE fallback is transport-internal and respects existing close codes. |
| 2026-05-25 | Post-v0.9.6 merge audit (PR #25) | All contracts intact. Notable items: (a) `source_activated` auto-retry moved from Electron renderer into `SessionManager.processEvent` with a 2 s content-match dedup window — any `SessionManager` client (including our `apps/server/` HTTP/SSE/WS surface) inherits this transparently. No wire change: retried `sendMessage` rides the existing channel; dedup is keyed on `{content, deadlineMs, committed}` per `ManagedSession`. Net positive for DIR-03 Observatory — one less behavior to port. (b) Non-OAuth API source credentials now flow through a getter (vault-lookup-per-call) in `packages/shared/src/sources/api-tools.ts`; no new channels, no envelope changes. (c) New `markdown-preview` inline preview block joins `html-preview`/`pdf-preview`/`image-preview` — renderer-only; relevant to DIR-01 Canvas Session shape mapping. (d) URL-safety: `DANGEROUS_SCHEMES` changed `Set` → `Map<scheme, reason>`; `OPEN_URL` RPC error responses now carry an explanatory reason string — additive, no envelope break. |
| 2026-05-28 | Post-v0.10.0 merge audit (PR #27) | All contracts intact, but this release introduces the **first server-invokes-client RPC pattern beyond `OPEN_URL`** and warrants close attention. Notable items: (a) **New WS capability `client:browser:invoke`** — server-core transport gains `hasClientCapability` / `findClientsWithCapability` for capability-aware routing; Electron `__browser:invoke` IPC dispatcher handles the server→client direction. Mirrors the existing `shell.openExternal` server→client pattern for `OPEN_URL`; uses the established envelope, no new channel namespace required. Additive at the wire level. **DIR-03 Observatory** must declare which capabilities it advertises if it ever wants to host browser sessions — defaults to none, so today's behavior is unchanged. (b) **DTO additive change** — `BrowserInstanceInfo.workspaceId?: string` (nullable, optional). Back-compat: `undefined` treated as `null`, which the renderer filter passes through as "visible to all workspaces" — old agents and old renderers tolerate missing values. No envelope break. (c) **7 new error codes** on the browser-invoke path: `BROWSER_NO_CAPABLE_CLIENT`, `CAPABILITY_UNAVAILABLE`, `CLIENT_DISCONNECTED`, `CLIENT_REQUEST_TIMEOUT`, `BROWSER_INSTANCE_NOT_OWNED`, `BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED`, `BROWSER_REMOTE_EVALUATE_BLOCKED`. Strings on `Error.code`, not numeric WS close codes (4001–4005 remain untouched). Pi runtime maps each to a friendly message. (d) **New local-only config knob** `allowRemoteEvaluate` (defaults false) gates `evaluate` over the bridge; `uploadFile` is unconditionally blocked over the bridge. Local-side only; doesn't ride the wire. (e) **Pi agent gating** — Pi now mirrors Claude's `getBrowserToolEnabled` and stops advertising `browser_tool` when the toggle is off. Behavior change for users who had it disabled on Claude but were getting it via Pi; not a protocol issue. (f) **Workspace-isolation visibility filter** lives entirely in the renderer (`filterInstancesForWorkspace`); server-side `STATE_CHANGED` reverts to `{ to: 'all' }` and `LIST` returns full results — earlier server-side attempt was wrong for remote-mirror workspaces (transport-level `workspaceId` is the LOCAL window's identity, not the remote server's). No envelope break. (g) **`source_test` basic-auth fix** — `testApiConnectionWithAuth` now parses JSON-shaped vault tokens and base64-encodes them, matching `buildHeaders()`. Local-side only; no contract change. |
