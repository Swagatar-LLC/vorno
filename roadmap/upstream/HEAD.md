# Upstream HEAD

Snapshot of our most recent upstream sync.

## Current state

| Field | Value |
|-------|-------|
| Last merged upstream tag | `v0.9.4` |
| Last merged upstream commit | `4144f79` |
| Merge PR | [#23](https://github.com/Swagatar-LLC/craft-agents-oss/pull/23) — merged 2026-05-17 |
| Merge commit on main | `c1d1302` |
| Date synced | 2026-05-17 |

## Versions covered in last merge

- `v0.9.4` — Optional RTK Bash token compression (Settings → AI → Performance) with detection of missing/outdated installs and saved-token telemetry; Pi SDK `0.73.1` lifts Codex WS→SSE fallback + cached-WS shutdown cleanup (fixes upstream #747 — `1011` keepalive / `1006` disconnect / cert failures on long-running ChatGPT Plus / Codex OAuth sessions); compact session-menu now uses vaul drawer with iOS-style drill-in panes for Status/Labels/Share/Messaging (was clipping inside Radix dropdowns); race-safe label toggling via new `useSessionMenuActions` hook (optimistic compounding, Strict-Mode double-fire fix); Skills "Show in Finder" uses authoritative `skill.path` + platform-aware error toast (upstream #756); backend packaging cleanup removing stale Copilot/Codex remnants after the Pi consolidation.

(Two upstream commits behind on entry — `v0.9.3` + `v0.9.4`. `v0.9.3` content had already landed via PR #21's squash merge, so git only surfaced the additive `v0.9.4` content plus the version-bump conflicts. **Conflicts resolved:** `bun.lock` `--theirs` + `bun install` (skill-standard); 15× `package.json` version bumps `0.9.3 → 0.9.4` `--theirs`; `apps/electron/src/renderer/index.html` `--ours` (preserve "Craft Agents (Swagatar Fork)" title). No conflict in `packages/shared/src/agent/options.ts` — `buildClaudeSubprocessEnv()` continues to carry our `CLAUDECODE` strip cleanly.)

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
