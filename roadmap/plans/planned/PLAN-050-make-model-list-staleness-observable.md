---
id: PLAN-050
title: Make model-list staleness observable
status: planned
direction: DIR-03
owner: jh
created: 2026-09-02
updated: 2026-09-02
related: []
related-suvs:
  - SUV-0051-surface-model-list-staleness-in-ai-settings.md (first — the user-visible signal)
blocked-by: []
---

# PLAN-050 — Make model-list staleness observable

## Goal

A user can tell, without reading a log file, that their model list has stopped
refreshing and is no longer what the provider offers.

## Scope

- A staleness signal on the connection in AI Settings: when the model list was
  last successfully refreshed, and whether the most recent attempt failed.
- Escalation after N consecutive failures, rather than a warning per attempt.
- Applies to every fetchable provider, not just Anthropic.

## Non-goals

- Changing the fallback chain itself. `fix/anthropic-oauth-model-refresh`
  already handles the "this credential will never work" case by serving the
  registry; this plan is about the cases that remain silent.
- Auto-repairing a broken connection. The signal is the deliverable; what the
  user does with it is their call.

## Approach

The defect this comes from: an Anthropic OAuth connection failed `/v1/models`
**702 consecutive times between 2026-08-19 and 2026-09-02** and produced
nothing but a `WARN` line per attempt. The model picker was frozen for over two
weeks and the only reason it was noticed is that Fable 5.1 shipped and someone
went looking for it. `ModelRefreshService._doRefresh` logs and returns:

```
handlerLog.warn(`Model refresh [${slug}]: keeping N stale persisted models (live fetch failed)`)
return // Nothing to update
```

That is a loud condition converted into a quiet one. The fix is not more
logging — it is a value the UI can render and a threshold that changes state.

Record `lastModelRefreshAt` and `consecutiveModelRefreshFailures` on the
connection, set them in `_doRefresh`, and read them in `AiSettingsPage`.

## Acceptance

- [ ] A connection whose last N refreshes failed renders a visible staleness
      indicator in AI Settings, naming when it last succeeded
- [ ] The indicator clears on the next successful refresh
- [ ] A connection that has never successfully refreshed is distinguishable
      from one that refreshed successfully an hour ago
- [ ] Tests added/updated
- [ ] Updated relevant docs in `roadmap/` or `docs/`

## Status log

- `2026-09-02` — created in `planned/`. Cut from the Fable 5.1 investigation
  (`fix/anthropic-oauth-model-refresh`), which fixed why the list froze but
  left the silence itself unaddressed.
