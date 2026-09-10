---
id: SUV-0058
title: Enable Pages per workspace with navigator coexistence
status: planned
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

- [ ] Existing and new workspaces resolve Pages as disabled until their own
      persisted setting is enabled.
- [ ] Settings changes persist and every locale has the required Pages-setting
      labels; disabled UI does not advertise authoring or navigation.
- [ ] RPC, tool, scheduler, and broker tests prove that disabled Pages cannot
      author, refresh, lease, or perform privileged work in desktop or WebUI.
- [ ] Delete, unpublish, and revoke remain available while disabled and are
      covered by cleanup-path tests.
- [ ] Projects, Pages, Workbench, Artifacts, sessions, route parsing, and
      mobile/desktop navigation coexist in focused tests.
- [ ] No path defaults to Craft sharing infrastructure when Pages is disabled.

## Status log

- `2026-09-10` — created in `planned/`; starts only after the upstream merge
  establishes the actual Pages surface.
