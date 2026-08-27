# Bundled Resources

This folder contains assets that are bundled with the Electron app and synced to the user's `~/.craft-agent/` directory on every launch.

## How It Works

1. **Build time**: `scripts/copy-assets.ts` copies this folder to `dist/resources/`
2. **Package time**: electron-builder includes `dist/resources/` in the app bundle
3. **Runtime**: `getBundledAssetsDir()` resolves paths to these bundled assets
4. **Launch**: Each asset type syncs to the user's home directory

## Asset Types

| Folder/File | Synced To | Sync Behavior |
|-------------|-----------|---------------|
| `docs/` | `~/.craft-agent/docs/` | Always overwrite on launch |
| `themes/` | `~/.craft-agent/themes/` | Always overwrite on launch |
| `permissions/` | `~/.craft-agent/permissions/` | Always overwrite on launch |
| `tool-icons/` | `~/.craft-agent/tool-icons/` | Always overwrite on launch |
| `release-notes/` | `~/.craft-agent/release-notes/` | Always overwrite on launch |
| `config-defaults.json` | `~/.craft-agent/config-defaults.json` | Always overwrite on launch |

## Why Sync on Every Launch?

- Ensures users always have the latest defaults/docs when the app updates
- Consistent behavior between debug and release builds
- No stale configuration causing confusion

## Other Files (Not Synced)

These files are used by electron-builder or the app directly, not synced to user home:

| File | Purpose |
|------|---------|
| `icon.*` | App icons (icns, ico, png, svg) |
| `Assets.car` | macOS compiled asset catalog |
| `dmg-background.*` | DMG installer background |
| `craft-logos/` | Branding assets |
| `source.png` | Default source icon |
| `generate-icons.sh` | Icon generation script |
| `bridge-mcp-server/` | Bundled MCP server for Codex/Copilot API source bridge |
| `session-mcp-server/` | Bundled MCP server for session tools |

## Single Source of Truth

The files in this folder are the **source of truth** for bundled defaults:
- Edit `config-defaults.json` here to change default settings
- Edit files in `docs/` to update documentation
- Edit files in `themes/` to update bundled themes

There is no TypeScript fallback - if the bundled JSON file is missing, the app will fail with a clear error.

## Release Notes Authoring

**Never create `{version}.md` files in feature commits.** Versioned files in `release-notes/` are owned by the release skill — it consolidates pending entries into `{version}.md` at release-prep time and resets the scratch file.

For **fork-authored** PRs that add user-visible behavior, append a bullet to the relevant section in [`release-notes/next.md`](release-notes/next.md). Match the tone and depth of recent versioned files (e.g. `0.9.0.md`): bold short title — detailed paragraph — issue reference — commit hash.

**Why this exists:** during v0.9.0 prep, two feature commits had pre-emptively written `0.8.14.md` and `0.8.15.md` (guessing patch releases), but the changes ended up rolled into a minor. Both files had to be deleted and folded back in — without that cleanup, they would have surfaced as ghost versions in the in-app release-notes panel.

**Versioning (ADR-0010):** from `0.11.2` onward, versioned files are **Vorno-owned** — they describe Vorno releases, not upstream's. Upstream's `{version}.md` files are not adopted during upstream syncs; notable upstream features get summarized into `next.md` instead. Files ≤ `0.11.1` are shared history with upstream and stay as-is.

### Upstream-sourced bullets use attribution, not issue/commit refs

A bullet folded in from an upstream sync ends with **`(from upstream vX.Y.Z)`** and carries **no issue reference and no commit hash**. This is deliberate, not an omission:

- A sync lands as one merge commit, so a hash would be the *same* for every bullet in the batch — it identifies the merge, not the change, and tells a reader nothing.
- Issue numbers in upstream's tracker refer to work we did not do and to a backlog our users cannot act on. The version tag is the honest, resolvable pointer.
- The full traceability for a sync — upstream tag, commit, conflicts, validations — is recorded in `vorno-internal/upstream/HEAD.md` by the [`upstream-sync`](../../../.agents/skills/upstream-sync/SKILL.md) skill. `next.md` is the user-facing surface; `HEAD.md` is the audit trail. Don't duplicate one into the other.

Established convention — see the upstream-attributed bullets in `0.12.2.md`, `0.15.0.md`, and `0.17.0.md`. If a bullet describes upstream work, it needs the attribution suffix **even when it also references one of our ADRs** for local context.

Reviewers (including automated ones) reading only the paragraph above have flagged these as missing traceability. They are not — this section is the answer.
