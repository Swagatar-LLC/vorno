> **Archived 2026-07-08** — superseded by upstream v0.11.0 background-task/Conductor system; VORNO program paused. Retained for research only.

---
id: PLAN-007
title: Persistent orchestration/activity panel (mini-Observatory)
status: in-progress
direction: DIR-03
owner: jh
created: 2026-06-08
updated: 2026-06-08
related:
  - PLAN-005-webui-tailscale-launcher.md
blocked-by: []
---

# PLAN-007 — Persistent orchestration/activity panel (mini-Observatory)

## Goal

Give the operator a single, persistent, glanceable surface — in both the Electron shell and the mobile/tablet WebUI — that shows live and recently-completed parallel/background agent work (subagent Tasks, background tasks, workflows), so multi-agent runs can be coordinated without scrolling the transcript. A concrete first step toward DIR-03 (The Live Observatory).

## Context / motivating reframe

The `/workflows` live view the user saw is a **Claude Code harness feature**, not something this app surfaces today. In craft-agents-oss, multi-agent orchestration already crosses the wire as discrete signals, but they are **scattered and ephemeral**:

- `task_backgrounded` → `task_progress` (elapsed seconds) → `task_completed` (status, outputFile, summary) — background task lifecycle events.
- `parentToolUseId` on every event ties subagent child tool calls to their parent `Task`/`Agent` tool. The renderer already groups these into collapsible `ActivityGroup` trees in `TurnCard`.
- `BackgroundTask[]` (per-session Jotai atom, `backgroundTasksAtomFamily`) feeds the `ActiveTasksBar` badge row above the input.

The gap: this state lives **inside the scrolling transcript** (ActivityGroups) or in a **transient badge bar** that clears on `task_completed`/session close. There is no stable "what is my fleet doing right now, and what just finished" panel — and nothing that reads well on a phone.

There is **no `Workflow`-tool event** in the backend today (the SDK Workflow/`/workflows` construct is not consumed). So v0.1 builds entirely on the signals already flowing; richer per-phase/per-step progress is a later, additive protocol step.

```mermaid
graph LR
  SDK[Claude Agent SDK stream] --> AD=>EA[ClaudeEventAdapter]
  EA --> AE[AgentEvent / SessionEvent]
  AE -->|sessions:event WS| EP[event-processor]
  EP --> MSG[Message array + ActivityGroups]
  EP --> BT[backgroundTasksAtomFamily]
  MSG --> NEW[orchestrationAtomFamily<br/>NEW derived state]
  BT --> NEW
  NEW --> PANEL[OrchestrationPanel<br/>desktop sidebar / mobile Vaul drawer]
```

## Scope

**Phase 1 — Client-only orchestration panel (no protocol change).** Everything needed already crosses the wire.

- New derived state `orchestrationAtomFamily(sessionId)` in `apps/electron/src/renderer/atoms/` that aggregates, from existing `Message[]` + `backgroundTasksAtomFamily`:
  - Active subagent Tasks (parent `Task`/`Agent` tool messages with `toolStatus='executing'` and their child activity counts/depth).
  - Background tasks (`BackgroundTask[]`: id, type agent|shell, intent, live `elapsedSeconds`).
  - Recently-completed items (last N), with status (completed/failed/stopped), duration, token metrics from `ActivityGroup.taskOutputData`, and `task_completed.summary`/`outputFile`.
- New shared component `OrchestrationPanel` in `packages/ui/src/components/` (so both Electron and WebUI reuse it), rendering an item list: label/intent, status dot (in-flight pulsing / green / red), live elapsed timer, child-step count, and a "View output" affordance reusing the existing `TaskActionMenu` → terminal overlay path.
- **Persistence across turn/session boundaries:** keep completed items in the panel after `task_completed` (the current `ActiveTasksBar` removes them). Decide retention (last 10 per session, or until session close) — completed items move to a "Recent" subsection rather than disappearing.
- **Mounting:**
  - Desktop (≥768px): a collapsible right-side panel slot in `AppShell`/`PanelStackContainer`, reusing `@container/shell` queries and the existing `PanelResizeSash` pattern. Collapse state in a Jotai atom + localStorage.
  - Mobile/tablet WebUI (<768px / `isAutoCompact`): a bottom **Vaul drawer** (`packages/ui/src/components/ui/drawer.tsx`, `direction='bottom'`, `max-h-[80vh]`) with a compact summary pill (e.g. "3 running") in the header/input zone that opens it. Reuses the `MobileAppMenu` portal pattern.
