---
id: SUV-0058
title: Enable Pages per workspace with navigator coexistence
status: done
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0057, ADR-0033]
blocked-by: []
---

# SUV-0058 — Enable Pages per workspace with navigator coexistence

## Goal

Make Pages an off-by-default persisted workspace capability without displacing
Projects, Workbench, Artifacts, or existing session navigation.

## Scope

- Add `defaults.pages.enabled` through workspace config, migration, RPC, and
  Settings with complete i18n; absent configuration resolves to `false`.
- Enforce one host-side Pages gate across Pages RPC/tool callbacks, refresh
  scheduling, thumbnails, and privileged action paths in desktop and WebUI.
- Hide Pages navigation and authoring tools while off; preserve delete,
  unpublish, and grant revocation for safe cleanup in either state.
- Reconcile the upstream Pages route/type/parser/navigation addition with all
  current Vorno navigators; do not begin PLAN-053's registry refactor.

## Acceptance

- [x] Existing and new workspaces resolve Pages as disabled until their own
      persisted setting is enabled.
- [x] Settings changes persist and every locale has the required Pages-setting
      labels; disabled UI does not advertise authoring or navigation.
- [x] RPC, tool, scheduler, and broker tests prove that disabled Pages cannot
      author, refresh, lease, or perform privileged work in desktop or WebUI.
- [x] Delete, unpublish, and revoke remain available while disabled and are
      covered by cleanup-path tests.
- [x] Projects, Pages, Workbench, Artifacts, sessions, route parsing, and
      mobile/desktop navigation coexist in focused tests.
- [x] No path defaults to Craft sharing infrastructure when Pages is disabled.

## Status log

- `2026-09-10` — created in `planned/`; starts only after the upstream merge
  establishes the actual Pages surface.
- `2026-09-10` — moved from `planned` to `in-progress`: implementation began on
  the persisted per-workspace Pages availability boundary.
- `2026-09-10` — moved from `in-progress` to `done`: persisted workspace
  capability, host gates, Settings/i18n, watcher refresh, and focused
  regression coverage are complete.
