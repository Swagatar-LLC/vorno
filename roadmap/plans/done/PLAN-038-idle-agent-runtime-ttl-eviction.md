---
id: PLAN-038
title: Idle agent-runtime TTL eviction and dispose-on-archive
status: done
direction: none
owner: jh
created: 2026-08-20
updated: 2026-08-20
related: [PLAN-011]
blocked-by: []
---

# PLAN-038 — Idle agent-runtime TTL eviction and dispose-on-archive

## Goal

Stop the unbounded accumulation of live SDK subprocesses: an idle session's agent
runtime is disposed after a per-workspace TTL (default 60 minutes), and archiving a
session disposes its runtime immediately — while `sdkSessionId` resume keeps the
next message transparent.

## Scope

- Periodic idle sweep in `SessionManager` that calls the existing
  `disposeManagedAgentRuntime` funnel for sessions idle past the TTL.
- Immediate guarded dispose in `archiveSession()`.
- New per-workspace setting `defaults.idleAgentTtlMinutes` (default 60, `0` =
  never evict), editable in Workspace Settings, served through the existing
  `workspaceSettings:get/update` surface (no new IPC channels).
- Turn-end activity stamping so a long turn is not instantly "idle" when it ends.
- Tests for the sweep predicate, the archive dispose, and setting validation.

## Non-goals

- Changing the WS2 keep-alive design (PLAN-011) or its global toggle.
- Evicting sessions with running background tasks — those are exactly what
  keep-alive exists for.
- Any change to `deleteSession` semantics or to automation scheduling cadence.

## Approach

**Why:** every session holds a persistent SDK subprocess (WS2 keep-alive, default
ON). Nothing disposes idle or archived sessions' agents, so scheduled automations
(~25–30 sessions/day) accumulate subprocesses until app quit — observed at 243
live `claude` processes / ~11 cores after 9 days (LEARNING-058).

**Sweep.** `sweepIdleAgentRuntimes()` runs on a `setInterval` started in
`initialize()` (never the constructor; tests construct `SessionManager` directly),
cleared in `cleanup()`, `unref()`d so it cannot hold the standalone host open.
A session is evicted only when ALL hold:

- `agent !== null`, `!managed.isProcessing`, `!managed.agent.isProcessing()`
- `!managed.stopRequested`, `managed.messageQueue.length === 0`
- `!managed.pendingAuthRequestId` (paused-at-auth/plan sessions look idle but a
  subprocess is waiting on the answer)
- `!managed.autoRetryPending`
- no `backgroundTaskRegistry` entry with `status === 'running'` (load-bearing:
  dispose kills keep-alive sub-agents and severs the idle-gap event sink)
- idle longer than the resolved TTL

Disposal goes through the `agentRefreshLocks` serialization (same contract as
`tryRefreshAgentRuntime`) so a sweep can never race a send-path
`getOrCreateAgent`.

**Activity clock.** `lastMessageAt` is stamped only at turn start; add a
`lastActivityAt` stamp on the `setProcessing` true→false transition so idle time
is measured from turn end.

**Dispose-on-archive.** `archiveSession()` performs the same guarded dispose after
persisting. The hourly reaper's own archiving then reaps subprocesses too.

**Setting.** `WorkspaceConfig.defaults.idleAgentTtlMinutes?: number`, seeded from
`config-defaults.json` → `workspaceDefaults` (60) with the
`FALLBACK_CONFIG_DEFAULTS` mirror for headless/CI. Validation in the
`workspaceSettings:update` handler: integer, `0 ≤ n ≤ 10080` (a week); `0`
disables eviction. Resolution mirrors the `permissionMode` idiom:
`wsConfig?.defaults?.idleAgentTtlMinutes ?? globalDefaults.workspaceDefaults.idleAgentTtlMinutes`,
read live per sweep tick so changes apply without restart. UI:
`SettingsNumberInput` on `WorkspaceSettingsPage`, i18n keys in all 7 locales.

## Acceptance

- [x] Idle session past TTL has its agent disposed; next message transparently
      resumes via `sdkSessionId`.
- [x] Sessions with running background tasks, queued messages, pending auth, or
      in-flight turns are never evicted.
- [x] `archiveSession` disposes the runtime under the same guards.
- [x] TTL editable per workspace in Settings; `0` disables; default 60.
- [x] Tests added/updated (sweep predicate, archive dispose, handler validation).
- [x] All nine CI gates green; Greptile 5/5.

## Status log

- `2026-08-20` — created in `planned/`
- `2026-08-20` — moved to `in-progress/` (implementation in this PR)
- `2026-08-20` — shipped in v0.18.0 (PRs #167 merge + #168 lockfile unblock + #169 release); all acceptance boxes verified: eviction + transparent resume covered by 13 tests, TTL setting live in Workspace Settings, Greptile 5/5, feed + docs/changelog publication verified over HTTP. Moved to `done/`.
