---
id: SUV-0051
title: Surface model-list staleness in AI Settings
status: planned
plan: PLAN-050
direction: DIR-03
owner: jh
created: 2026-09-02
updated: 2026-09-02
related: []
blocked-by: []
---

# SUV-0051 — Surface model-list staleness in AI Settings

## Goal

Record refresh outcome on the connection and render it in AI Settings, so a
model list that has stopped updating says so instead of looking current.

## Scope

- `LlmConnection`: add `lastModelRefreshAt` and
  `consecutiveModelRefreshFailures`.
- `ModelRefreshService._doRefresh` (`packages/server-core/src/model-fetchers/index.ts`):
  stamp both on every outcome — success resets the counter, failure increments
  it and leaves the timestamp alone.
- `AiSettingsPage.tsx`: render a staleness indicator when the counter crosses a
  threshold, naming the last successful refresh.
- Provider-agnostic: the fields live on the connection, so Pi/Copilot/OpenAI
  get the same signal for free.

Deliberately out: changing the fallback chain, and any auto-repair or
re-auth prompt. This SUV makes the state legible, nothing more.

## Acceptance

- [ ] `consecutiveModelRefreshFailures` increments on a failed refresh and
      resets to 0 on a successful one
- [ ] `lastModelRefreshAt` only advances on success, so it always answers
      "when was this list last actually correct"
- [ ] AI Settings shows a staleness indicator past the threshold and hides it
      after the next success
- [ ] A never-refreshed connection is distinguishable from a recently
      refreshed one
- [ ] Unit tests cover increment, reset, and the never-succeeded case

## Status log

- `2026-09-02` — created in `planned/`. Origin: an Anthropic OAuth connection
  failed `/v1/models` 702 times over 14 days with no signal beyond a per-attempt
  `WARN`; the frozen picker was only noticed because Fable 5.1 shipped.
