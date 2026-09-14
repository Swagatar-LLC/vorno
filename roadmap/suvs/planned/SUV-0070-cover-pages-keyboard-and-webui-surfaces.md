---
id: SUV-0070
title: Cover Pages keyboard and WebUI surfaces
status: planned
plan: PLAN-054
direction: DIR-04
owner: jh
created: 2026-09-13
related: [SUV-0062, SUV-0058, SUV-0064]
blocked-by: []
---

# SUV-0070 — Cover Pages keyboard and WebUI surfaces

## Why

SUV-0062's qualification matrix claimed automated coverage the repository does
not have. A coverage audit during the `0.22.0-beta.1` release run mapped every
matrix item to the test that backs it and found several backed by nothing. Jeff
waived them for the beta on 2026-09-13 on the same grounds as the node K manual
walkthrough — prerelease, Pages off by default in every workspace, publishing
additionally gated on sharing being configured — and asked that the gap be filed
rather than left implicit.

**This is a verification gap, not a known defect.** No failure was observed in
any of these surfaces. What is missing is the evidence that they work.

## Current state, as measured

511 Pages tests pass, none skipped, none `.todo`. The gaps are:

| Surface | What exists today |
|---|---|
| Keyboard navigation | **Nothing.** No test anywhere touches keyboard nav for Pages or any navigator. |
| WebUI coexistence | **Nothing.** `apps/webui` contains no Pages-related test file at all. |
| Mobile navigation | Only `route-parser-pages.test.ts:105`, which asserts the pure `isDetailNavState` classifier. No rendering or touch path. |
| Reload persistence | `storage.test.ts` proves a `page.json` disk round-trip. Nothing simulates a reload restoring UI state. |
| No scripted network egress | `workers/pages/index.test.js:245` asserts the `connect-src 'none'` header is **present**. No test executes page script in a runtime to prove a `fetch` actually fails. |
| "No Craft request" | `publisher.test.ts:40` covers the sharing-endpoint allowlist only, not arbitrary granted `api`/`mcp` action targets. |

## Scope

- Automated keyboard navigation coverage across the navigator set, including
  Pages.
- At least one WebUI Pages test, so the claim "desktop and WebUI where the
  surface exists" has evidence on both sides rather than an argument that the
  RPC layer is transport-agnostic.
- A reload-persistence test that exercises restore, not just serialization.
- Decide explicitly whether runtime egress proof is worth its cost. Asserting a
  CSP header is not the same claim as proving the browser enforced it, and
  PLAN-052's contract is specifically **no scripted network egress**. If a real
  runtime check is too expensive, say so in the test file so the next reader
  knows the header assertion is the deliberate stopping point.

## Acceptance

- [ ] Keyboard navigation has automated coverage that fails when navigation breaks.
- [ ] `apps/webui` has at least one Pages test, and the matrix's desktop/WebUI
      claim is true as written or corrected to what is covered.
- [ ] Reload persistence is exercised through restore, not only through a disk
      round-trip.
- [ ] The egress claim is either proven at runtime or the header-only stopping
      point is recorded in the test itself.
- [ ] SUV-0062's acceptance items 1–3 are rewritten to match reality, so no
      future reader inherits a coverage claim the suite does not support.

## Status log

- `2026-09-13` — cut during the `0.22.0-beta.1` release run. Jeff waived the
  gap for the beta and asked for a future item; the waiver does not carry to
  stable `0.22.0`.
