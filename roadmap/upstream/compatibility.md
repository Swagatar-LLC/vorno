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
| 2026-05-27 | Post-v0.10.0 merge audit (PR #27) | All existing contracts intact; **largest wire-surface change since we started tracking** and the first server→client RPC capability beyond `shell.openExternal` / `OPEN_URL`. Notable items: (a) **New WS client capability `client:browser:invoke`** — advertised on handshake, server invokes client via `findClientsWithCapability`. Plain `Error` with `.code` is preserved both directions; no `MessageEnvelope` schema change; channel-name commitments hold. Forward-look for DIR-03 Observatory: this is the pattern any future Observatory→client invocation should follow (capability advertisement + per-method authz + structured error codes) — worth referencing when DIR-03 designs its layout-sync surface. (b) **`BrowserInstanceInfo` DTO gains nullable `workspaceId`** — additive, upstream ships it optional so older renderers/agents treat `undefined` as `null` (passes filter, equivalent to pre-0.10.0 broadcast behavior). DIR-01 Canvas Session shape consumers should note the new field but no migration needed. (c) **`STATE_CHANGED` routing semantics churned within the release** (`{to:'workspace', workspaceId}` filter added in `af817192`, reverted to `{to:'all'}` in `f831bb42` after remote-mirror workspaces broke). Final shape matches pre-0.10.0 broadcast behavior; visibility filter lives in renderer (`filterInstancesForWorkspace(local, remote)`). No net contract change. (d) **`RemoteBrowserPaneManager` in `server-core`** + `SessionManager.getBrowserPaneManagerForSession` with capability-aware host-client fallback — relevant to our headless `apps/server` story: any `apps/server`-hosted session whose connected client advertises `client:browser:invoke` can now drive that client's browser. We do not yet emit the capability ourselves; revisit if/when we add an SDK-side browser surface. (e) Remote-bridge lifecycle hardening (`ce3340a1`, `ceb24603`, `7dfcaeac`) — all internal; closes cross-workspace window hijack but does not alter the wire. (f) Pi runtime new error mappings (`BROWSER_NO_CAPABLE_CLIENT`, `CAPABILITY_UNAVAILABLE`, `CLIENT_DISCONNECTED`, `CLIENT_REQUEST_TIMEOUT`, `BROWSER_INSTANCE_NOT_OWNED`, `BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED`, `BROWSER_REMOTE_EVALUATE_BLOCKED`) — additive `.code` strings; consumers that switch on these must add cases but old consumers don't error. (g) `source_test` basic-auth fix (#824) — bug fix, validator path now matches the runtime `buildHeaders` JSON-parse + base64 behavior; no contract change. **No breaking changes; no ADR required.** |