- Feature flag: gate the whole panel behind a fork setting (default on for fork build, off elsewhere) so it ships dark if needed.

**Phase 2 — Richer progress (additive protocol, optional).** Only if Phase 1 proves the surface useful.

- Extend the backend adapter to extract richer subagent/workflow progress when available (phase names, step counts, percent) and surface it via **additive optional fields on existing `SessionEvent` types** (Option A from research — e.g. an optional `progress?: ProgressMarker` on `task_progress`/`tool_start`). No union-version bump, no channel rename; unknown fields are ignored by upstream parsers per `compatibility.md`.
- If/when the SDK exposes a consumable `Workflow` signal (phases/agents from `/workflows`), add an `adaptSystem()` branch and a typed event — still additively.

## Non-goals

- The full tldraw spatial Observatory app (`apps/observatory/`) — that remains the DIR-03 north star; this is the precursor that proves the data model and mobile posture.
- Cross-session / fleet-wide aggregation across multiple sessions (Phase 1 is per-focused-session). Cross-session is a natural Phase 3 once the per-session atom shape is proven.
- Any breaking change to `SessionEvent`, RPC channel names, or `MessageEnvelope` (wire-compat is a hard rule — see `roadmap/upstream/compatibility.md`).
- Pause/resume/priority control of subagents (only existing Stop-for-shells action is reused).

## Approach

1. **Derive, don't re-plumb.** Phase 1 introduces zero new wire traffic. `orchestrationAtomFamily(sessionId)` is a Jotai derived atom reading `sessionAtomFamily` (messages → ActivityGroups via existing `groupActivitiesByParent`) and `backgroundTasksAtomFamily`. This keeps `processEvent()` pure and untouched.
2. **Fix the ephemerality at the atom layer, not the event layer.** Change the consumer of `task_completed` so completed background tasks transition to a "recent/done" state instead of being removed — a small change in the `App.tsx` background-task handler + atom shape, not in the protocol.
3. **Share the view.** `OrchestrationPanel` lives in `packages/ui` and is consumed by the Electron renderer (which is the same React tree the WebUI renders). Responsive behavior via container queries + a Vaul drawer wrapper for narrow viewports — both patterns already exist in the codebase.
4. **Reuse output viewing.** "View output" routes through the existing `TaskActionMenu` terminal-overlay path and `outputFile` from `task_completed`; no new output transport.
5. **Stage protocol changes behind proven need.** Only Phase 2 touches DTOs, and strictly additively (optional fields), with an entry in the `compatibility.md` audit log.

### Key files (from research)

| Area | File |
|---|---|
| Event types | `packages/core/src/types/message.ts` (`AgentEvent`), `packages/shared/src/protocol/dto.ts` (`SessionEvent`) |
| Subagent nesting | `packages/shared/src/agent/tool-matching.ts` (`parentToolUseId`, `detectBackgroundEvents`) |
| Activity grouping | `packages/ui/src/components/chat/turn-utils.ts` (`groupActivitiesByParent`, `ActivityGroup`) |
| Background task state | `apps/electron/src/renderer/hooks/useBackgroundTasks.ts`, `atoms/sessions.ts` (`backgroundTasksAtomFamily`) |
| Current badge UI | `apps/electron/src/renderer/components/app-shell/ActiveTasksBar.tsx`, `TaskActionMenu.tsx` |
| Mount points | `AppShell.tsx`, `PanelStackContainer.tsx`, `packages/ui/.../ui/drawer.tsx` (Vaul) |
| WebUI surface | `apps/webui/`, `packages/server-core/src/webui/http-server.ts`, `apps/webui/src/responsive.ts` |
| Wire-compat rules | `roadmap/upstream/compatibility.md` |

## Acceptance

