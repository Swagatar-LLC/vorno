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
| 2026-06-03 | Post-v0.10.1 merge audit (this PR) | All wire contracts intact. (a) **`update_user_preferences` MCP tool surface change** — `language` removed from the accepted arg set; replaced by internal `uiLanguage` driven by Settings → Appearance. Source-of-truth: `packages/session-tools-core/src/tool-defs.ts` + `handlers/update-preferences.ts`. Tool surface contract is shrunk, not grown — any caller that passes `language` will now have it silently dropped. Confirmed our fork-side skills/automations do not currently pass `language`, so the contraction is a no-op for us today. (b) **Preferences schema migration** — legacy free-text `language` in `preferences.json` is scrubbed on read (passthrough schema tolerates existing configs). Local file format, not on the wire. (c) **Models registry** — Opus 4.6 removed from pickers; `normalizeDeprecatedModelId` migrates `claude-opus-4-6` → `claude-opus-4-8` and preserves `claude-opus-4-7`. New `BEDROCK_TO_BARE` entries for Opus 4.8. No envelope break. (d) **Our fork-only delta retained:** `claude-opus-4-8` carries `supportsFastMode: true` and `getModelSupportsFastMode` survived the merge — both required by in-flight Stages 2–4 fast-mode-toggle work. Registry-shape delta from upstream; flagged here so future audits notice if it widens. (e) **`uiLanguage` storage migration** lives in `packages/shared/src/config/storage.ts` — local-only, not on the wire. No protocol/channel changes in this release. |
| 2026-05-28 | Post-v0.10.0 merge audit (PR #27) | All contracts intact, but this release introduces the **first server-invokes-client RPC pattern beyond `OPEN_URL`** and warrants close attention. Notable items: (a) **New WS capability `client:browser:invoke`** — server-core transport gains `hasClientCapability` / `findClientsWithCapability` for capability-aware routing; Electron `__browser:invoke` IPC dispatcher handles the server→client direction. Mirrors the existing `shell.openExternal` server→client pattern for `OPEN_URL`; uses the established envelope, no new channel namespace required. Additive at the wire level. **DIR-03 Observatory** must declare which capabilities it advertises if it ever wants to host browser sessions — defaults to none, so today's behavior is unchanged. (b) **DTO additive change** — `BrowserInstanceInfo.workspaceId?: string` (nullable, optional). Back-compat: `undefined` treated as `null`, which the renderer filter passes through as "visible to all workspaces" — old agents and old renderers tolerate missing values. No envelope break. (c) **7 new error codes** on the browser-invoke path: `BROWSER_NO_CAPABLE_CLIENT`, `CAPABILITY_UNAVAILABLE`, `CLIENT_DISCONNECTED`, `CLIENT_REQUEST_TIMEOUT`, `BROWSER_INSTANCE_NOT_OWNED`, `BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED`, `BROWSER_REMOTE_EVALUATE_BLOCKED`. Strings on `Error.code`, not numeric WS close codes (4001–4005 remain untouched). Pi runtime maps each to a friendly message. (d) **New local-only config knob** `allowRemoteEvaluate` (defaults false) gates `evaluate` over the bridge; `uploadFile` is unconditionally blocked over the bridge. Local-side only; doesn't ride the wire. (e) **Pi agent gating** — Pi now mirrors Claude's `getBrowserToolEnabled` and stops advertising `browser_tool` when the toggle is off. Behavior change for users who had it disabled on Claude but were getting it via Pi; not a protocol issue. (f) **Workspace-isolation visibility filter** lives entirely in the renderer (`filterInstancesForWorkspace`); server-side `STATE_CHANGED` reverts to `{ to: 'all' }` and `LIST` returns full results — earlier server-side attempt was wrong for remote-mirror workspaces (transport-level `workspaceId` is the LOCAL window's identity, not the remote server's). No envelope break. (g) **`source_test` basic-auth fix** — `testApiConnectionWithAuth` now parses JSON-shaped vault tokens and base64-encodes them, matching `buildHeaders()`. Local-side only; no contract change. |
| 2026-06-24 | Post-v0.10.4 merge audit (PR #39) | All wire contracts intact — **no changes under `packages/shared/src/protocol/`; no channel, DTO, or envelope changes.** Notable items: (a) **Pi SDK scope migration `@mariozechner/*`@0.73.1 → `@earendil-works/*`@0.79.9** across all manifests + `bun.lock`. This is a dependency/packaging change, not a wire change — the Pi runtime's tool-call protocol (`tool_start`/`tool_result`) is unchanged. LEARNING-001 did **not** reproduce (old scope removed wholesale by `bun install`; `pi-agent-server` bundles clean). Fork-side recipe references updated to the new scope (commit `2f521d08`). (b) **models.dev catalog regenerated** by the SDK uplift — GLM-5.2/5.1/5-turbo and newer OpenRouter models appear automatically; registry-shape change only, no envelope impact. **Fork-only delta re-verified intact:** `claude-opus-4-8` still carries `supportsFastMode: true` and `getModelSupportsFastMode()` survives (`packages/shared/src/config/models.ts:147,337`) — the regeneration did not clobber it; in-flight fast-mode-toggle work remains unblocked. Continue flagging until it widens. (c) **`config.json` startup backups** (newest-3, same-day-safe) — local file lifecycle, not on the wire. (d) **Auto-update diagnostic log** at `~/.craft-agent/logs/auto-update.log` — local-only. (e) **Language-aware session titles** read Appearance → Language from disk — local config read, no protocol surface. No `update_user_preferences` tool-surface change this cycle (the `language`→`uiLanguage` contraction landed in v0.10.1). |
