---
id: SUV-0062
title: Qualify and release 0.22.0-beta.1
status: in-progress
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-13
related: [SUV-0057, SUV-0058, SUV-0059, SUV-0060, SUV-0061, SUV-0063, SUV-0064, SUV-0065]
blocked-by: []
---

# SUV-0062 — Qualify and release 0.22.0-beta.1

## Goal

Verify the integrated, already-landed Pages program through automated
qualification and publish an updater-safe, signed/notarized prerelease.

## Scope

- Run the explicit integration/browser/release verification matrix below, all
  repository gates, and final adversarial review. This SUV is verification and
  release work only: a behavioral failure returns to its owning feature SUV or
  a newly scoped SUV; it does not expand this release PR.
- Fix prerelease semver comparison in release notes and make release pre-create
  reconcile GitHub prerelease state without adding an electron-builder channel.
- Bump all release packages except `apps/server`, regenerate lockfile, move
  `next.md` into the exact beta notes file, and cut the release PR/tag after
  every prerequisite is merged.
- Verify GitHub classification/assets/manifest, updater behavior, stable
  download behavior, Pages docs/changelog, and deployed Worker endpoints.

## Acceptance

- [ ] Automated Electron/browser tests cover Pages off by default and persisted
      enablement; static/live/interactive creation, reload persistence, project
      filtering, data refresh, thumbnails, and disabled-state cleanup.
- [ ] The matrix covers grant request/management, script execution, pinned
      session callback, cancellation, revoke, direct-RPC refusal, and no Craft
      request; it runs in both desktop and WebUI where the surface exists.
- [ ] The matrix covers Projects, Pages, Workbench, Artifacts, sessions,
      keyboard navigation, mobile navigation, and WebUI coexistence; public
      create/view/password/update/unpublish proves no bridge action or scripted
      network egress.
- [ ] Behavioral failures are returned to SUV-0058, SUV-0059, SUV-0060,
      SUV-0061, SUV-0064, SUV-0065, or a new SUV; this PR contains no feature
      repair.
- [ ] Release workflow pre-creates/reconciles prereleases, preserves
      `latest-mac.yml`, and release-note semver tests cover beta/stable ordering
      without `NaN`; `0.22.0-beta.1.md` exists at the tagged commit.
- [ ] Full CI, required gates, final reviews, and real HTTP checks pass; the tag
      is signed/notarized/published as a prerelease, stable users and
      `vrno.io/dl` remain stable, and the policy/site prerequisite has cleared.

## Status log

- `2026-09-10` — created in `planned/`; release waits for every feature SUV and
  the separate vorno-site prerequisite SUV.
- `2026-09-10` — narrowed to verification/release only with an explicit browser
  and Electron matrix; feature failures return to their owning SUV.
- `2026-09-13` — moved from `planned` to `in-progress`: implementation is
  underway on branch `release/0.22.0-beta.1`.
- `2026-09-13` — release mechanics landed on `release/0.22.0-beta.1`
  (`3696a20a`): prerelease-aware release-note filenames and SemVer 2.0.0
  ordering, `release.yml` prerelease create *and* reconcile with an explicit
  `--latest=false`, `0.22.0-beta.1.md` consolidated from `next.md`, and the
  workspace version cluster bumped with `bun.lock` refreshed. `latest-mac.yml`
  and stable-tag behavior are unchanged and no electron-builder channel was
  introduced. Gates green locally: `typecheck:packages`,
  `typecheck:pages-worker`, shared tests 4357/0, webui+electron 609/0, i18n
  parity/sorted/coverage, branding.
- `2026-09-13` — **Jeff waived the manual desktop click-through (node K) for
  this beta.** The automated desktop/WebUI matrix items above still stand; what
  is waived is the human-performed real-desktop Page-action walkthrough
  (native confirmation, successful action, reload/unmount during the prompt).
  Rationale of record: this is a prerelease, Pages is off by default in every
  workspace, and publishing additionally requires sharing to be configured.
  The waiver is scoped to `0.22.0-beta.1` and does not carry to the stable
  `0.22.0` release, which should re-instate the manual pass.
- `2026-09-13` — PBKDF2 runtime-cost benchmark (node D): **retain 100,000
  iterations**; no source change. Measured ~6.4 ms median / ~6.7 ms p95 per
  verification at 100k (50k ≈ 3.3 ms, 250k ≈ 15.8 ms, linear as expected).
  **Fidelity caveat: this is a Bun/V8 proxy measurement of the same
  `crypto.subtle.deriveBits` call, NOT a workerd measurement** — running
  `wrangler dev` was declined because it fetches the workerd binary and
  performs Cloudflare account/update checks, which the read-only constraint
  on this node forbids. Expect ±30–50% against real workerd. The decision is
  robust to that error bar: `submitPassword` enforces the
  `PAGE_PASSWORD_LIMIT` rate limit (10/60s per page) *before* hashing, so the
  online-guessing threat is gated by the limiter rather than by iteration
  count, and this protects a published page rather than an account
  credential. `wrangler.jsonc` already exposes `PBKDF2_ITERATIONS` as a var,
  so the value can be retuned at deploy time without a code change.
