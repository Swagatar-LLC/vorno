# Upstream HEAD

Snapshot of our most recent upstream sync.

## Current state

| Field | Value |
|-------|-------|
| Last merged upstream tag | `v0.9.5` |
| Last merged upstream commit | `96454c27` |
| Merge PR | [#24](https://github.com/Swagatar-LLC/craft-agents-oss/pull/24) — merged 2026-05-20 |
| Merge commit on main | `a56cb4cf` |
| Date synced | 2026-05-20 |

## Versions covered in last merge

- `v0.9.5` — Compact-mode UX polish across session-row menu, working-directory selector, AcceptPlan picker, expandable chat input, and webUI compact model selector (all now drawer-based on narrow widths); shared `useWorkingDirectoryState` hook prevents desktop/compact drift; branching on the latest turn no longer drops the last assistant message (#782); stdio MCP `source_test` surfaces real startup diagnostics instead of fake timeouts (#787); parallel `source_test` calls no longer wedge a session via orphaned `tool_use` IDs (#790); chat view and messaging gateway `progress`/`final_only` modes both fall back to most-recent assistant text when a turn ends on a tool call without a non-intermediate `text_complete` (#779) — no more permanent "Thinking…"/silent runs; SDK Agent subagent activity groups collapsible again.

(Single upstream commit, clean merge — no conflicts.)

## Post-merge fix

- **`apps/server/src/config.ts` — `saveServerConfig()` now `mkdir -p`s the parent dir before write.** Pre-existing bug in fork-only code that surfaced deterministically in CI on this branch (`ENOENT: '/home/runner/.craft-agent/server-config.json'` in `tests/unit/auth.test.ts`). Unrelated to upstream v0.9.4. Committed as `349512e`.

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