- [x] `OrchestrationPanel` renders active subagent Tasks + background tasks with live elapsed time and status, on a focused session. (cross-session, focused pinned)
- [x] Completed items persist in a "Recent"/done state (don't vanish on `task_completed`); retention = until session close.
- [x] Desktop: collapsible right panel; collapse state persists across reloads (`orchestrationPanelCollapsedAtom` via `atomWithStorage`).
- [x] WebUI mobile/tablet (<768px): bottom Vaul drawer + summary pill opener; pill lives in the input zone (no overlap), drawer padded for safe-area.
- [x] "View output" opens an output overlay for a selected task (getTaskOutput IPC → CodePreviewOverlay, using `task_completed.outputFile` for the title).
- [x] Phase 1 introduces **no** new `SessionEvent` types, channels, or envelope fields (purely client-derived). `packages/shared/src/protocol/` untouched.
- [x] Behind a fork feature flag (`ORCHESTRATION_PANEL_ENABLED`, default on; `VITE_DISABLE_ORCHESTRATION_PANEL=1` to disable).
- [x] Tests: unit tests for the derivation (`orchestration.test.ts`: active/done partitioning, parent→child counts, cross-session grouping + focus pinning, retention-until-close).
- [x] CI green locally (packages/ui tsc clean; electron tsc introduces no new errors; build check passes; ui + atom tests pass).
- [ ] If Phase 2 attempted: additive optional fields only, `compatibility.md` audit-log entry added. (Phase 2 not attempted.)
- [ ] DIR-03 `related-plans` updated; learning captured if any non-obvious adapter/atom behavior surfaces. (DIR-02 early-seam note added; no non-obvious bug required a LEARNING.)

## Resolved decisions (2026-06-08)

- **Retention:** completed items persist **until session close** (not last-N / not time-windowed). On session close, that session's items drop from the roll-up.
- **Scope:** **cross-session roll-up** from the start. The panel aggregates active + completed orchestration items across *all* open sessions (derived from `sessionIdsAtom` × per-session `backgroundTasksAtomFamily`/messages), grouped by session, with the focused session pinned/highlighted. Validates how cross-session visibility could feel ahead of the full Observatory.
- **Mobile:** bottom **Vaul drawer** confirmed. Must **not overlap** existing components — coordinate with `ActiveTasksBar`/`ChatInputZone`/`MobileAppMenu` z-index and the input zone's safe-area; the drawer's summary-pill opener lives in an existing slot, not floating over content.
- **DIR-02 seam:** the contribution registry (shapes/tools/views) is not built yet, so do **not** build it here. Instead give `OrchestrationPanel` a small **item-renderer registry** (`Map<itemKind, RendererComponent>`) in `packages/ui` with a default renderer, so a future skill-contributed `view` can register a custom renderer for an orchestration item kind. Document this as the contribution seam in the component and reference it from DIR-02.

## Open questions (carried)

- Exact z-order/safe-area contract between the mobile drawer and the input zone — settle during implementation with a prototype pass.
- Whether the cross-session roll-up should also surface sessions not currently open in a panel (history) — out of scope for Phase 1; per-`sessionIdsAtom` (open sessions) only.

## Status log

- `2026-06-08` — created in `planned/` (informed by 4-agent research workflow over backend/event-processing/webui/transport).
- `2026-06-08` — decisions resolved (retention=until session close, cross-session roll-up, Vaul drawer no-overlap, DIR-02 item-renderer seam); advanced to `in-progress/`; implementation delegated to subagent.
- `2026-06-08` — Phase 1 shipped. Added:
  - Shared, framework-pure `OrchestrationPanel` + `DefaultOrchestrationItem` + item-renderer registry (DIR-02 seam) in `packages/ui/src/components/orchestration/`, with `@craft-agent/ui/orchestration` + `/orchestration/types` subpath exports.
  - `orchestrationItemsAtom` (read-only derived) + `buildSessionItems` + collapse/feature-flag atoms in `apps/electron/src/renderer/atoms/orchestration.ts`. Reads `sessionIdsAtom` × per-session `sessionAtomFamily`/`backgroundTasksAtomFamily`; subagent Tasks via `groupActivitiesByParent`, background tasks via the now-persisted `BackgroundTask[]`.
  - Persist-completed change: `BackgroundTask` gained `status`/`completedAt`/`durationMs`/`outputFile`/`summary`; App.tsx `task_completed`/`tool_result`/`shell_killed` handlers transition (not remove); `ActiveTasksBar` filters to running; `useBackgroundTasks.completeTask` added.
  - Mounting: desktop collapsible rail in `AppShell` (`OrchestrationDesktopRail`); mobile bottom Vaul drawer + summary pill in `ChatInputZone` (`OrchestrationMobileDrawer`).
  - Tests in `apps/electron/src/renderer/atoms/__tests__/orchestration.test.ts` (5 pass).
  - DIR-02 "Early seams" note referencing the renderer registry.
  - No protocol changes; `packages/shared/src/protocol/` untouched.
