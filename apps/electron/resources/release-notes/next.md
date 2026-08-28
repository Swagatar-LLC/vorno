# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Moonshot AI (Kimi K3) support** (from upstream v0.12.1) — connection presets for Moonshot AI (global and CN endpoints) with the full Kimi model family. Kimi K3 brings a 1M-token context window, always-on reasoning, and image input; Kimi K2.6 serves as the fast summarization model. The existing Kimi (Coding) preset gains `k3` as well.
- **Pi SDK updated to 0.81.1** (from upstream v0.12.1) — refreshed model catalogs across all Pi-backed providers, including Kimi K3 thinking-format and reasoning-effort fixes.
- **Headroom context management, per workspace.** Workspace settings gain a Headroom section with a master switch, compression engine preferences, verbosity steering, and a statistics toggle. Settings inherit from instance defaults unless the workspace overrides them, and each value shows which of the two it came from. Off by default.
- **View the original behind any compressed tool output.** Compressed turns carry a badge showing what was saved; clicking it retrieves and displays the original content. When retrieval is not possible, the reason is stated plainly — Headroom off, service unreachable, or the content no longer held — rather than failing silently.
- **A Headroom savings report.** A new report shows tokens before and after, tokens saved, items compressed, and originals retrieved, scoped to either the current session or the whole workspace. Every figure is measured and read from Headroom itself; anything Headroom does not report is shown as unknown rather than estimated or interpolated.

## Improvements

- ChatGPT web search failover is sturdier (from upstream v0.12.1): model candidates are bounded, hosted-tool refusals are no longer mistaken for model rejections, and multi-attempt error messages stay readable.
- GitHub Copilot sign-in re-enables policy-gated models (Claude, Grok, and others) from your account's live model listing, and the Copilot OAuth flows are now app-owned and hardened with network timeouts and standards-compliant polling (from upstream v0.12.1).
- Faster utility-model calls (from upstream v0.12.1): the Pi model runtime is cached across summarization and title-generation requests instead of being rebuilt each time.
- Settings now show proper provider labels for Minimax, Minimax (CN), and Kimi (Coding) connections instead of a generic backend label (from upstream v0.12.1).
- Kimi (Coding) connections pre-fill the current model lineup — `k3`, `kimi-for-coding`, `kimi-for-coding-highspeed` (from upstream v0.12.1).
- Google OAuth setup docs now say to create a **Web application** client with `https://thecraftagents.com/auth/callback` as an authorized redirect URI, matching the relay redirect URI Vorno actually uses (ADR-0025). The old "Desktop app" guidance failed with `redirect_uri_mismatch` (from upstream v0.12.1).

## Bug Fixes

- ChatGPT web search works again for ChatGPT-account connections (from upstream v0.12.1) — the search request no longer pins a retired model id and follows your active model instead.
- Custom OpenAI-compatible endpoints no longer receive the unsupported `store` parameter, which broke strict providers (from upstream v0.12.1).
- WhatsApp: messages on LID-migrated accounts now resolve your own identity correctly, so self-sent messages and mentions behave again (from upstream v0.12.1).

## Breaking Changes
