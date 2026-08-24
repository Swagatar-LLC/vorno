---
id: SUV-0005
title: Dispatch feedback through the CLI instead of a deep link
status: in-progress
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-23
related: []
blocked-by: []
---

# SUV-0005 — Dispatch feedback through the CLI instead of a deep link

## Goal

Submitting a feedback record from the console starts a headless
`vorno-cli run` and streams its output back, replacing the `vorno://` handoff
that requires an attended desktop app.

## Scope

- Console-side dispatch: spawn `vorno-cli run <message> --workspace-dir <path>`,
  capture stdout/stderr, surface progress in the feedback UI, and record the
  exit status on the feedback record.
- A run is a child process the console owns: it can be started, watched, and
  reported as failed. No fire-and-forget URL open.
- The human's words are stored **verbatim** on the record and passed verbatim
  to the CLI. No paraphrase, no summarisation into a prompt preamble.
- Remove the deep-link submission path once the CLI path works. Deep links
  survive only for *focusing* the board (P5).

## Non-scope

- No worktree isolation yet (SUV-0006) — this SUV may run in the repo checkout
  and is not safe for concurrent feedback until SUV-0006 lands.
- No reconciliation semantics in the prompt (SUV-0008).
- **Zero diff under `packages/` or `apps/`.** If the CLI cannot do this today,
  that is a finding for PLAN-039, not a license to edit the product.

## Acceptance

- [ ] Submitting feedback starts a `vorno-cli run` process from the console and returns its exit code.
- [ ] Output streams into the feedback UI while the run is in flight.
- [ ] A non-zero exit marks the record failed with the captured stderr attached, not silently swallowed.
- [ ] The stored feedback text is byte-identical to what the human typed.
- [ ] The Vorno desktop app is not required for a run to complete.
- [ ] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-23` — moved from `planned` to `in-progress`: Starting P3: console-side CLI dispatch replacing the deep-link handoff. Orchestrated from session 260823-true-meadow.
