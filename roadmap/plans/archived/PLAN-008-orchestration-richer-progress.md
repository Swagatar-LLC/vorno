> **Archived 2026-07-08** — superseded by upstream v0.11.0 background-task/Conductor system; VORNO program paused. Retained for research only.

---
id: PLAN-008
title: Orchestration panel — richer per-step/phase progress (additive protocol)
status: planned
direction: DIR-03
owner: jh
created: 2026-06-08
updated: 2026-06-11
related:
  - PLAN-007-orchestration-activity-panel.md
  - PLAN-009-orchestration-panel-phase-1_5.md
blocked-by: []
---

# PLAN-008 — Orchestration panel: richer per-step/phase progress (additive protocol)

> Phase 2 of the orchestration/activity panel. Phase 1 (PLAN-007, merged via PR #34) is purely
> client-derived; Phase 1.5 (PLAN-009) is client-only polish. This plan adds *richer* progress —
> phase labels, step counts, a live one-line activity summary, and (only where honestly knowable) a
> percent — which requires surfacing data that does not cross the wire today, done **additively** so
> wire-compat holds. Investigation completed 2026-06-11 (see Findings); no code written.

## Goal

Surface per-phase / per-step / activity-summary progress for subagent and background orchestration
work in the existing `OrchestrationPanel`, via additive **optional** `SessionEvent` fields only — no
union version bump, no channel rename, no `MessageEnvelope` change.

## Findings (SDK progress-signal investigation — 2026-06-11)

The original open question was: *which SDK signal carries trustworthy phase/step/percent data vs.
inference from child tool counts?* Answer, with citations against the installed SDK
(`node_modules/@anthropic-ai/claude-agent-sdk`, **version `0.3.170`**, confirmed in its
`package.json`):

### What the SDK actually emits

The SDK message union `SDKMessage` (`sdk.d.ts:3651`) includes several **task-scoped** system
messages that we do not fully consume today:

- **`SDKTaskProgressMessage`** (`sdk.d.ts:4033-4053`), `type:'system'`, `subtype:'task_progress'`:
  carries `task_id`, optional `tool_use_id`, `description`, optional `subagent_type`, a
  `usage:{ total_tokens, tool_uses, duration_ms }` block, optional `last_tool_name`, and an optional
  `summary`. The `summary` is an **AI-generated present-tense phrase** (e.g. "Analyzing
  authentication module") gated by the `enableProgressSummaries` option (`sdk.d.ts:1753-1762`):
  "the subagent's conversation is forked every ~30s to produce a short present-tense description …
  emitted on `task_progress` events via the `summary` field." This is the richest real signal.
- **`SDKTaskStartedMessage`** (`sdk.d.ts:4055-4077`): `task_id`, `description`, optional
  `subagent_type`, `task_type`, and **`workflow_name`** ("meta.name from the workflow script (e.g.
  'spec'). Only set when task_type is 'local_workflow'"). This is the only **workflow/phase-name**
  signal — and it exists only for `/workflows`-style local-workflow tasks, not for ordinary
  general-purpose subagents.
- **`SDKTaskUpdatedMessage`** (`sdk.d.ts:4079-4096`): a wire-safe `patch` with
  `status:'pending'|'running'|'completed'|'failed'|'killed'|'paused'`, `description`, `end_time`,
  `error`, `is_backgrounded`. Good for live status, but no step/percent.
- **`SDKToolProgressMessage`** (`sdk.d.ts:4110-4119`), `type:'tool_progress'`: `tool_use_id`,
  `tool_name`, `parent_tool_use_id`, `elapsed_time_seconds`, optional `task_id`. Per-tool heartbeat
  only — no aggregate.
- **`SDKTaskNotificationMessage`** (`sdk.d.ts:4015-4032`): terminal-ish `status` +
  `output_file`/`summary` + optional `usage`. Already consumed.

### What we consume today (and the gap)

`ClaudeEventAdapter` (`packages/shared/src/agent/backend/claude/event-adapter.ts`) dispatches in
`adapt()` (line ~141). It handles `tool_progress` (`adaptToolProgress`, lines **415-460**) — but
only forwards `elapsed_time_seconds` as our internal `task_progress` AgentEvent (lines **424-431**).
It handles `task_notification` (`adaptSystem`, lines **535-552**) → `task_completed`. **Critically,
the adapter has NO case for `subtype === 'task_progress'`, `'task_started'`, or `'task_updated'`** —
confirmed by grep (zero matches). So `SDKTaskProgressMessage.usage.tool_uses`, `last_tool_name`,
`summary`, and `SDKTaskStartedMessage.workflow_name` are **received but dropped on the floor today**.
That untapped `SDKTaskProgressMessage` is the primary attachment point for real progress data.

On the client, `buildSessionItems` (`apps/electron/src/renderer/atoms/orchestration.ts:198-209`)
already sets `childStepCount: group.children.length` — i.e. step count is **derived client-side**
from how many child tool activities have been seen, not reported by the SDK.

### Classification (a) real / (b) derivable / (c) fabrication

| Desired field | Class | Source / evidence |
|---|---|---|
| `phase` (name) | **(a) real, but narrow** | `SDKTaskStartedMessage.workflow_name` (`sdk.d.ts:4069`) — only for `task_type:'local_workflow'`. For ordinary subagents there is no phase; field stays absent. |
| `message` (live activity summary) | **(a) real, opt-in** | `SDKTaskProgressMessage.summary` (`sdk.d.ts:4049`), requires `enableProgressSummaries`. Absent when option off. |
| `totalSteps` | **(c) fabrication — AVOID** | The SDK never declares how many steps/tools a task *will* take. There is no `total_steps`/`num_steps` field anywhere in `sdk.d.ts` (grep confirmed). Do **not** invent it. |
| `currentStep` | **(b) derivable** | `SDKTaskProgressMessage.usage.tool_uses` (a real running count, `sdk.d.ts:4045`) OR the existing client-side `childStepCount`. A monotonically-rising "steps so far", **not** "step N of M". |
| `percent` | **(b/c) — only honest when phase has a denominator** | The only SDK `percentage` fields are **context-window usage**, not task progress (`sdk.d.ts:2880`, `3012-3052` — `SDKControlGetContextUsageResponse` / window pills). With no `totalSteps`, a task percent would be fabricated. **Leave percent absent** unless a future workflow signal supplies a real denominator. |

**Bottom line:** the trustworthy new data is the **live `summary` message** and a **monotonic
"steps so far" count** (`usage.tool_uses`), plus a **`workflow_name` phase label for workflow tasks
only**. A true "step N of M" / percent is *not* available from the SDK and must not be fabricated.

## `ProgressMarker` shape (proposed)

Every field optional; absent = "unknown", which the renderer treats as "fall back to Phase 1
display". `totalSteps`/`percent` are intentionally present in the type but populated **only** when a
real denominator exists (today: never for plain subagents — kept for forward-compat with workflow
tasks).

```ts
// packages/shared/src/protocol/dto.ts (illustrative — NOT applied)

/** Additive, fail-soft progress metadata for an orchestration item. All optional. */
export interface ProgressMarker {
  /** Phase/workflow label. Real only for local-workflow tasks (SDK workflow_name). */
  phase?: string
  /** Monotonic "steps so far" (e.g. SDK usage.tool_uses or client childStepCount). NOT "of M". */
  currentStep?: number
  /** Total steps — populate ONLY when a real denominator exists; otherwise omit. */
  totalSteps?: number
  /** 0–100. Populate ONLY when honestly computable (currentStep/totalSteps); otherwise omit. */
  percent?: number
  /** Live one-line present-tense activity summary (SDK task_progress.summary). */
  message?: string
}
```

### Chosen attachment point(s)

Attach `progress?` to the **existing `task_progress` `SessionEvent` variant** (`dto.ts:202`) — it is
already the per-task heartbeat and is the natural carrier. Add the same optional field to the
**internal `AgentEvent` `task_progress`** (`packages/core/src/types/message.ts:573`) so the adapter
can populate it. We do **not** add it to `tool_start` (`dto.ts:181`): `tool_start` is per-tool, not
per-task, and would duplicate state. (If a future need arises to mark phase at task *start*, prefer a
new optional `progress?` on `task_completed`/a `task_started` event over overloading `tool_start`.)

Additive diff sketch (illustrative — NOT applied):

```diff
 // packages/shared/src/protocol/dto.ts
-  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds: number; turnId?: string }
+  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds: number; turnId?: string; progress?: ProgressMarker }

 // packages/core/src/types/message.ts
-  | { type: 'task_progress'; toolUseId: string; elapsedSeconds: number; turnId?: string }
+  | { type: 'task_progress'; toolUseId: string; elapsedSeconds: number; turnId?: string; progress?: ProgressMarker }
```

The client consumer threads `progress` from the event-processor into `OrchestrationItem` (add
optional `progress?: ProgressMarker` to `packages/ui/src/components/orchestration/types.ts:23-48`,
alongside the existing `childStepCount`), and `DefaultOrchestrationItem` renders phase/step/summary.
Custom/skill renderers get it for free via the **DIR-02 renderer-registry seam**
(`packages/ui/src/components/orchestration/registry.tsx` — `getOrchestrationItemRenderer` /
`registerOrchestrationItemRenderer`), already added in PLAN-007. No panel-structure change needed.

## Wire-compat argument

- **Additive + optional + fail-soft.** `progress?` is a new optional field on an *existing*
  `SessionEvent`/`AgentEvent` variant. No union member added/removed, no discriminant renamed, no new
  RPC channel, no `MessageEnvelope` field. An upstream parser that doesn't know `progress` simply
  **drops the unknown field** and continues — exactly the `AgentEvent`-union commitment in
  `roadmap/upstream/compatibility.md` ("New event types must round-trip through upstream parsers
  (unknown types ignored, not errored)"), here applied at field granularity. A client that ignores
  `progress` renders the Phase-1 view unchanged.
- **Mirrors a precedent we already audited.** This is the same additive-optional-field pattern as
  `BrowserInstanceInfo.workspaceId?` (compatibility.md audit log, 2026-05-28: "nullable, optional …
  old agents and old renderers tolerate missing values. No envelope break.").
- **Round-trip test.** Add a test that encodes a `task_progress` event carrying a populated
  `ProgressMarker`, runs it through the shared codec, and asserts (1) a `progress`-aware consumer
  reads it back intact, and (2) a consumer that strips unknown fields still produces a valid
  `task_progress` event (no throw, `elapsedSeconds` intact). Co-locate with the protocol/codec tests
  (e.g. under `packages/shared/src/protocol/__tests__/`).
- **Audit-log entry (at merge time, not now).** When the implementing PR lands, add a
  `compatibility.md` audit-log row: *"PLAN-008: added optional `progress?: ProgressMarker` to the
  `task_progress` `SessionEvent`/`AgentEvent` variant. Additive/optional/fail-soft; unknown-field
  drop verified by round-trip test. No channel/envelope change."* (No row is added by this
  investigation, since no merge of code happened.)

## Build phases / acceptance

**Phase A — protocol (additive).** Define `ProgressMarker`; add `progress?` to the `task_progress`
variant in `dto.ts` and the matching `AgentEvent` in `packages/core/src/types/message.ts`. Add the
round-trip/unknown-field test. *Acceptance:* `packages/shared/src/protocol/` diff is additive-optional
only; round-trip test green.

**Phase B — backend population (real data only).** In `ClaudeEventAdapter`, add an `adaptSystem`
branch for `subtype === 'task_progress'` (`SDKTaskProgressMessage`) that populates `progress` with:
`message ← summary`, `currentStep ← usage.tool_uses`. Add a `task_started` branch that captures
`workflow_name → progress.phase` for `task_type:'local_workflow'`. **Never** set `totalSteps`/
`percent` unless a real denominator is present. When the SDK gives nothing, omit `progress` entirely.
Consider plumbing `enableProgressSummaries` (`options.ts`) so `summary` is actually emitted. *Acceptance:*
no fabricated values; `progress` absent when SDK data absent.

**Phase C — client render (behind the flag).** Thread `progress` through the event-processor →
`buildSessionItems` → `OrchestrationItem.progress`; render phase label + "N steps" + the live
`message` summary in `DefaultOrchestrationItem`; render a percent bar **only if `percent` present**.
All gated by `ORCHESTRATION_PANEL_ENABLED`
(`apps/electron/src/renderer/atoms/orchestration.ts:53`). Custom renderers inherit `progress` via the
registry seam. *Acceptance:* renders richer progress when present; falls back to Phase-1 display when
absent; no regression with the field omitted.

**Phase D — tests.** (1) derivation: adapter maps a `SDKTaskProgressMessage`/`task_started` into the
right `ProgressMarker`, and emits nothing extra when data is absent; (2) render: panel shows
phase/step/summary when present and falls back cleanly when absent; (3) the Phase-A round-trip test.
*Acceptance:* all green; existing `orchestration.test.ts` still passes.

## Non-goals

- Any breaking protocol change, new RPC channel, or `MessageEnvelope` field.
- Fabricated `totalSteps`/`percent` for tasks that have no real denominator.
- The full tldraw Observatory app (`apps/observatory/`) — still the DIR-03 north star.
- Pause/resume/priority control of subagents.
- Full i18n of the panel (separate plan; the panel is intentionally hardcoded-English per PLAN-009).

## Resolved vs still-open questions

**Resolved by this investigation:**

- *Which SDK signal carries trustworthy phase/step data?* → `SDKTaskProgressMessage` (`summary`,
  `usage.tool_uses`, `last_tool_name`) and `SDKTaskStartedMessage.workflow_name`; all currently
  unconsumed by `ClaudeEventAdapter`. (See Findings.)
- *Is there a trustworthy percent/total-steps?* → **No.** The SDK exposes no task `total_steps`/
  percent; the only `percentage` fields are context-window usage. So `totalSteps`/`percent` must be
  omitted (not fabricated) for ordinary subagents.
- *Attachment point — `task_progress` only, or also `tool_start`?* → **`task_progress` only**
  (per-task), plus the matching internal `AgentEvent`. Not `tool_start` (per-tool). (See chosen
  attachment point.)

**Still open (to decide during implementation):**

- *Backend-computed vs client-derived `currentStep`.* Backend `usage.tool_uses` (authoritative, only
  when SDK emits `task_progress`) vs the existing client `childStepCount` derivation (always
  available). Likely: prefer backend `currentStep` when present, fall back to client `childStepCount`.
- *Should we enable `enableProgressSummaries` by default?* It forks the subagent every ~30s (small
  but nonzero cost). Probably gate behind a setting / the orchestration flag rather than always-on.
- *Future workflow phases.* If/when `/workflows` exposes a step denominator, revisit populating a
  real `totalSteps`/`percent` for `local_workflow` tasks.

## Status log

- `2026-06-08` — created in `planned/` as the Phase 2 stub, after PLAN-007 Phase 1 merged (PR #34).
- `2026-06-11` — **investigation completed; stub finalized (docs-only, no code).** Confirmed SDK
  `0.3.170`. Found the trustworthy signals (`SDKTaskProgressMessage.summary` + `usage.tool_uses`,
  `SDKTaskStartedMessage.workflow_name`) are **received but dropped** by `ClaudeEventAdapter` today
  (no `subtype==='task_progress'/'task_started'` case). Confirmed **no** SDK task percent/total-steps
  exists (the only `percentage` fields are context-window usage), so those stay absent (not
  fabricated). Proposed concrete `ProgressMarker` and chose the existing `task_progress`
  `SessionEvent`/`AgentEvent` variant as the additive, optional, fail-soft attachment point; client
  renders via the PLAN-007 DIR-02 registry seam. Backend-vs-client `currentStep` and default-on
  progress-summaries remain open for implementation.
</content>
</invoke>
