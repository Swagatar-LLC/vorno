---
id: LEARNING-025
title: Settings/update UI version comes from packages/shared/package.json — a release must bump the whole workspace version cluster, not just apps/electron
date: 2026-07-14
status: active
component: release
related-plans: []
related-decisions: []
---

# LEARNING-025 — Settings/update UI version comes from `packages/shared/package.json` — a release must bump the whole workspace version cluster, not just `apps/electron`

## Signal

After a successful auto-update, the app displays the **old** version everywhere user-facing while the update itself demonstrably worked:

- Settings → About shows `Version 0.11.1` on a build that is actually 0.11.2/0.11.3
- Manual check toast: `You're up to date — Version 0.11.1 is the latest.`

No errors anywhere. The Dock icon / bundle are the new build; only the displayed number is stale.

## Root cause

Two different "the version" sources exist, and a fork release was bumping only one of them:

1. **Real app version** — `apps/electron/package.json` `version`, baked into the bundle; Electron's `app.getVersion()` and electron-updater's semver comparison use this. This was bumped (release gate requires it to match the tag), which is why updates actually worked.
2. **Displayed version** — `getAppVersion()` in `packages/shared/src/version/index.ts` does `import pkg from '../../package.json'` — that is **`packages/shared/package.json`**, compiled in at build time. `auto-update.ts` seeds `updateInfo.currentVersion` from it, and both the Settings About row and the update toasts render that field.

Upstream never hits this because their `vX.Y.Z` release commits bump the **entire workspace cluster** — 15 package.json files (everything except the fork-owned `apps/server`, which versions independently at its own line). See upstream commit `4289b160` (`v0.11.1`). The fork's v0.11.2/v0.11.3 release preps bumped only root + `apps/electron`, so every package including `shared` stayed at `0.11.1` and every build since displayed `0.11.1`.

## Fix

Bump the `version` field in **all** workspace package.json files at release-prep time — root, `apps/{cli,electron,viewer,webui}`, and all `packages/*` — **except `apps/server`** (fork-owned, independent versioning, currently 0.3.x). There is a single command for this:

```bash
bun scripts/bump-version.ts 0.11.4   # bumps the whole cluster + post-checks shared==electron
bun install                          # bun.lock records workspace versions — regenerate it
```

Two enforcement points added with this learning:
- `scripts/bump-version.ts` post-checks that `packages/shared` and `apps/electron` agree.
- The release gate in `.github/workflows/release.yml` fails the run if `packages/shared` ≠ `apps/electron` version, so a partial bump can never ship again.

## Recurrence

- Every release cut with a two-file bump recurs this exactly. The 0.11.2 and 0.11.3 shipped builds permanently display "0.11.1" in About/toasts; first fixed build is 0.11.4+.
- Watch upstream syncs: their release commits bump the cluster, so a merge can also *fix* the drift silently — don't let that mask the missing step in our own recipe.

## Prevention

- The release recipe (memory + any future release skill) now says: bump the **whole cluster**, not just root + electron.
- The release gate only validates `apps/electron/package.json` against the tag; a future hardening could also assert `packages/shared` matches, failing fast on a partial bump.

## References

- Upstream cluster-bump example: commit `4289b160` (`v0.11.1`) — 15 package.json files
- `packages/shared/src/version/index.ts` — `APP_VERSION` from shared's own package.json
- `apps/electron/src/main/auto-update.ts` — `updateInfo.currentVersion = getAppVersion()` (feeds Settings About + toasts)
- [LEARNING-023](LEARNING-023-empty-release-feed-repo-422-publish.md) — the other v0.11.2/v0.11.3 release-pipeline gotcha
