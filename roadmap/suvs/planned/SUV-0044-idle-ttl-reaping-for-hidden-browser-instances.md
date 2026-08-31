---
id: SUV-0044
title: Idle TTL reaping for hidden browser instances
status: planned
plan: PLAN-047
direction: DIR-05
owner: jh
created: 2026-08-30
updated: 2026-08-31
related: []
blocked-by: []
---

# SUV-0044 — Idle TTL reaping for hidden browser instances

## Goal

Hidden, unbound session-owned browser windows are destroyed after a
per-workspace idle TTL instead of accumulating for the life of the app.

## Scope

- Reuse the PLAN-038 idle-sweep pattern: a minute tick in the Electron main
  process destroys instances that are hidden, unbound, session-owned, and
  idle past the TTL.
- **Reap-eligibility predicate, stated exactly.** Neither mutable ownership
  field can carry it: turn-end unbinding flips `ownerType` to `'manual'`
  while retaining `ownerSessionId`, and `bindSession` stamps
  `ownerSessionId` onto a user-opened window a session adopts — so keying
  on either would miss former session windows or reap adopted user windows.
  Instead, `BrowserInstance` records its **create-time origin** as a new
  immutable field (`sessionCreated: boolean`, set in `createInstance` from
  the creation `ownerType`, never rewritten by bind/unbind). Eligible ⇔
  `sessionCreated` **and** `boundSessionId === null` **and** not visible
  **and** idle past TTL. A user-opened window is never eligible, even after
  sessions have adopted and released it.
- Quiescence guards: never reap a visible window, a bound window, or one
  with in-flight work — network activity, downloads, **or an active browser
  command against the instance (`executeJavaScript`, CDP operations, any
  dispatched `browser_tool` action)**. Concretely: a per-instance in-flight
  operation count the command dispatch path increments/decrements and the
  sweep consults; any completed operation also resets the idle clock.
  Destroy-during-command is the exact race SUV-0043 removes — the reaper
  must not reintroduce it.
- Per-workspace TTL setting on the existing `workspaceSettings:*` surface
  (default aligned with `idleAgentTtlMinutes` semantics; `0` = never).
- Manual windows (per the predicate above: `sessionCreated === false`,
  i.e. user-opened at creation) are exempt entirely — adoption by a session
  never revokes the exemption.
- Out: on-disk partition data cleanup (retention untouched), and any change
  to the close-intercepts-to-hide behavior for live windows.

## Acceptance

- [ ] A hidden unbound session window is destroyed after the TTL elapses;
      the sweep log names the instance and reason (test with fake timers).
- [ ] Bound, visible, active-download, or mid-command (in-flight op count
      > 0) windows survive the sweep (tests).
- [ ] A session-created window unbound at turn end (`ownerType 'manual'`,
      `ownerSessionId` retained) IS reaped; a user-opened window is NOT —
      including after a session adopted and released it (tests pin the
      predicate on `sessionCreated`, not on the mutable ownership fields).
- [ ] TTL `0` disables reaping (test).
- [ ] Setting is readable/editable via the existing per-workspace settings
      surface with no new IPC channels.

## Status log

- `2026-08-30` — created in `planned/`
- `2026-08-31` — Greptile review (PR #186): reap-eligibility predicate made
  explicit (`ownerSessionId`, not `ownerType`, is the session-owned signal
  after turn-end unbind); quiescence contract extended to in-flight browser
  commands via a per-instance op count.
- `2026-08-31` — Greptile P1 follow-up: `ownerSessionId` is also mutable
  (`bindSession` stamps it onto adopted user windows), so the predicate now
  keys on an immutable create-time origin flag (`sessionCreated`); adopted
  user-opened windows are never reapable.
