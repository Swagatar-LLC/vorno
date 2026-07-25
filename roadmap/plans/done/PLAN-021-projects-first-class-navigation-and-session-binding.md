---
id: PLAN-021
title: Projects as first-class citizens — real session route, filter hygiene, session project picker
status: done
direction: none
owner: jh
created: 2026-07-14
updated: 2026-07-14
related: []
blocked-by: []
---

# PLAN-021 — Projects as first-class citizens

## Goal

Clicking a project shows that project's sessions in a dedicated view; leaving it
via any other navigation fully exits the project scope; and a session can be
added to / moved between / removed from a project directly from the session UI
(picker + keyboard shortcut) — making projects behave like labels and statuses
do today. Target: next point release.

## Problem

Projects were bolted onto navigation as a *sticky filter* rather than a route:

- Labels and statuses are first-class `SessionFilter` kinds with real routes
  (`label/{id}`, `state/{id}`). A project click instead calls
  `handleJumpToProjectSessions`, which writes
  `viewFiltersMap['allSessions'].projects = { [id]: 'include' }` and navigates
  to the bare `allSessions` route (`AppShell.tsx:775`).
- Because `handleAllSessionsClick` (and every other nav handler) only
  navigates and never clears that map entry, the project filter **persists
  invisibly** across all subsequent visits to All Sessions.
- There is no session-level control to set/change/remove a session's project
  (only scattered entry points), and no keyboard shortcut.

## Scope

1. **First-class project session route** — new `SessionFilter` kind
   `{ kind: 'project', projectId }`, route `project/{projectId}[/session/{id}]`,
   full parser/builder coverage, session-list filtering by `meta.projectId`,
   panel title = project name, sidebar child items navigate to it and
   highlight from route state (not filter-map state).
2. **Filter hygiene** — clicking All Sessions explicitly clears any lingering
   `projects` entries in the allSessions view filters (defensive; the sticky
   path is gone once project clicks are route-based). Kanban/task jump paths
   re-point to the new route.
3. **Session project picker** — a toolbar/session control alongside the
   status and permission-mode pickers listing all workspace projects with the
   current one checked plus "No project"; wires to the existing
   `setProjectId` session command. Registered action + default hotkey so it
   is discoverable and rebindable in Shortcuts settings.
4. **Release notes** bullet(s).

## Non-goals

- User-configurable sidebar section reordering (answering feasibility only:
  the sidebar is a hardcoded array in `AppShell.tsx` ~2418–2717; a persisted
  per-workspace order is a straightforward follow-up plan if the maintainer wants it).
- Project CRUD changes, kanban changes, or per-project settings.
- Upstream wire-compat surfaces (this is all renderer/nav; no protocol
  changes).

## Approach

Mirror the `label` filter end-to-end:

- `apps/electron/src/shared/types.ts` — extend `SessionFilter`.
- `apps/electron/src/shared/routes.ts` — `routes.view.projectSessions(id, sessionId?)`.
- `apps/electron/src/shared/route-parser.ts` — prefix `project` in
  `COMPOUND_ROUTE_PREFIXES`, parse case, `buildCompoundRoute` case,
  `convertCompoundToViewRoute` params, `convertParsedRouteToNavigationState`
  case (session-detail param reconstruction included).
- Session list filtering + navigator title: wherever `kind === 'label'` is
  matched, add the `project` case (filter: `session.projectId === projectId`).
- `AppShell.tsx` — `handleJumpToProjectSessions` → `navigate(routes.view.projectSessions(id))`;
  sidebar child `variant` keyed off `sessionFilter.kind === 'project'`;
  All Sessions click clears `projects` from the allSessions filter map.
- Picker: new component modeled on the existing status/mode slot components;
  action id `chat.assignProject`, default hotkey chosen from free bindings in
  `actions/definitions.ts`.

## Acceptance

- [ ] Clicking a project in the sidebar shows only that project's sessions,
      with the project name as the list title and the sidebar item highlighted.
- [ ] Clicking All Sessions (or any status/label/other nav) shows the full
      unfiltered list — no residual project scope, including after app restart.
- [ ] A session can be added to, moved between, and removed from a project
      from the session UI picker; change is visible immediately (color stripe,
      project view membership).
- [ ] Keyboard shortcut opens the project picker for the active session and is
      listed/rebindable in Shortcuts settings.
- [ ] Route round-trips: `project/{id}` and `project/{id}/session/{sid}` parse
      → NavigationState → rebuild to the same string (parser tests updated).
- [ ] Deep link `craftagents://project/...` behaves (same compound-route path).
- [ ] i18n: all new user-visible strings through i18n keys (CI gate).
- [ ] Release-notes bullets in `next.md`.

## Status log

- `2026-07-14` — created in `planned/`; implementation starting immediately
  (the maintainer requested for next point release).
- `2026-07-14` — moved to `in-progress/`.
- `2026-07-14` — implemented: `project/{id}` filter route end-to-end (types, routes, parser, session-list filtering, titles, sidebar highlight), All Sessions clears residual project chips, ProjectBadge + `chat.assignProject` (mod+shift+p) in the input badges row, parser round-trip tests (16 pass). PR #90.
- `2026-07-14` — PR #90 merged to main (all 7 gates green, rebased over #89's release-notes conflict). Remaining: the maintainer verifies acceptance in the next point-release build, then move to done/.

- 2026-07-25 — Shipped and in production; folder-state reconciled `in-progress` → `done` (roadmap status review, session 260724-light-delta).
