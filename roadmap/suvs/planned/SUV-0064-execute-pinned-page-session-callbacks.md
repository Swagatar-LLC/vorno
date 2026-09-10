---
id: SUV-0064
title: Execute pinned page session callbacks
status: planned
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-10
updated: 2026-09-10
related: [SUV-0059, ADR-0033]
blocked-by: []
---

# SUV-0064 — Execute pinned page session callbacks

## Goal

Execute a user-approved Page session callback through the existing
workspace-contained session executor without allowing invocation-time targets,
payloads, escalation, or session closure.

## Scope

- Add `session` descriptors as bare triggers with user-approved,
  digest-bound target, action, and body pinned at grant approval.
- Reuse the existing session-action checks, `SessionManager` mutators, canonical
  outcome producer, and closure guards; pages receive no `allowClosed` escape
  hatch.
- Make shared target-session resolution require workspace containment for both
  Page callbacks and the existing webhook executor, closing the known webhook
  exposure rather than creating a Page-only check.

Grant issuance, activation, scripts, and action hardening remain in SUV-0059.

## Acceptance

- [ ] A callback descriptor accepts no invocation-time target, action, or body;
      each is user-approved, digest-bound, and pinned before execution.
- [ ] The shared target-session resolver proves workspace containment for Page
      callbacks and the existing webhook path, with regression coverage for
      cross-workspace targets.
- [ ] Execution reuses the existing session-action and `SessionManager` choke
      points and declares the ADR-0021 Page origin rather than mutating session
      records directly.
- [ ] Callback escalation and every session-close path, including any
      `allowClosed` escape hatch, are refused and covered by closure-guard tests.
- [ ] Approval, rejection, execution, cancellation, timeout, and result use the
      canonical outcomes/audit path without credentials or sensitive pinned
      payloads.

## Status log

- `2026-09-10` — created in `planned/` from reserved SUV-0064; split from
  SUV-0059 so callback execution remains one reviewable PR.
