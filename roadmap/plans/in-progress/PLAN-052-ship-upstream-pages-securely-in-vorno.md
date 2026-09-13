---
id: PLAN-052
title: Ship upstream Pages securely in Vorno
status: in-progress
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-13
related: [ADR-0033]
related-suvs:
  - SUV-0056-record-pages-program-decision-and-roadmap.md
  - SUV-0057-merge-upstream-v0-13-x-pages.md
  - SUV-0058-enable-pages-per-workspace-with-navigator-coexistence.md
  - SUV-0059-secure-page-grant-authority-and-actions.md
  - SUV-0065-enforce-page-action-runtime-authority.md
  - SUV-0066-serialize-workspace-qualified-session-persistence-with-owner-receipts.md
  - SUV-0064-execute-pinned-page-session-callbacks.md
  - SUV-0060-operate-vorno-pages-sharing.md
  - SUV-0061-brand-and-publish-pages-documentation.md
  - SUV-0063-enable-prerelease-publishing-and-pages-privacy-policy.md
  - SUV-0069-enforce-the-thirty-day-pages-retention-ttl.md
  - SUV-0062-qualify-and-release-0-22-0-beta-1.md
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
- Add host-consented, digest-bound, expiring, revocable grants for no-shell
  scripts and pinned callbacks; grant lifecycle, runtime Page-action authority,
  activation, permission-mode revalidation, replay, rate, cancel, audit, and
  containment checks are authoritative.
- Operate Pages sharing from a separate `pages.vorno.ai` Worker and R2 bucket,
  with isolated admin tokens, CSP sandbox, secret scanning, opt-in snapshots,
  rate/size limits, public-shell branding, and graceful absence of backend
  capability.
- Ship one bundled Pages guide as the source for in-app and online docs; close
  Pages branding/config-directory gaps and publish the matching prerelease
  changelog.
- Qualify and release `0.22.0-beta.1` without displacing stable downloads or
  stable-user updates.

## Non-goals

- Customizable navigation order or visibility in this release; PLAN-053 owns
  it after the Pages merge.
- An account system, a generic hosted-content platform, a second sharing
  Worker on `share.vorno.ai`, or a parameterized session-message language.
- Changing Sentry enablement, DSN, or telemetry posture during the upstream
  merge. SUV-0057 takes upstream's privacy-broadening redaction helper/refactor
  while preserving that existing posture.
- Claiming that published pages cannot navigate themselves externally. The
  contract is no **scripted network egress**; self-navigation is a documented
  residual to assess separately.

## Approach

Land the decision and this decomposition first. Merge upstream with a merge
commit, then use the workspace gate as the first implementation boundary.
Host grant lifecycle, then runtime action hardening, land before pinned session
callback execution. Callback security reuses existing broker, script-runner,
session-action, and closure-gate choke points rather than creating a parallel
privilege path. Sharing is a deliberately separate user-data service; its
policy and site prerequisite must clear before deployment and, because deployed
sharing is release acceptance, before the beta tag. Documentation and
prerelease delivery are separate owning PRs where they cross repositories.

Each SUV is one PR. Dependency ordering is explicit below; later lanes rebase
on their landed prerequisites rather than broadening their scope.

## Prerequisites

| Work | Must precede | Reason |
| --- | --- | --- |
| SUV-0056 | all implementation SUVs | Accepted architecture and complete PR-sized ownership records. |
| SUV-0057 | SUV-0058, SUV-0059, SUV-0065, SUV-0064, SUV-0061 | Actual upstream Pages surface and recorded throwaway-merge conflict set. |
| SUV-0058 | SUV-0059, SUV-0060, SUV-0065, SUV-0064 | Persisted workspace opt-in is the availability boundary. |
| SUV-0059 | SUV-0065 | Host grant lifecycle exists before runtime action enforcement. |
| SUV-0065 | SUV-0064 | Runtime authority and trusted activation exist before callbacks execute. |
| SUV-0066 | SUV-0064 | Session persistence is workspace-qualified, serialized per key, and reports durability per write before a callback can claim a message was delivered and saved. |
| SUV-0060 | SUV-0062 | Worker implementation and public sharing contract are verified. |
| SUV-0061 and SUV-0063 | SUV-0062 | Bundled/online docs and site prerelease/privacy support are live. |
| Jeff retention decision plus SUV-0063 | Worker deployment and beta tag | Policy, retention, and prerelease support land before deployed sharing; deployed sharing is release acceptance. **Decision cleared 2026-09-13.** |
| SUV-0069 | Worker deployment | The published policy commits to a 30-day TTL the Worker does not yet enforce. |
| SUVs 0057–0061 and 0063–0065 | SUV-0062 tag | Release qualification verifies the integrated, already-landed behavior only. |

## Owner gate — CLEARED

**Decided by Jeff on 2026-09-13.** The retention policy is approved, with one
change from the proposed default: content gets a **fixed TTL** rather than living
until unpublish, and operational logs are kept longer than proposed.

1. **Published content is retained for 30 days from its last update.** An update
   restarts the window. This replaces the proposed
   "retain until the publisher unpublishes it".
