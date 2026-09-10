---
id: SUV-0062
title: Qualify and release 0.22.0-beta.1
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
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
