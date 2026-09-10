---
id: PLAN-052
title: Ship upstream Pages securely in Vorno
status: in-progress
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [ADR-0033]
related-suvs:
  - SUV-0056-record-pages-program-decision-and-roadmap.md
  - SUV-0057-merge-upstream-v0-13-x-pages.md
  - SUV-0058-enable-pages-per-workspace-with-navigator-coexistence.md
  - SUV-0059-secure-page-scripts-and-session-callbacks.md
  - SUV-0060-operate-vorno-pages-sharing.md
  - SUV-0061-brand-and-publish-pages-documentation.md
  - SUV-0062-qualify-and-release-0-22-0-beta-1.md
  - SUV-0063-enable-prerelease-publishing-and-pages-privacy-policy.md
blocked-by: []
---

# PLAN-052 — Ship upstream Pages securely in Vorno

## Goal

Ship signed and notarized Vorno `0.22.0-beta.1` with upstream Pages available
only as a secure, per-workspace opt-in, backed by Vorno-owned sharing,
documentation, and release qualification.

## Scope

- Adopt upstream `v0.13.0`–`v0.13.3` Pages additively, preserving
  `pages:*`, `pages/{slug}`, and `craft-pages/v1` compatibility alongside
  Vorno's existing navigators and automation/session behavior.
- Persist a workspace Pages setting that defaults to disabled and gates UI,
  tools, refresh, and privileged execution while leaving delete, unpublish,
  and grant revocation available for safe cleanup.
- Add digest-bound, expiring, revocable grants for no-shell scripts and pinned
  session callbacks; host-side declared intent, activation, confirmation,
  replay, rate, cancel, audit, and containment checks are authoritative.
- Operate Pages sharing from a separate `pages.vorno.ai` Worker and R2 bucket,
  with isolated admin tokens, strict CSP/sandboxing, password and size/rate
  controls, immediate unpublish deletion, and a documented retention policy.
- Ship one bundled Pages guide as the source for in-app and online docs; close
  Pages-specific branding/config-directory gate gaps and publish the matching
  prerelease changelog.
- Qualify and release `0.22.0-beta.1` without displacing stable downloads or
  stable-user updates.

## Non-goals

- Customizable navigation order or visibility in this release; PLAN-053 owns
  it after the Pages merge.
- An account system, a generic hosted-content platform, a second sharing
  Worker on `share.vorno.ai`, or a parameterized session-message language.
- New Sentry behavior in the upstream merge. Sentry is already shipped and
  unchanged since the merge base; telemetry/privacy posture is a separate
  owner decision, not hidden merge scope.
- Claiming that published pages cannot navigate themselves externally. The
  contract is no **scripted network egress**; self-navigation is a documented
  residual to assess separately.

## Approach

Land the decision and this decomposition first. Merge upstream with a merge
commit, then use the workspace gate as the first implementation boundary.
Callback security reuses existing broker, script-runner, session-action, and
closure-gate choke points rather than creating a parallel privilege path.
Sharing is a deliberately separate user-data service; its legal/privacy gate
must clear before deployment. Documentation and prerelease delivery are
separate owning PRs where they cross repositories.

Each SUV is one PR. Dependency ordering is recorded in the SUV records; a
later lane rebases on the landed predecessor rather than broadening its scope.

## Owner gates and unknowns

- Jeff must approve the Page script/session first-use confirmation and the
  grant TTL ceilings before implementation commits to the final UX values.
- The opaque-iframe activation premise is unverified. After the upstream merge,
  an Electron experiment must compare frame and parent activation; failure
  selects a trusted host-click path or removes the unprovable invocation path
  rather than weakening host enforcement.
- A privacy policy and retention decision are pre-deploy gates. Proposed
  default: retain content until unpublish, delete objects immediately on
  unpublish, and retain operational logs for at most 30 days. If unanswered,
  `pages.vorno.ai` does not deploy.
- A separate owner decision must state Sentry's telemetry/privacy posture;
  this plan preserves the merge-base behavior as a no-op.

## Acceptance

- [ ] ADR-0033, this plan, and all eight reserved SUVs are internally
      consistent; every SUV has one owning plan and one PR-sized outcome.
- [ ] Upstream `e8963854` is an ancestor of `main` through a merge commit, and
      the compatibility audit records Pages contracts plus deliberate Vorno
      divergences.
- [ ] Existing and new workspaces keep Pages disabled by default; enabling it
      persists per workspace without removing Projects, Workbench, Artifacts,
      or existing navigation/session behavior.
- [ ] No mutating page action can bypass its approved, digest-bound,
      expiring/revocable grant through direct RPC, desktop, or WebUI.
- [ ] Sharing is only to the verified Vorno endpoint and deploys only after the
      privacy/retention gate; published pages have no privileged actions and no
      scripted network egress under the documented CSP/sandbox contract.
- [ ] `0.22.0-beta.1` is prerelease-classified, signed/notarized, documented,
      updater-safe for stable users, and verified over the named production
      surfaces.

## Status log

- `2026-09-10` — created in `planned/` from the approved 0.22.0-beta.1 Pages
  program and Phase 1 research.
- `2026-09-10` — moved from `planned` to `in-progress`: ADR/roadmap SUV opened
  as the program's first reviewable PR.