2. **Unpublish immediately revokes public access** — logical revocation, every
   public route returns 404 at once.
3. **Physical deletion is attempted immediately and retried on failure**, and the
   publisher is warned while the content remains revoked. Vorno does not claim
   bytes are gone instantly; it claims access is gone instantly and deletion
   follows.
4. **Cloudflare operational logs are retained for no more than 90 days** — raised
   from the proposed 30 to preserve an abuse-investigation window. Note this is
   deliberately *longer* than content retention.

Consequence: bullet 1 was **not implemented** when this was decided — the Worker
recorded `updatedAt` and had no TTL check, no scheduled handler, and no R2
lifecycle rule. **SUV-0069 is a `pages.vorno.ai` deploy prerequisite**, because
deploying with the policy published and the TTL unenforced would state a deletion
commitment the service does not honour.

Implementing it raised one question, and Jeff answered it on 2026-09-13 at
14:53 EDT: **a password change counts as an update.** Bullet 1 stands exactly as
written above — every update restarts the window, with no carve-out.

That answer has a cost the Worker pays deliberately. The R2 lifecycle rule that
deletes the bytes counts each object's own upload and cannot see a manifest
write, so renewing on a password change means re-uploading the retained objects
rather than only moving a timestamp, and the stored anchor advances only after
those re-uploads succeed. The alternative on the table was to narrow "update" to
content writes; it was cheaper and it was declined, because the published policy
should say the simple true thing rather than the thing that was convenient to
enforce. SUV-0069 carries the implementation and SUV-0063 publishes bullet 1
unmodified.

## Acceptance

- [ ] ADR-0033, this plan, and every SUV listed in `related-suvs` are internally
      consistent; every SUV has one owning plan and one PR-sized outcome.
- [ ] Upstream `e8963854` is an ancestor of `main` through a merge commit; the
      compatibility audit records Pages contracts, the grant-issuance divergence,
      redaction refactor, and deliberate Vorno divergences.
- [ ] Existing and new workspaces keep Pages and sharing disabled by default;
      enabling them persists per workspace without removing Projects, Workbench,
      Artifacts, or existing navigation/session behavior.
- [ ] No grant can persist without host consent, and no mutating Page action can
      bypass its approved digest-bound, expiring/revocable grant, fresh trusted
      interaction proof, or per-invocation permission/workspace checks.
- [ ] Sharing targets only the verified Vorno endpoint, has no privileged action
      or scripted network egress, and deploys only after the policy/site
      prerequisite; unresolved retention blocks deployment and the beta tag.
- [ ] `0.22.0-beta.1` is prerelease-classified, signed/notarized, documented,
      updater-safe for stable users, and verified over the named production
      surfaces.

## Status log

- `2026-09-10` — created in `planned/` from the approved 0.22.0-beta.1 Pages
  program and Phase 1 research.
- `2026-09-10` — moved from `planned` to `in-progress`: ADR/roadmap SUV opened
  as the program's first reviewable PR.
- `2026-09-10` — review corrections: accepted ADR-0033, split host authority
  from callback execution, and made the sharing-policy release sequence and
  prerequisites explicit.
- `2026-09-10` — sizing correction: split grant lifecycle (SUV-0059), runtime
  action authority (SUV-0065), and pinned callback execution (SUV-0064).
- `2026-09-12` — sizing correction: SUV-0064's review surfaced a generic session
  persistence unit (workspace-qualified write keys, one tail per key, owner
  receipts, deletion-vs-supersede, per-field external metadata authority) that
  is independently shippable and fixes standing data-loss bugs of its own. Cut
  as SUV-0066 and made a prerequisite of SUV-0064 rather than shipped inside it.
- `2026-09-13` — owner gate cleared: retention approved with a fixed 30-day
  content TTL and 90-day operational logs. SUV-0069 opened to enforce the TTL and
  added as a deploy prerequisite.
- `2026-09-13` — SUV-0066 froze at PR #206 head `1409619e` after the review loop
  above it stopped converging, and merged as `dfd6dcbb`. Two lifecycle defects
  found during the stand-down are pre-existing on `main` and were scoped out to
  PLAN-054 (SUV-0067, SUV-0068) rather than held against the beta. A bounded
  P0/P1 review of the frozen head caught one real P1 before merge: steer
  durability was promised to backends that cannot confirm delivery, which on
  Pi — the default for every non-Anthropic connection — silently dropped an
  acknowledged steer. Fixed in `a7b39132`.
- `2026-09-13` — release-program state reconciled: `origin/main` is at
  `8a5f44d6`. SUV-0061 merged (PR #209), with supporting roadmap/docs PR #207
  and quiescence-flake fix PR #210; it stays in `in-progress/` pending its
  release-note acceptance item. `vorno-site` PR #2 carried SUV-0063's privacy
  page and `https://vorno.ai/privacy/` is live; SUV-0063 stays in `planned/`
  pending the launch-status wording update and deploy verification. SUV-0069
  (TTL enforcement) remains `in-progress/` with its own acceptance open.
  SUV-0062 moved from `planned` to `in-progress`: qualification/release work
  is underway on branch `release/0.22.0-beta.1`.
