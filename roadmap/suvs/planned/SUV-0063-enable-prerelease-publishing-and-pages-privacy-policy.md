---
id: SUV-0063
title: Enable prerelease publishing and Pages privacy policy
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0060, SUV-0061, SUV-0062, ADR-0033]
blocked-by: []
---

# SUV-0063 — Enable prerelease publishing and Pages privacy policy

## Goal

Land the separate vorno-site PR that permits beta documentation publishing and
makes the Pages privacy/retention prerequisite public before Worker deployment
or beta tagging.

## Scope

- In `vorno-site`, accept an optional SemVer prerelease suffix in the release
  dispatch guard while retaining malformed-tag rejection.
- Group Pages plus existing shipped guides in the docs manifest and fail rather
  than warn when a shipped guide is ungrouped.
- Publish `https://vorno.ai/privacy` with the Pages service, content-retention,
  immediate-unpublish deletion, operational-log, password, and operator
  disclosure approved by Jeff.
- Verify the vorno-site default branch contains this PR before the Worker deploy
  or beta tag. Deployed sharing is release acceptance, so this prerequisite and
  retention policy transitively gate the tag.

Deliberately out: Worker/client implementation (SUV-0060), bundled docs
(SUV-0061), and release/tag execution (SUV-0062).

## Acceptance

- [ ] A separate `vorno-site` PR accepts `v0.22.0-beta.1` while rejecting an
      invalid tag, and it is merged to that repository's default branch first.
- [ ] The site build fails for any fetched bundled guide absent from its docs
      manifest; Pages and currently shipped ungrouped guides are grouped.
- [ ] `https://vorno.ai/privacy` is live before Worker deployment and names the
      approved Pages data controller, retention, deletion, logging, password,
      and abuse/contact posture.
- [ ] Jeff explicitly decides retention; the proposed policy is content until
      unpublish, immediate object deletion, and operational logs <=30 days.
- [ ] If Jeff has not decided policy/retention, the PR records the gate as open
      and neither `pages.vorno.ai` deployment nor the beta tag proceeds.
- [ ] A dry-run or real prerelease dispatch produces the Pages docs and beta
      changelog path expected by SUV-0062.

## Status log

- `2026-09-10` — created in `planned/`; this SUV owns the cross-repository
  vorno-site PR and the explicit policy gate for deployment and beta tagging.
- `2026-09-13` — merged evidence recorded: `vorno-site` PR #2 carried this
  SUV's implementation (prerelease dispatch guard, docs-manifest grouping, and
  the `/privacy` policy page), and `https://vorno.ai/privacy/` is live. Also
  merged to `origin/main` through `8a5f44d6`: SUV-0061 via PR #209, supporting
  roadmap/docs PR #207, and quiescence-flake fix PR #210. This SUV stays in
  `planned/` — the implementation is merged, but remaining acceptance is the
  launch-status wording update and deploy verification (confirming the site
  change is live ahead of Worker deployment and the beta tag); neither has
  evidence recorded yet.
