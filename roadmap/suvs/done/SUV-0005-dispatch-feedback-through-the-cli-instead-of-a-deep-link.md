---
id: SUV-0005
title: Dispatch feedback through the CLI instead of a deep link
status: done
plan: PLAN-043
direction: DIR-05
owner: jh
created: 2026-08-23
updated: 2026-08-24
related:
  - SUV-0006-isolate-each-feedback-run-in-its-own-git-worktree.md
  - SUV-0008-reconciling-feedback-prompt-with-a-bounded-loop.md
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

- [x] Submitting feedback starts a `vorno-cli run` process from the console and returns its exit code.
- [x] Output streams into the feedback UI while the run is in flight.
- [x] A non-zero exit marks the record failed with the captured stderr attached, not silently swallowed.
- [x] The stored feedback text is byte-identical to what the human typed.
- [x] The Vorno desktop app is not required for a run to complete.
- [x] `git diff --stat packages/ apps/` is empty for this SUV's PR.

## Status log

- `2026-08-23` — created in `planned/`
- `2026-08-23` — moved from `planned` to `in-progress`: Starting P3: console-side CLI dispatch replacing the deep-link handoff. Orchestrated from session 260823-true-meadow.
- `2026-08-24` — moved from `in-progress` to `done`: Landed on console branch plan-043-p3-p6-work-surface (039f24d + anchoring fix 6c92fd2). Verified by the orchestrator end to end: 28 server tests green; browser e2e — follow-up dialog dispatched a real headless run, output streamed live into the UI mid-flight (state running, growing log), final state succeeded (exit 0) in 9.1s with the model reply visible; record carries exitCode/state/durations, feedback stored byte-identical (verified on disk); runs use a dedicated CRAFT_CONFIG_DIR (~/.craft-agent-roadmap-runner) with symlinked credential vault — live ~/.craft-agent/config.json hash-identical before/after; desktop app never involved; zero diff under packages/ or apps/. Deep-link submission path removed. Verification surfaced a second anchoring defect (inline-tag whitespace in the projection) — fixed, LEARNING-064. Vault OAuth expiry finding recorded for PLAN-039.
- `2026-08-24` — `related:` completed with both edges this record already sits on the far side of: SUV-0008 (the reconciliation loop rides this dispatch path — added as the reverse of the edge SUV-0008 now carries) and SUV-0006, which had claimed SUV-0005 one-sidedly since it landed. No scope change; the record stays `done`. Its dispatch path carried the reconciliation loop's first live run the same day.
