# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Claude Opus 4.6 is selectable again** — it reappears in the model pickers for direct Anthropic connections, Amazon Bedrock, and Pi-backed catalogs. Connections that were force-migrated from Opus 4.6 to Opus 4.8 get 4.6 re-added automatically (one-shot: your default model is untouched, and removing it again sticks). Opus 4.8 remains the default for new installs (from upstream)
- New `archive_session` session tool — agents can archive (or unarchive) another session in the workspace by ID to tidy up finished or superseded sessions. Archiving only hides the session from the active list and unread counts, never deletes it; a session cannot archive itself, and archiving is refused while the target is mid-turn (from upstream)

## Improvements

- **Claude Agent SDK uplifted to 0.3.220** (from 0.3.197) — Claude Code v2.1.220 parity. Fixes an abort-listener leak in streaming queries, adds CLI stderr to process-exit errors, reports correct HTTP status for rate-limit errors, and supports session resume with dash-leading IDs (from upstream)
- Subagent nesting depth is unchanged at 5. Upstream tightened its cap this release, but Vorno pins the previous limit so agents can keep spawning nested agents as before; set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to override
- If installing a downloaded update fails at the final handoff, the app now restarts cleanly instead of continuing in a half-shut-down state where later work could be lost (from upstream)

## Bug Fixes

- macOS auto-update installs again — updates no longer end up downloaded-but-never-installed because quit cleanup interrupted the installer handoff (from upstream)
- The chat input no longer force-capitalizes the first letter, which broke pinyin and other CJK IME composition (from upstream)
- Local file links whose paths contain spaces (`%20`) open correctly again from chat messages (from upstream)
- New sessions no longer inherit an excluded filter — a lone "exclude Done" filter used to create new sessions as Done; only include-mode filters are inherited now (from upstream)
- Custom OpenAI-compatible endpoints validate again: relays that send an empty `tool_calls: []` field no longer break stream completion (from upstream)
- Re-authenticating a ChatGPT or GitHub Copilot connection now refreshes its model list, so entitlement changes show up without a restart (from upstream)
- MCP tools with dots in their names (e.g. `pat.batch_plan`) work on OpenAI/Codex-backed connections (from upstream)
- Windows: image previews no longer fail by doubling the workspace path in front of absolute `C:\` paths (from upstream)
- Windows: a `gitBashPath` configured in `config.json` is honored by the agent's Bash tool, fixing "No bash shell found" for per-user Git installs (from upstream)
- Explore mode no longer goes silent when a tool call is blocked — since the SDK 0.3.220 uplift the first blocked tool ended the turn before the agent could respond. The agent sees the block reason again and can suggest switching modes or submit a plan instead of stopping without a word (from upstream)
- A stale server lock whose process ID was recycled by the OS no longer prevents the app from starting — the lock now records which executable wrote it, and startup verifies the live process actually matches (from upstream)

## Breaking Changes
