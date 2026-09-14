---
id: SUV-0062
title: Qualify and release 0.22.0-beta.1
status: done
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

- [x] Automated tests cover Pages off by default, persisted per-workspace
      enablement, creation, project filtering, data refresh, thumbnails, and
      disabled-state cleanup (delete/unpublish/revoke still work while
      disabled). **Reload persistence is covered as a `page.json` disk
      round-trip only** — no test simulates a reload restoring UI state.
- [x] The matrix covers grant request/management, script execution, pinned
      session callback, cancellation, revoke, and direct-RPC refusal. **"No
      Craft request" is covered for the sharing-endpoint allowlist only**, not
      for arbitrary granted action targets. The RPC/broker layer is
      transport-agnostic and exercised identically by both clients, but
      **`apps/webui` contains no Pages-specific test**, so the desktop/WebUI
      claim rests on shared code rather than on both surfaces being tested.
- [x] Public create/view/password/update/unpublish is covered thoroughly in
      `workers/pages/index.test.js`, and no bridge action is proven
      (`public-actions-disabled`, empty grants, no `window.open`). **"No
      scripted network egress" is asserted by checking the `connect-src 'none'`
      header is present, not by executing page script in a runtime.**
      **Keyboard navigation has no coverage at all; mobile navigation is
      covered only as a pure `isDetailNavState` classifier; there is no WebUI
      coexistence test.** Waived by Jeff on 2026-09-13 for this beta on the
      node K grounds (prerelease, Pages off by default, publishing needs
      sharing configured). The waiver does **not** carry to stable `0.22.0`.
      Gap filed as SUV-0070.
- [x] Behavioral failures are returned to SUV-0058, SUV-0059, SUV-0060,
      SUV-0061, SUV-0064, SUV-0065, or a new SUV; this PR contains no feature
      repair.
- [x] Release workflow pre-creates/reconciles prereleases, preserves
      `latest-mac.yml`, and release-note semver tests cover beta/stable ordering
      without `NaN`; `0.22.0-beta.1.md` exists at the tagged commit.
- [x] Full CI, required gates, final reviews, and real HTTP checks pass; the tag
      is signed/notarized/published as a prerelease, and stable users and
      `vrno.io/dl` remain stable. **The policy/site prerequisite did NOT
      clear and was waived for this beta by Jeff on 2026-09-13**: `vorno-site`
      PR #3 is deliberately unmerged and SUV-0063 stays planned, because with no
      `pages.vorno.ai` Worker deployed the "live" privacy wording would assert a
      service that does not exist. The currently published policy therefore
      remains true. The waiver does **not** carry to stable `0.22.0`, which must
      clear SUV-0063 before release.

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
- `2026-09-13` — **`v0.22.0-beta.1` RELEASED.** Tag on `40ac0635` (PR #211,
  12/12 CI green including Greptile 4/5 — both Greptile findings dispositioned
  P2/P3 with reasons on the PR, neither reachable on the prerelease path).
  `release.yml` run 34794788303 succeeded end to end including
  `publish-docs`. Verified over real HTTP, not inferred: the GitHub release is
  `prerelease=true, draft=false`; **the feed's `latest` is still `v0.21.0`**, so
  stable users are not offered the beta; all five assets present;
  `latest-mac.yml` reports `0.22.0-beta.1` with matching sizes; DMG 200;
  `vrno.io/dl` 200; `vorno.ai/changelog/0.22.0-beta.1/` 200.
  Acceptance items 1–3 above were rewritten to what the suite actually covers
  rather than ticked as originally written; the gap is SUV-0070.
- `2026-09-13` — **Released without a deployed `pages.vorno.ai` Worker**, on
  Jeff's explicit instruction ("if it fails, address it post-beta.1"). R2 was
  provisioned: bucket `vorno-pages` created and the **30-day lifecycle rule
  verified by reading it back off the real bucket** (`deleteObjectsTransition`,
  `maxAge: 2592000`) — the one provisioning item with no automated check behind
  it. The Worker deploy is blocked two ways: no Cloudflare credentials exist on
  the release machine, and `workers/pages/validate-config.js` throws on
  `--deploy` unconditionally by design, so unfusing it is a code change needing
  its own SUV. Consequence deliberately accepted: `vorno-site` PR #3 (privacy
  wording "planned" → "live") was **left unmerged**, because publishing it with
  no Worker deployed would assert a deployed service that does not exist. The
  live policy stays true. Sharing degrades through the existing
  "unavailable until this workspace has a verified Vorno publication
  capability" path, and Pages is off by default.
- `2026-09-13` — PR #212 review pass: the final acceptance item was rewritten.
  It had claimed the policy/site prerequisite "has cleared" while the status log
  directly above it records `vorno-site` PR #3 left unmerged and SUV-0063 still
  planned. The item now records the explicit beta waiver instead of a cleared
  prerequisite, so the ticked claim matches the evidence in this same file.
