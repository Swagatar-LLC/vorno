---
id: PLAN-053
title: Customize workspace navigation after Pages
status: planned
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [PLAN-052]
related-suvs: []
blocked-by: []
---

# PLAN-053 — Customize workspace navigation after Pages

## Goal

Give each workspace a tested, coherent way to control navigation order and
visibility only after Pages integration has supplied a stable post-merge
navigation baseline.

## Context

The Phase 1 trace found two divergent order sources in `AppShell.tsx`: the
rendered sidebar literal and `unifiedSidebarItems` for keyboard navigation.
Projects, Workbench, Artifacts, and several children do not currently have the
same keyboard reachability as rendered navigation. The trace is static evidence,
not a runtime reproduction; that distinction is load-bearing.

A simple setting field and sortable UI are feasible, but one canonical
render/mobile/keyboard resolver does not yet exist. Separators are positional
product objects, not merely data: draggable, hidden, or pinned placement are
three different product choices. The same `AppShell.tsx` hunk is also changed
by the upstream Pages merge and the workspace Pages gate.

## Scope

- Reproduce the keyboard-navigation discrepancy against the current post-merge
  Electron build before calling it a defect or selecting its repair.
- Decide separator semantics first, then extract a keyed navigation registry
  with direct tests as its own SUV.
- Reconcile rendered, mobile, and keyboard order through one canonical
  resolver before adding persisted order/visibility configuration and Settings
  controls.
- Preserve today's layout when configuration is absent and tolerate unknown
  future section IDs.

## Non-goals

- Blocking PLAN-052 or `0.22.0-beta.1`; no current-release acceptance depends
  on this plan.
- Restructuring `AppShell.tsx` before the upstream Pages merge lands.
- Reusing `navigation-registry.ts` as though it were a live sidebar registry;
  Phase 1 verified it is not.
- Adding a second way to hide Workbench or Artifacts before proving the existing
  per-workspace flags are insufficient.

## Approach

Sequence after SUV-0057 and SUV-0058. First reproduce the reported keyboard
behavior, then make the separator choice in a small design/decision record.
Only after that should a dedicated extraction SUV create the canonical registry
and test seam; keyboard accessibility reconciliation is independently shippable
before customization settings. The order/visibility setting and sortable UI are
the final slice, not the starting refactor.

## Acceptance

- [ ] The pre-change keyboard-navigation behavior is reproduced or refuted on
      the post-merge Electron build with a recorded result; static analysis is
      not treated as runtime proof.
- [ ] A documented separator decision precedes any arbitrary reorder UI.
- [ ] A dedicated SUV lands the keyed registry and direct AppShell/LeftSidebar
      tests after upstream Pages and its workspace gate are merged.
- [ ] Rendered desktop, mobile, and keyboard navigation derive from one tested
      canonical ordering function before configuration is added.
- [ ] Absent configuration preserves today's post-merge layout, and unknown
      section IDs neither crash nor become silently authoritative.
- [ ] PLAN-052 remains unblocked throughout; no release claim depends on this
      work.

## Status log

- `2026-09-10` — created in `planned/` from the navigation feasibility trace;
  deferred because two release-risk triggers fired and no current release is
  blocked.
