# Upstream HEAD

Snapshot of our most recent upstream sync.

## Current state

| Field | Value |
|-------|-------|
| Last merged upstream tag | `v0.10.0` |
| Last merged upstream commit | `215910da` |
| Merge PR | [#27](https://github.com/Swagatar-LLC/craft-agents-oss/pull/27) — merged 2026-05-27 |
| Merge commit on main | `8ca513a7` |
| Date synced | 2026-05-27 |

## Versions covered in last merge

- `v0.10.0` — **Remote `browser_tool` bridged into the user's local Electron browser** (`1d926c33`): agents running on a remote workspace (headless server, docker, WebUI) drive the user's local desktop `BrowserPaneManager` end-to-end via a new `client:browser:invoke` WS capability (advertised on handshake, server→client invocation, plain `Error` with `.code` preserved both directions). Transport gains `hasClientCapability` / `findClientsWithCapability` for routing; Electron gets a new `__browser:invoke` IPC dispatcher with per-method owner-key authorization, no-manual-window-reuse for remote callers, session-scoped `listInstances`, and screenshot `Buffer`↔`Uint8Array` conversion. `server-core` gets a `RemoteBrowserPaneManager` and `SessionManager.getBrowserPaneManagerForSession` with capability-aware host-client fallback and per-session pin cleanup on disconnect. `uploadFile` is blocked over the bridge; `evaluate` is gated by a local `allowRemoteEvaluate` setting. Pi runtime learns friendly error mappings for `BROWSER_NO_CAPABLE_CLIENT`, `CAPABILITY_UNAVAILABLE`, `CLIENT_DISCONNECTED`, `CLIENT_REQUEST_TIMEOUT`, `BROWSER_INSTANCE_NOT_OWNED`, `BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED`, `BROWSER_REMOTE_EVALUATE_BLOCKED`, and now mirrors Claude's `getBrowserToolEnabled` gate. **Browser tabs isolated per workspace** (`af817192`): every `BrowserInstance` and the `BrowserInstanceInfo` DTO carry a nullable `workspaceId`; renderer reads `browserInstancesForWorkspaceAtomFamily` keyed by `activeWorkspaceId` (intra-release the filter was server-side, then reverted to renderer-side in `f831bb42` to fix remote-mirror workspaces — final shape: `STATE_CHANGED` broadcasts `{to:'all'}` and `LIST` returns the full set; visibility filter lives in `filterInstancesForWorkspace(local, remote)`). **`source_test` base64-encodes basic-auth credentials** (`96dd7c0d`, fixes #824) — validator path now matches `buildHeaders` JSON-parse + base64 behavior. Also: `markdown-preview` reference docs entry; three new `sessionLog.info` lines around `setRpcServer` / browser-pane-forwarding for diagnosability; remote-bridge lifecycle hardening (`ce3340a1`, `ceb24603`, `7dfcaeac`) so windows can't be hijacked across workspaces; `toSnapshot(instance)` projection before IPC return (`8e2534b5`) to avoid Electron structured-clone failures.

(Single upstream commit, clean merge — no conflicts.)

## Versions covered in prior merge (PR #25, 2026-05-25)

- `v0.9.6` — Multi-window state preservation across auto-update (electron-updater was clobbering `~/.craft-agent/window-state.json` with `{windows:[]}` because Squirrel.Mac destroys BrowserWindows before `before-quit`); workspace name in window title when multi-window; mid-session credential refresh for non-OAuth API sources (bearer/header/query/basic) via vault-lookup-per-call instead of capture-at-tool-creation; stale `source_apikey` cleanup when flipping authType→`none`; blocked URL schemes now explain *why* and DOM `href` is sanitized via `defaultUrlTransform` (closes middle-click escape route through `setWindowOpenHandler` / `will-navigate`) — fixes #807 URL handling; new inline `markdown-preview` code-block (mirrors `html-preview`/`pdf-preview`/`image-preview`); `cache_control` 1h TTL ordering fix (`tools` now walked before `system`/`messages` in `upgradePromptCacheTtl`) + dropped over-broad "tool not supported" 400 classifier; mobile WebUI send-button stays visible with long model names (#798); **headless server `source_activated` auto-retry moved into `SessionManager.processEvent` with 2 s content-match dedup window** (#804) — the Electron renderer's `auto_retry` effect is removed and headless deployments (WebUI, docker server) now chain source activations the same way; PR-378 review hardening follow-ups.

Post-merge polish: `apps/electron/src/renderer/components/fork-badge.tsx` — dropped the top-right pill (was occluding the window close button); kept the 2px rust-orange accent stripe under the title bar (`1c9fd5d3`).

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
- `packages/shared/src/agent/options.ts` — historically conflicted with our `CLAUDECODE` env strip; now upstream-aligned via `buildClaudeSubprocessEnv()`. Re-check on each merge.

## Recurring post-sync issues

- **Stale nested `@mariozechner/*` deps** — see [LEARNING-001](../learnings/LEARNING-001-stale-nested-mariozechner-deps.md). **Did not trigger this cycle.** Pi SDK 0.73.0 → 0.73.1 was a minor bump and `pi-agent-server` bundled cleanly without the nested-modules nuke. The mitigation may now be unnecessary for minor Pi bumps; revisit when a major bump lands.
- **CI runner `~/.craft-agent/` dir absent** — surfaced once, fixed in `349512e` (see Post-merge fix above). Should not recur.

## CI threshold notes

- `validate-pr.yml` shared-test thresholds last bumped to `2600 pass / 20 fail` to absorb upstream's i18n-parity additions and test growth. Revisit on the next major test addition.
