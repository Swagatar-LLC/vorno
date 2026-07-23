---
id: PLAN-028
title: In-CI build + user-journey tests — WebUI suite first, Electron later
status: planned
direction: null
owner: jh
created: 2026-07-22
updated: 2026-07-22
related: []
blocked-by: []
---

# PLAN-028 — In-CI build + user-journey tests (WebUI first, Electron later)

## Motivation

The follow-up/annotation defects fixed in PR #106 QA (Save & Send dropped the
follow-up; a phantom chip that couldn't be removed; a `<button>`-in-`<button>`
DOM-nesting warning) were all **runtime, journey-level** failures. Every one
passed the unit suites and the three lint gates — none was catchable without
actually building the app and driving a real user flow. CI today gives no
signal on "does the built app let a user complete X." This plan closes that gap.

See LEARNING-035 (idempotent annotation remove / phantom chip) and LEARNING-007
(silent-void handlers) for the class of bug this is meant to catch.

## Goal

Run a build of the app in CI and exercise a small set of **named user
journeys** end-to-end against it, so journey regressions fail the PR instead of
surfacing in manual QA. Start with the **WebUI** surface (cheapest to build and
drive headlessly); layer **Electron** journeys on once the WebUI harness is
proven.

## Phasing

- **Phase 1 — WebUI journey suite (start here).**
  - Stand up a headless browser E2E harness (Playwright is the likely fit —
    confirm on advance) that boots the WebUI build against a throwaway
    `CRAFT_CONFIG_DIR` and a seeded/mock session backend.
  - Encode the first journeys as the acceptance surface (see below).
  - Wire as a CI job on PRs; gate by journey pass/fail, not by the ~108
    pre-existing electron tsc errors (which are NOT CI-gated — keep it that way,
    gate by diff).
- **Phase 2 — Electron journeys (layer later).**
  - Reuse the Phase-1 harness/journey definitions where possible; add an
    Electron driver (Playwright-Electron or equivalent) for main-process /
    packaged-app paths the WebUI can't cover.
  - Mind the known build traps: per-instance userData/singleton-lock
    (LEARNING-032), `bun install` leaving Electron half-installed in fresh
    worktrees (LEARNING-034), branding gate scanning `release/` build output.

## Candidate first journeys (WebUI)

Pick a thin, high-signal set; the PR #106 bugs argue for annotations up front:
1. **Annotation follow-up round-trip** — highlight → add follow-up note → Save &
   Send → assistant receives it in the message → chip clears (regression guard
   for the Save & Send race).
2. **Remove a follow-up / annotation** — including the idempotent-remove path
   (removing an already-absent annotation must not strand a phantom chip).
3. **Send a message / basic chat turn** — submit input, see the turn render.
4. **Session create + status change** — smoke the session-list interactions
   (would have surfaced the SessionStatusIcon DOM-nesting path).
5. **Console-error assertion** — fail the journey on `validateDOMNesting` and
   other React console errors/warnings during the run.

## Non-goals

- Full-coverage E2E of every screen — this is a **thin journey guard**, not a
  QA replacement. Keep the suite small and fast enough to gate every PR.
- Visual/pixel regression testing (separate concern; not this plan).
- Replacing manual pre-release runtime QA (Jeff still cuts releases).

## Open questions (resolve on advance)

- Harness choice (Playwright vs alternative) and how it boots the WebUI build in
  CI (bind address / port; reuse the `webui` remote-access plumbing?).
- Backend for journeys: seeded real server-core vs. a mock transport. Real
  server-core catches more (e.g. the idempotent-remove event round-trip) but is
  heavier.
- CI cost/time budget per PR and where the job runs (macos-14 runner shared with
  release, or a cheaper linux runner for the WebUI headless suite).
- Console-error assertion strictness (fail on any warning vs. an allowlist).

## Acceptance (Phase 1)

- A CI job builds the WebUI and runs the journey suite on every PR.
- The five candidate journeys above pass green; a deliberately reintroduced
  PR #106-class bug makes the relevant journey fail.
- Journey failures block merge; the suite runs within an agreed time budget.

> Note: stub captured 2026-07-22 (session 260722-plain-swamp) as a future-plan
> placeholder — not yet scheduled or bound to a direction. Uncommitted; fold
> into the roadmap via the normal PR flow.
