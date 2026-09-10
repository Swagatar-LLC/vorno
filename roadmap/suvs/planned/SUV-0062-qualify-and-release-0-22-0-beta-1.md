---
id: SUV-0062
title: Qualify and release 0.22.0-beta.1
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0057, SUV-0058, SUV-0059, SUV-0060, SUV-0061, SUV-0063]
blocked-by: []
---

# SUV-0062 — Qualify and release 0.22.0-beta.1

## Goal

Prove the integrated Pages program through automated qualification and publish
an updater-safe, signed/notarized `0.22.0-beta.1` prerelease.

## Scope

- Add the focused integration/browser/release-shape coverage not owned by the
  feature SUVs; run all repository gates and final adversarial review.
- Fix prerelease semver comparison in release notes and make release pre-create
  reconcile GitHub prerelease state without adding an electron-builder channel.
- Bump all release packages except `apps/server`, regenerate lockfile, move
  `next.md` into the exact beta notes file, and cut the release PR/tag after
  every prerequisite is merged.
- Verify GitHub classification/assets/manifest, updater behavior, stable
  download behavior, Pages docs/changelog, and deployed Worker endpoints.

## Acceptance

- [ ] Automated tests cover disabled/enabled Pages, navigator coexistence,
      direct-RPC callback refusal, and the Worker public contract where each is
      not already proved by its owning SUV.
- [ ] Release workflow pre-creates or reconciles the feed release as
      `--prerelease` for any SemVer prerelease and preserves `latest-mac.yml`.
- [ ] Release-note semver tests cover beta/stable ordering and never return
      `NaN`; `0.22.0-beta.1.md` exists at the tagged commit.
- [ ] Full CI, required package/build gates, and final security/correctness and
      ponytail reviews pass before tag creation.
- [ ] The tag is signed/notarized/published as a GitHub prerelease; stable users
      and `vrno.io/dl` remain on the last stable release.
- [ ] Real HTTP checks verify assets, manifest version/sizes, beta updater path,
      stable download path, Pages docs/changelog, and deployed Page endpoints.

## Status log

- `2026-09-10` — created in `planned/`; release waits for every feature SUV and
  the separate vorno-site prerequisite SUV.
