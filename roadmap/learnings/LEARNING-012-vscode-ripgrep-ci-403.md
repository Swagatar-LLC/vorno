---
id: LEARNING-012
title: '@vscode/ripgrep postinstall 403s in CI without GITHUB_TOKEN'
date: 2026-07-08
status: active
component: ci
related-plans: []
related-decisions: []
---

# LEARNING-012 — `@vscode/ripgrep` postinstall 403s in CI without `GITHUB_TOKEN`

## Signal

A CI job's `bun install --frozen-lockfile` step fails (intermittently — often just one job of several) with:

```
Downloading from https://api.github.com/repos/microsoft/ripgrep-prebuilt/releases/assets/...
statusCode: 403
Download attempt 1 failed, retrying in 2 seconds...
...
Downloading ripgrep failed after multiple retries: Error: Request failed: 403
error: postinstall script from "@vscode/ripgrep" exited with 1
##[error]Process completed with exit code 1.
```

## Root cause

`@vscode/ripgrep`'s postinstall (`node_modules/@vscode/ripgrep/lib/download.js`) fetches the prebuilt `rg` binary from `api.github.com`. Unauthenticated GitHub API requests are rate-limited to **60/hour per source IP**. GitHub Actions runners share public IPs across many jobs, so the limit is exhausted quickly — the failure is **flaky** (whichever job hits the API after the budget is spent 403s, while sibling jobs that ran earlier pass). It has nothing to do with the PR's contents; a docs-only PR triggers it just as easily.

## Fix

Expose the auto-provided `GITHUB_TOKEN` to the install steps. `download.js` reads `process.env.GITHUB_TOKEN` and sends it as an auth header, raising the limit to **1000/hour per repo**. Set it once at workflow level so every `bun install` job inherits it:

```yaml
# .github/workflows/validate-pr.yml — top level, above `jobs:`
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`secrets.GITHUB_TOKEN` is minted automatically per run — no PAT or repo secret to configure. It is also what `gh` uses, so exposing it as `env` is safe and standard.

## Recurrence

Any CI workflow that runs `bun install` (or npm/yarn) with `@vscode/ripgrep` in the tree, on shared-IP runners, without an authenticated token. Also bites shared office/VPN IPs and Docker build farms. Frequency scales with how many concurrent installs share the IP.

## Prevention

- The workflow-level `env` above is committed to `validate-pr.yml`. Any **new** workflow that installs deps must carry the same block — the per-job `bun install` will otherwise reintroduce the flake.
- Local `build-dmg.sh` runs `bun install` too, but from a residential IP with a warm cache, so it rarely trips; if it does, `export GITHUB_TOKEN=<token>` before the build.

## References

- `@vscode/ripgrep` download logic: `node_modules/@vscode/ripgrep/lib/download.js` (reads `GITHUB_TOKEN`).
- GitHub REST rate limits: 60/hr unauthenticated vs 1000/hr with `GITHUB_TOKEN` in Actions.
- Surfaced fixing PR #50's Build-check job (the packaging-staging-fix branch).
