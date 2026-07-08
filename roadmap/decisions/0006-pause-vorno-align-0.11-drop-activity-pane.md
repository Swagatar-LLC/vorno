---
id: ADR-0006
title: Pause VORNO, align fork to upstream 0.11.x, drop fork Activity pane
status: accepted
date: 2026-07-08
supersedes: []
superseded-by: []
---

# ADR-0006 — Pause VORNO, align fork to 0.11.x, drop the fork Activity pane

## Context

Upstream v0.11.0 (commit `f4e172bf`) landed a large feature surface: a Projects
system, a Kanban/Tasks board with a beta **Conductor** (in-process task
orchestration), a background-agent keep-alive path (`CRAFT_KEEP_BG_AGENTS_ALIVE`),
and Pi SDK 0.80.3 (which moves model/provider discovery to the
`@earendil-works/pi-ai/compat` entrypoint).

The fork had been building its own cross-session **Activity pane** (an
"orchestration panel" — PLAN-007/008/009) plus live model enumeration
(PLAN-010), under the VORNO productization program. Upstream's background-task +
Conductor system now covers the same problem space natively and is the surface
the fork must stay wire-compatible with. Maintaining a parallel fork-only
orchestration UI on top of it is redundant divergence with a growing merge cost.

## Decision

1. **VORNO program paused as of 2026-07-08.** The productization ladder
   (VOR-1..37) is not being actively advanced; the fork instead tracks and
   aligns to upstream 0.11.x.
2. **Drop the fork Activity pane.** PLAN-007 (orchestration/activity panel),
   PLAN-008 (richer progress), and PLAN-009 (phase 1.5) are removed from the
   codebase and archived. Upstream's background-task/Conductor system replaces
   them. Fork-only files removed: `atoms/orchestration.ts`, `OrchestrationRail`,
   and `packages/ui/src/components/orchestration/`.
3. **Pause PLAN-010 (live model enumeration).** Archived, not deleted from
   research history. The one code remnant (Pi driver OpenAI-catalog enrichment)
   is retained but realigned to the SDK 0.80.3 `/compat` import.
4. **Retained fork features** (explicitly kept through the 0.11 merge):
   - Token-usage / context-window indicator (PLAN-002 UI, PLAN-003 configurable
     thresholds) — `ContextUsageIndicator`, `useTokenUsageThresholds`, and the
     `tokenUsageThresholds` / `tokenUsageModelOverrides` protocol DTO fields.
   - Subprocess-env security contract in `agent/options.ts`
     (`DISABLE_GROWTHBOOK=1` pin, `delete env.CLAUDECODE`, Bedrock-routing
     strips) — see LEARNING-008.
   - Config-dir isolation (`~/.vorno-agent`, ADR-0005).
   - Branding gate (VOR-3) and the visible FORK badge.
   - Fast mode (PLAN-006).
5. **`CRAFT_KEEP_BG_AGENTS_ALIVE` default is left ON**, matching upstream's
   shipped behavior. A user-facing settings toggle for it will come in a
   separate PR (tracked as follow-up), not this alignment merge.
6. **Security fixes will be contributed upstream** where they are not
   fork-identity concerns; **branding changes are withheld** (fork-only).

## Consequences

- The fork's renderer no longer ships a cross-session orchestration UI; the
  background-task chip bar (ActiveTasksBar) reverts to upstream's terminal-status
  + linger + orphan-backstop model.
- Merge surface **shrinks** — the orchestration files that previously widened
  the delta are gone; the fork delta is now dominated by branding, config-dir
  isolation, the token indicator, and the subprocess-env security keeps.
- Wire compatibility is unaffected: no `MessageEnvelope`/`AgentEvent`/channel
  changes originate from this decision. Upstream's new wire surface
  (protocol/dto, channels, events, routing, `tasks/`) is adopted as-is; see the
  compatibility audit entry for v0.11.0.
- VORNO plans remain in `roadmap/plans/archived/` for research reference; if the
  program resumes, they are the starting point but must be re-evaluated against
  whatever upstream ships by then.
