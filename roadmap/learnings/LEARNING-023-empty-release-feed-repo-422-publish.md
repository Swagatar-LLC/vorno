---
id: LEARNING-023
title: electron-builder publish to an empty (zero-commit) feed repo fails with HttpError 422 "Published releases must have a valid tag"
date: 2026-07-13
status: active
component: release
related-plans: []
related-decisions: []
---

# LEARNING-023 — electron-builder publish to an empty (zero-commit) feed repo fails with HttpError 422 "Published releases must have a valid tag"

## Signal

The release build completes fully — compile, package, sign, notarize all green — and then the final publish step to the release-feed repo fails:

```
HttpError: 422 Unprocessable Entity
"method: post url: https://api.github.com/repos/Swagatar-LLC/vorno-releases/releases

          Data:
          {
  "message": "Validation Failed",
  "errors": [
    {
      "resource": "Release",
      "code": "custom",
      "message": "Published releases must have a valid tag"
    }
  ],
  "documentation_url": "https://docs.github.com/rest/releases/releases#create-a-release",
  "status": "422"
}
    at createHttpError (.../node_modules/builder-util-runtime/src/httpExecutor.ts:66:10)
```

The misleading part: the tag *is* valid in the **source** repo. The error is about the **target feed repo** (`vorno-releases`), which electron-builder publishes to via `publish.repo`.

## Root cause

Creating a GitHub release requires GitHub to create (or resolve) a tag in the **target** repo, and a tag must point at a commit. A freshly-created feed repo with **zero commits** has no commit for the tag to point at, so the Releases API rejects the create with the `custom` 422 above. electron-builder surfaces it verbatim with no hint that the repo is empty.

Hit on release run [29300505500 attempt 1](https://github.com/Swagatar-LLC/craft-agents-oss/actions/runs/29300505500) — the first-ever publish to the brand-new `Swagatar-LLC/vorno-releases` feed repo, which had been created bare (no README, no commits).

## Fix

Put at least one commit in the feed repo, then simply **re-run the failed workflow run** — same tag, same commit, no code change needed:

```bash
# one-time: give the feed repo a root commit (any file works)
gh api repos/Swagatar-LLC/vorno-releases/contents/README.md \
  -X PUT -f message="chore: initial commit" \
  -f content="$(base64 <<< '# Vorno releases feed')"

# then re-run the failed release run
gh run rerun <run-id> --repo Swagatar-LLC/craft-agents-oss --failed
```

(In our case the README landed via session `ruby-nickel`; attempt 2 of the same run then published cleanly — release `v0.11.2` with DMG/ZIP/blockmaps/`latest-mac.yml`.)

Note the failure is publish-only and the build is not reusable across runs — the re-run rebuilds and re-notarizes from scratch (~15–20 min including Apple's queue).

## Recurrence

- Any time a **new** release-feed repo is created for a channel (e.g. a future beta feed, a Windows feed repo) and the first release publishes before the repo has a commit.
- One-time per repo: once any commit exists, this can never recur for that repo.

## Recurrence (2026-07-13, v0.11.3) — root cause is broader than the empty repo

The identical 422 killed v0.11.3's first publish attempt ([run 29303883796](https://github.com/Swagatar-LLC/craft-agents-oss/actions/runs/29303883796)) — with the feed repo **fully populated** (README + assets + an existing v0.11.2 release). The empty-repo theory above is only a special case.

**Refined root cause:** electron-builder publishes a **non-draft** release (`releaseType: release` in `electron-builder.yml`, chosen because electron-updater cannot see drafts). GitHub's create-release API intermittently rejects non-draft creation with this 422 **when the tag does not yet exist in the target repo** — a server-side race. Diagnostic tell in both incidents: the tag *and* the release were actually created at the exact timestamp of the "failed" POST (v0.11.2: release created 02:20:57Z = attempt-1 error time; v0.11.3: 03:44:34Z ditto), and the run still failed after electron-builder's 3 retries all 422'd. The re-run then succeeds because the tag exists by then — which is also the real reason the v0.11.2 "README fix" appeared to work.

A partially-published release may be left behind (v0.11.3 attempt 1 left a published release containing only a `.dmg.blockmap`). This is safe for installed apps — a missing `latest-mac.yml` degrades to "no update" via `isBenignFeedAbsence` — and the re-run uploads the remaining assets onto the same release.

## Prevention

- When creating a release-feed repo, always initialize it with a README (check "Add a README" at creation, or push one immediately).
- Feed-repo setup docs/skills should list "repo has ≥1 commit" as a release-pipeline precondition alongside token scopes.
- **Durable fix (2026-07-13):** `release.yml` now has an "Ensure release tag exists in feed repo" step that pre-creates `refs/tags/${TAG}` in `vorno-releases` (pointing at its HEAD) before electron-builder runs, eliminating the race entirely. Idempotent; runs only on the signing path.

## References

- Failed attempt: https://github.com/Swagatar-LLC/craft-agents-oss/actions/runs/29300505500 (attempt 1 = 422; attempt 2 = success)
- GitHub Releases API: https://docs.github.com/rest/releases/releases#create-a-release
- [LEARNING-020](LEARNING-020-adhoc-fork-upstream-feed-squirrel-code-requirement.md) — why the fork has its own feed repo at all
