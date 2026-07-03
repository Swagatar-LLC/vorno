# Upstream HEAD

Snapshot of our most recent upstream sync.

## Current state

| Field | Value |
|-------|-------|
| Last merged upstream tag | `v0.10.5` |
| Last merged upstream commit | `c9d9a26f` |
| Merge PR | [#44](https://github.com/Swagatar-LLC/craft-agents-oss/pull/44) |
| Merge commit on main | `bba36699` |
| Date synced | 2026-07-03 |

## Versions covered in last merge

- `v0.10.5` — **Claude Sonnet 5 + Agent SDK 0.3.197.** `claude-sonnet-5` (released 2026-06-30) added to the model picker with a 1M-token context window and adaptive thinking; Sonnet 4.6 retained as previous generation; Bedrock US/EU/Global inference-profile routing and connection defaults wired. Default model unchanged (Opus 4.8). Claude Agent SDK uplifted `0.3.170` → `0.3.197` (Claude Code 2.1.197 parity — the bundled CLI is itself Sonnet 5-aware; includes a Windows CLI subprocess console-flash fix). No upstream breaking changes. **Conflicts:** `bun.lock` (mechanical `--theirs` + `bun install`) and `packages/shared/tests/models.test.ts` (both-added: kept our fork-only `Opus 4.8 registry presence` / fast-mode block alongside upstream's new `Sonnet registry` block). **Fork-side follow-up (same PR, commit `56bb5dd6`):** Claude Code 2.1.197 launches Task subagents **async by default** behind the remote `tengu_amber_heron` GrowthBook gate — the LEARNING-008 failure mode. `buildClaudeSubprocessEnv()` now pins `DISABLE_GROWTHBOOK=1` (gates resolve to compiled-in defaults ⇒ blocking-by-default restored, explicit `run_in_background` preserved, no remote-config influence over spawned-CLI behavior); new `logSdkCliVersion()` logs the spawned CLI version at agent creation and loudly on mid-process change (drift signature); `upstream-sync` skill now re-verifies subagent-launch gating on every SDK bump; regression test `claude-subprocess-env.test.ts` locks the env contract.

## Versions covered in prior merge (PR #39, 2026-06-24)

- `v0.10.4` — **GLM-5 family on z.ai + Pi SDK uplift.** Pi SDK uplifted `0.73.1` → `0.79.9` with a scope migration from the now-frozen `@mariozechner/*` to the rebranded `@earendil-works/*` across all manifests + `bun.lock` (`pi-ai`, `pi-coding-agent`, `pi-agent-core`). The regenerated models.dev catalog surfaces GLM-5.2 / 5.1 / 5-turbo automatically on the existing z.ai provider with correct thinking / `reasoning_effort` handling, plus newer models for OpenRouter and other Pi providers. GitHub Copilot device-code login now consumes the SDK's structured `onDeviceCode` callback in place of a free-text regex. **Automatic `config.json` startup backups** (keeps newest 3; earliest good same-day snapshot preserved). **Always-on auto-update diagnostic log** at `~/.craft-agent/logs/auto-update.log` (partially addresses #891 — diagnostics only). **Session titles honour your language** by reading Appearance → Language from disk, auto-detecting written language when unset (fixes #885). No upstream breaking changes. **Conflicts:** `bun.lock` only (mechanical `--theirs` + `bun install`); `options.ts` did not conflict and the `CLAUDECODE` strip is preserved. **Fork-side follow-up (same branch):** stale `@mariozechner` scope refs in `LEARNING-001` and the `upstream-sync` skill recipes updated to `@earendil-works` (commit `2f521d08`). Fork-only `supportsFastMode: true` / `getModelSupportsFastMode()` registry delta verified intact after the models.dev regeneration.

## Versions covered in prior merge (PR #37, 2026-06-10)

- `v0.10.3` — **Claude Fable 5** (Anthropic GA 2026-06-09) added on the Claude Agent SDK path with a full 1M-token context window, across direct Anthropic connections and AWS Bedrock (us/eu/global inference-profile variants), description localized in all 7 languages. **Opus 4.8 remains the default** — Fable is offered alongside it, and added to the Pi → Anthropic auth-bridge preferences below Opus. Fable 5 (and the Mythos 5 class) run with adaptive thinking always on and reject an explicit `disabled` thinking option, so the thinking resolver now maps "off"/minimize-thinking to **low-effort adaptive thinking** for these models via new `isAdaptiveThinkingAlwaysOnModel()`; Opus/Sonnet/Haiku behavior is byte-for-byte unchanged. **Claude Agent SDK 0.3.154 → 0.3.170** (root + core/shared peers; no API breakage, full typecheck clean).
- `v0.10.2` — **Link label value type** — labels can carry a `link` value (clickable chip, opens externally) alongside string/number/date; threaded through the zod schema, `labels/types.ts` (`valueType` union widened), CLI, and agent-prompt layers; our `set_session_labels` error string updated to mention `link`. **Resolved Anthropic account & org per OAuth connection** — Settings → LLM Connections shows the real identity each Claude OAuth grant resolves to (new `ClaudeOAuthIdentityDto` in `protocol/dto.ts`, threaded through `LlmConnectionSetup`/`ClaudeOAuthResult`), with an amber shared-quota warning when two connections resolve to the same account; also fixes a load-bearing `updateLlmConnection` allowlist-drop bug (#838). **Last sent message restored to the input on Stop** (append-safe). **Pi prompt-cache fix** — `PromptBuilder.buildContextParts` split into `buildVolatileContextParts` + `buildStableContextParts`; the Pi cached prefix keeps only stable blocks so `cacheRead` no longer drops to 0 every turn (#862). Claude path stays byte-identical. **Accept-Plan chevron rotation fix** (#840). Conflicts: `bun.lock` (mechanical) and `claude-agent.ts` (import-union of our `getModelSupportsFastMode` with upstream's `isAdaptiveThinkingAlwaysOnModel`).

## Versions covered in prior merge (PR #30, 2026-06-03)

- `v0.10.1` — **Claude Opus 4.8 promoted to default Opus** (Claude Agent SDK 0.3.154). Opus 4.7 stays selectable; Opus 4.6 removed from pickers; existing 4.7 defaults migrate to 4.8 and 4.5/4.6 selections migrate forward. Bedrock mappings, Pi fallback, model-migration tests, docs, UI examples all updated. **Session titles honour Settings → Appearance language** — fixes main-process i18n that was sitting at `en` fallback after restart because Node has no `localStorage` to detect from; renderer now persists chosen language to an internal validated `uiLanguage` field and main hydrates from it on startup (partially closes upstream #815, #738). **Text-selection highlight stays aligned when scrolling a `markdown-preview` block** — capture-phase scroll listener recomputes overlay geometry (rAF-coalesced, no-op short-circuit when no annotations), mirrored in viewer annotation path. **Breaking — macOS Intel (x64) builds discontinued, Apple Silicon only** (v0.10.0 was the last Intel build). **Breaking — legacy free-text `language` field in `preferences.json` replaced by internal validated `uiLanguage`**; schema is passthrough so existing configs are tolerated and stale `language` keys are scrubbed on read; `update_user_preferences` tool no longer accepts `language`.

## Versions covered in prior merge (PR #27, 2026-05-28)

- `v0.10.0` — **Remote `browser_tool` bridged into the user's local Electron browser** via new `client:browser:invoke` WS capability (server-invokes-client RPC, mirroring `shell.openExternal` for `OPEN_URL`); transport gains `hasClientCapability` / `findClientsWithCapability`; Electron adds `__browser:invoke` IPC dispatcher with per-method owner-key authorization, no-manual-window-reuse for remote callers, session-scoped `listInstances`, and screenshot `Buffer`↔`Uint8Array` conversion across the wire. New `RemoteBrowserPaneManager` (session-bound `IBPM` impl) in `server-core` with capability-aware host-client fallback. `uploadFile` blocked over bridge; `evaluate` gated by new local `allowRemoteEvaluate` setting. Pi runtime learns friendly mappings for 7 new error codes and now mirrors Claude's `getBrowserToolEnabled` gate. **Per-workspace browser-tab isolation:** every `BrowserInstance` (and `BrowserInstanceInfo` DTO) carries a nullable `workspaceId`; `STATE_CHANGED` broadcasts to all, renderer filters via `filterInstancesForWorkspace(local, remote)` (handles both local Craft window id and remote-server workspace id for remote-mirror workspaces). TopBar-opened `CREATE` inherits `ctx.workspaceId`; unbound-window reuse scoped to owning workspace (closes cross-workspace hijack); `BrowserInstance` projected to plain snapshot before IPC return (fixes structured-clone failure on Electron native refs). **`source_test` base64-encodes basic-auth credentials** (fixes #824 — was sending raw JSON in `Authorization: Basic` header and 401'ing every basic-auth provider).

(Single upstream commit. Non-trivial conflicts in `packages/shared/src/config/models.ts`, `packages/shared/src/config/llm-connections.ts`, `packages/shared/tests/models.test.ts`, and `bun.lock` — all intersected with the in-flight Opus 4.8 / fast-mode work landed earlier this week. See PR for resolution notes.)

## Versions covered in prior merge (PR #25, 2026-05-25)

- `v0.9.6` — Multi-window state preservation across auto-update (electron-updater was clobbering `~/.craft-agent/window-state.json` with `{windows:[]}` because Squirrel.Mac destroys BrowserWindows before `before-quit`); workspace name in window title when multi-window; mid-session credential refresh for non-OAuth API sources (bearer/header/query/basic) via vault-lookup-per-call instead of capture-at-tool-creation; stale `source_apikey` cleanup when flipping authType→`none`; blocked URL schemes now explain *why* and DOM `href` is sanitized via `defaultUrlTransform` (closes middle-click escape route through `setWindowOpenHandler` / `will-navigate`) — fixes #807 URL handling; new inline `markdown-preview` code-block (mirrors `html-preview`/`pdf-preview`/`image-preview`); `cache_control` 1h TTL ordering fix (`tools` now walked before `system`/`messages` in `upgradePromptCacheTtl`) + dropped over-broad "tool not supported" 400 classifier; mobile WebUI send-button stays visible with long model names (#798); **headless server `source_activated` auto-retry moved into `SessionManager.processEvent` with 2 s content-match dedup window** (#804) — the Electron renderer's `auto_retry` effect is removed and headless deployments (WebUI, docker server) now chain source activations the same way; PR-378 review hardening follow-ups. **Post-merge polish:** dropped fork-badge top-right pill (was occluding window close button); kept 2px rust-orange accent stripe under title bar (`1c9fd5d3`).

## Versions covered in prior merge (PR #24, 2026-05-20)

- `v0.9.5` — Compact-mode drawer treatment for session-row menu, working-directory selector, AcceptPlan picker, expandable chat input, and webUI mobile model selector; shared `useWorkingDirectoryState` hook to prevent desktop/compact drift; branching on the latest turn no longer drops the last assistant message (#782); stdio MCP `source_test` real diagnostics instead of fake timeouts (#787); parallel `source_test` no longer wedges sessions via orphaned `tool_use` IDs (#790); chat view and messaging gateway `progress`/`final_only` both fall back to most-recent assistant text when a turn ends on a tool call without a non-intermediate `text_complete` (#779); SDK Agent subagent activity groups collapsible again.

## Versions covered in prior merge (PR #23, 2026-05-17)

- `v0.9.4` — Optional RTK Bash token compression (Settings → AI → Performance) with detection of missing/outdated installs and saved-token telemetry; Pi SDK `0.73.1` lifts Codex WS→SSE fallback + cached-WS shutdown cleanup (fixes upstream #747 — `1011` keepalive / `1006` disconnect / cert failures on long-running ChatGPT Plus / Codex OAuth sessions); compact session-menu vaul drawer with iOS-style drill-in panes; race-safe label toggling via `useSessionMenuActions`; Skills "Show in Finder" uses authoritative `skill.path` + platform-aware error toast (upstream #756); backend packaging cleanup after Pi consolidation. **Post-merge fix:** `apps/server/src/config.ts` — `saveServerConfig()` now `mkdir -p`s the parent dir before write (committed as `349512e`); CI runner `~/.craft-agent/` dir absent had been a pre-existing bug in fork-only code.

## Versions covered in prior merge (PR #21, 2026-05-12)

- `v0.9.3` — Mobile/compact UI rework, Manifest provider preset, oversized-tool-result poisoning fix, Telegram polling auto-reconnect, WhatsApp audio attachments, `source_test` OAuth forwarding, GHCR/workflow namespace migration `lukilabs` → `craft-ai-agents`, repo-wide `lint:i18n:strings` scan, settings-icons cleanup.

## Versions covered in PR #8 (2026-05-07)

- `v0.8.13`, `v0.9.0`, `v0.9.1`, `v0.9.2`

## Versions covered in PR #4 (2026-04-28)

- `v0.8.10` — Messaging Gateway (Telegram, WhatsApp), `WsRpcClient` in server-core, messaging RPC channels
- `v0.8.11` — Chat follow-ups extracted, LLM partial output handling, WhatsApp filter improvements
- `v0.8.12` — Pi agent restructuring, session drafts, URL safety, diff normalization, DeepSeek provider

## Standard conflicts seen

- `bun.lock` — resolved with `git checkout --theirs bun.lock && bun install`. Mechanical.
- `package.json` version-bump cluster (root + each app + each package) — resolved with `--theirs` to adopt upstream version stamp. Mechanical, will recur on every minor release.
- `apps/electron/src/renderer/index.html` — fork title vs. upstream title; resolve `--ours` each cycle.
- `packages/shared/src/agent/options.ts` — historically conflicted with our `CLAUDECODE` env strip; now upstream-aligned via `buildClaudeSubprocessEnv()` (which also carries our fork-only `DISABLE_GROWTHBOOK=1` pin since v0.10.5). Re-check on each merge.
- `packages/shared/tests/models.test.ts` — both-added conflicts when the fork and upstream each append model-registry test blocks (seen v0.10.5: our fast-mode block vs upstream's Sonnet 5 block). Resolution: keep both blocks.

## Recurring post-sync issues

- **Stale nested `@mariozechner/*` deps** — see [LEARNING-001](../learnings/LEARNING-001-stale-nested-mariozechner-deps.md). **Did not trigger in v0.10.4** despite the major `0.73.1` → `0.79.9` bump, because upstream simultaneously **renamed the scope to `@earendil-works/*`** — `bun install` removed the old `@mariozechner` packages entirely, so there were no stale nested copies to collide. `pi-agent-server` bundled cleanly. The LEARNING-001 fix recipe and the `upstream-sync` skill were updated this cycle to target the new scope (commit `2f521d08`). The original `@mariozechner` hazard is now historically frozen; future stale-dep risk would be under `@earendil-works`.
- **CI runner `~/.craft-agent/` dir absent** — surfaced once, fixed in `349512e` (see Post-merge fix above). Should not recur.

## CI threshold notes

- `validate-pr.yml` shared-test thresholds last bumped to `2600 pass / 20 fail` to absorb upstream's i18n-parity additions and test growth. Revisit on the next major test addition.
