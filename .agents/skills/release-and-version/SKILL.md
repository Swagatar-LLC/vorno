---
name: "Release and Version (Vorno)"
description: "How to cut a Vorno release: SemVer bump across the workspace packages, release-notes consolidation, tag-triggered release.yml (build/sign/notarize/publish), and the 'Jeff cuts on explicit go-ahead' rule."
alwaysAllow:
  - "Read"
  - "Bash"
---

# Release and Version — Vorno

Use this when cutting a **Vorno** release (`Swagatar-LLC/vorno`, this repo), debugging
`release.yml`, or deciding the next version.

> **This is the Vorno recipe.** Vorno does **not** use release-please, `pyproject.toml`,
> Docker/GHCR, or cosign — that's the *Steward* project's process (its own
> `release-and-version` skill lives in `~/dev/steward/.agents/skills/`). Don't cross them.

## The one hard rule: Jeff cuts releases

Releases are cut **only on Jeff's explicit go-ahead** (e.g. "cut 0.13.0" / "cut it") —
never automatically when work accumulates. Each release is a product event Jeff
coordinates externally (socials, website, release feed). **The agent preps everything
and waits.** Merge feature/fix PRs to `main` freely between releases.

## Versioning (SemVer 2.0, pre-1.0)

Vorno is `0.x.y`. Compute the bump from Conventional Commits **on `main` since the last
`vX.Y.Z` tag**:

| Commits since last tag | Bump |
|---|---|
| any `feat:` | **minor** (`0.12.3 → 0.13.0`) |
| only `fix:` / `perf:` / `refactor:` | **patch** (`0.12.3 → 0.12.4`) |
| only `docs:` / `test:` / `chore:` / `ci:` / `build:` | no release |
| `feat!:` / `BREAKING CHANGE:` | minor (pre-1.0 caps major at minor) |

A "point release" that includes a `feat:` is still a **minor** bump — don't undersell a
feature as a patch. Versioning is Vorno-owned per ADR-0010.

```bash
# what's landed since the last tag
git fetch origin main --tags -q
LAST=$(git tag --sort=-creatordate | grep '^v' | head -1)
git log --oneline "$LAST"..origin/main
```

## Pre-flight

- [ ] The intended commits are on `main` — verify with `git merge-base --is-ancestor <sha> origin/main`, **not** a PR's "MERGED" badge (see LEARNING-046: a stacked PR can merge into a stale base branch, not `main`).
- [ ] `bun run test:webui` and `bun run typecheck` green on `main`.
- [ ] Decide the version per the table above.

## The recipe (on go-ahead)

1. **Consolidate release notes.** Move accumulated bullets from
   `apps/electron/resources/release-notes/next.md` into a new
   `apps/electron/resources/release-notes/{version}.md`, then reset `next.md` to its
   template. If `next.md` is empty, author `{version}.md` from the commit log
   (Features / Improvements / Bug Fixes; user-facing language, skip docs/roadmap noise).

2. **Bump the version in ALL workspace `package.json` files EXCEPT `apps/server`.**
   `apps/server` is on an independent `0.3.x` line — leave it. A partial bump ships a
   build whose About/toast shows the old version (LEARNING-025: `getAppVersion()` reads
   `packages/shared/package.json`). Bump root + `apps/{cli,electron,viewer,webui}` +
   every `packages/*`.

   ```bash
   NEW=0.13.0; OLD=0.12.3
   for f in package.json apps/cli/package.json apps/electron/package.json \
            apps/viewer/package.json apps/webui/package.json packages/*/package.json; do
     node -e "const fs=require('fs'),p='$f',j=JSON.parse(fs.readFileSync(p));\
       if(j.version==='$OLD'){j.version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');console.log('bumped',p)}\
       else console.log('SKIP',p,j.version)"
   done
   node -p "require('./apps/server/package.json').version"  # must still be 0.3.x
   ```
   Sanity-check the diff is exactly one line per file (no formatting churn):
   `git diff --numstat | grep -v release-notes`.

3. **PR → CI → merge.** Branch `release/{version}`, commit
   `chore(release): v{version} — <headline>`, open a PR to `main`, wait for all CI
   checks green. Merge with a **merge commit** (not squash) so there's a stable commit
   to tag. Branch protection may require a review — Jeff's "cut" *is* the authorization;
   `gh pr merge <n> --merge --delete-branch --admin` is acceptable on his go-ahead.

4. **Tag the merge commit and push.** This fires `release.yml`.
   ```bash
   git fetch origin main --tags -q
   MERGE=$(git rev-parse origin/main)              # the merge commit
   git tag -a v{version} "$MERGE" -m "v{version} — <headline>"
   git push origin v{version}
   ```
   `release.yml` builds, signs, notarizes (Apple queue), and publishes DMG/ZIP +
   `latest-mac.yml` to `Swagatar-LLC/vorno-releases` (~15–20 min).

5. **Verify the feed.** Confirm `release.yml` succeeded and the release on
   `Swagatar-LLC/vorno-releases` has the DMG, ZIP, and `latest-mac.yml` (the
   auto-updater manifest). First publish may `422` ("Published releases must have a
   valid tag") — a GitHub non-draft create race; `release.yml`'s pre-create-tag step
   guards it (LEARNING-023). If it still 422s, just re-run the failed job.

   Verify over **real HTTP**, not just the API — and note the shell's `curl` may be aliased
   to a missing binary, so try `/usr/bin/curl`:

   ```bash
   BASE=https://github.com/Swagatar-LLC/vorno-releases/releases/download/v{version}
   /usr/bin/curl -sL "$BASE/latest-mac.yml"                 # version: {version}; sizes match assets
   /usr/bin/curl -sIL "$BASE/Vorno-arm64.dmg" | grep -iE '^(HTTP|content-length)'
   /usr/bin/curl -sIL https://vrno.io/dl | grep -iE '^(HTTP|location)'   # must end 200 on the NEW version
   ```

   **The `vrno.io/dl` check is not optional.** That slug redirects to GitHub's
   `releases/latest/download/Vorno-arm64.dmg`, which resolves only because
   `apps/electron/electron-builder.yml` sets a **version-free** `artifactName`
   (`Vorno-${arch}.dmg`). Adding `${version}` — or adding Windows/Linux targets with
   versioned names — 404s the primary download link with **no CI failure and no release
   failure**, and the auto-updater keeps working (it reads filenames *out of*
   `latest-mac.yml` rather than constructing them). So "updates work" is not evidence
   `/dl` works; only this check is. See LEARNING-048 (vorno-internal).


## Common failure modes

- **About box shows the old version** — a package.json (usually `packages/shared`) was missed in step 2. Re-bump and re-release.
- **Tag pushed but `release.yml` didn't fire** — check its `on: push: tags: ["v*.*.*"]` filter and the Actions tab.
- **`release.yml` 422 on publish** — GitHub tag race; re-run the job (see step 5).
- **A commit you expected isn't in the build** — it wasn't actually on `main` at tag time; see LEARNING-046.
- **`vrno.io/dl` 404s after a release** — the DMG artifact name picked up a version or arch change; `releases/latest/download/<name>` needs an exact filename match. Fix `artifactName` or repoint the shortener slug (LEARNING-048).

## References

- User-memory recipe: `vorno-release-management`; ADR-0010 (Vorno-owned versioning).
- Learnings: LEARNING-023 (422 tag race), LEARNING-025 (`getAppVersion` reads `packages/shared`), LEARNING-046 (stacked-PR base-branch strand).
