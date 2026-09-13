---
id: SUV-0068
title: Discard a half-built backend on failed init
status: planned
plan: PLAN-054
direction: DIR-03
owner: jh
created: 2026-09-13
related: [SUV-0067]
blocked-by: [SUV-0067]
---

# SUV-0068 — Discard a half-built backend on failed init

## Goal

Never leave a backend assigned to a session unless its initialisation completed,
so a failed init costs one error rather than permanently degrading the session.

## The defect

Pre-existing and **verified present on `main`** — not introduced by the Pages
program or by SUV-0066.

If the build throws between
`managed.agent = createBackendFromResolvedContext(...)`
(`packages/server-core/src/sessions/SessionManager.ts:5032`) and
`managed.agentReadyResolve?.()` (`:5409`) — which is exactly where `postInit` is
awaited (`:5077`) — the half-built backend **stays on the session**.

The consequences compound on every later send, because the guard that would rebuild
it is `if (!managed.agent)`, and `managed.agent` is truthy:

- `postInit` is skipped
- the browser-pane wiring is skipped
- the permission handler is skipped
- `agentReady` never resolves, so title generation waits forever

The session is not wedged the way SUV-0067 wedges it — it keeps accepting work — but
it runs permanently without the wiring that failed to attach, and nothing ever
retries.

## Scope

- Assign the backend to the session only after initialisation completes, or clear
  the assignment on any failure path between construction and ready-resolution.
- Settle or reject `agentReady` on the failure path so nothing waits forever.
- Ensure the next send rebuilds cleanly rather than reusing the discarded backend.

## Dependencies

Blocked by SUV-0067. Turn ownership must be correct first, or the teardown added
here has no defined finalisation path to route its failure through.

## Acceptance

- [ ] A throw between backend construction and ready-resolution leaves no backend
      assigned to the session.
- [ ] `agentReady` settles on that path; title generation does not hang.
- [ ] The next send after a failed init performs a full construction including
      `postInit`, browser-pane wiring, and permission-handler attachment.
- [ ] Regression coverage for a `postInit` throw specifically, since that is the
      awaited call inside the exposed span.

## Status log

- `2026-09-13` — created in `planned/` from a finding made while investigating
  SUV-0067. Confirmed pre-existing on `main`; deliberately scoped out of
  `0.22.0-beta.1`.
