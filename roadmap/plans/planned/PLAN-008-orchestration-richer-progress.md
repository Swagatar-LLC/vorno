---
id: PLAN-008
title: Orchestration panel — richer per-step/phase progress (additive protocol)
status: planned
direction: DIR-03
owner: jh
created: 2026-06-08
updated: 2026-06-08
related:
  - PLAN-007-orchestration-activity-panel.md
blocked-by: []
---

# PLAN-008 — Orchestration panel: richer per-step/phase progress (additive protocol)

> Phase 2 of the orchestration/activity panel. Phase 1 (PLAN-007, merged via PR #34) is purely
> client-derived and shows active/completed items with elapsed time, status, and child-step counts.
> This plan adds *richer* progress — phases, step counts, percent — which requires surfacing data
> that does not cross the wire today, done **additively** so wire-compat holds.

## Goal

Surface per-phase / per-step / percent-complete progress for subagent and background orchestration work in the existing `OrchestrationPanel`, via additive optional `SessionEvent` fields only — no union version bump, no channel rename, no breaking change.

## Scope (stub — to be expanded before work starts)

- Backend: extract richer subagent/workflow progress in `ClaudeEventAdapter` / `tool-matching.ts` where the SDK exposes it (e.g. nested step counts, and any `Workflow`/`/workflows` phase signal if/when consumable).
- Protocol: add an **optional** `progress?: ProgressMarker` (phase name, currentStep/totalSteps, percent, message) to the existing `task_progress` (and possibly `tool_start`) `SessionEvent` variants in `packages/shared/src/protocol/dto.ts`. Optional/nullable only; unknown fields ignored by upstream parsers.
- Client: thread the new field through the event-processor and `orchestrationItemsAtom`; render progress bars / phase labels in `OrchestrationPanel` (and its default item renderer). Reuse the DIR-02 item-renderer registry seam added in PLAN-007.
- Tests: derivation + render; round-trip test confirming an event carrying `progress` is accepted and that a client ignoring it still works.

## Non-goals

- Any breaking protocol change, new RPC channel, or `MessageEnvelope` field.
- The full tldraw Observatory app (`apps/observatory/`) — still the DIR-03 north star.
- Pause/resume/priority control of subagents.

## Approach

Option A from the PLAN-007 research: additive optional metadata on existing `SessionEvent` types. Add a `compatibility.md` audit-log entry for the new optional field. Confirm upstream parsers drop the unknown field (round-trip test). Gate any UI behind the existing orchestration feature flag.

## Acceptance

- [ ] `ProgressMarker` defined; added as optional field on the chosen `SessionEvent` variant(s).
- [ ] Backend populates it where SDK data exists; absent otherwise (no fabricated progress).
- [ ] `OrchestrationPanel` renders phase/step/percent when present; falls back to Phase 1 display when absent.
- [ ] No new/changed channels or envelope fields; `packages/shared/src/protocol/` diff is additive-optional only.
- [ ] `compatibility.md` audit-log entry added; round-trip/unknown-field test added.
- [ ] CI green.

## Open questions

- Which SDK signal actually carries phase/step data we can trust (vs. inferring from child tool counts)? Verify against current `@anthropic-ai/claude-agent-sdk`.
- Attachment point: `task_progress` only, or also `tool_start` for subagent Tasks?
- Should percent be backend-computed or left to the client to derive from currentStep/totalSteps?

## Status log

- `2026-06-08` — created in `planned/` as the Phase 2 stub, after PLAN-007 Phase 1 merged (PR #34).
