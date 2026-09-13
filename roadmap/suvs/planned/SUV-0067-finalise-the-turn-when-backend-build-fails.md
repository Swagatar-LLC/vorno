---
id: SUV-0067
title: Finalise the turn when backend build fails
status: planned
plan: PLAN-054
direction: DIR-03
owner: jh
created: 2026-09-13
related: [SUV-0068, ADR-0021]
blocked-by: []
---

# SUV-0067 — Finalise the turn when backend build fails

## Goal

Make a throw during agent construction end the turn that owns it, exactly once,
so the session stops showing "processing" forever.

## The defect

`beginTurnFromAdmittedSend` (`packages/server-core/src/sessions/SessionManager.ts:7731`)
takes turn ownership — `isProcessing = true` plus a finalisation deferred — but
everything between it and the chat loop's `try` at `:7883` sits outside every
handler: OAuth refresh, `getOrCreateAgent` (backend construction *and* `postInit`
both live inside it), and the source-server build. A throw there escapes
`sendMessage` entirely. Nobody owns the turn, so nobody ends it.

Reproduced unmocked:

```
isProcessing       true      (wedged; nothing is running)
turnFinalization   present   (no owner exists to resolve it)
flushAllSessions() 5003 ms, then "Session shutdown was not clean"
```

**User-visible consequence:** the session shows "processing" forever until the app
is restarted. `onProcessingStopped` never runs, so the queue never drains — every
later message takes the mid-stream branch and queues behind a turn that is already
dead. Every quit from then on costs an extra 5 s and reports an unclean shutdown.

**No data loss.** The user message is persisted before the ack, and
`flushAllSessions` collects the failure and still runs the final persist. The cost
is the hang and the quit delay.

**Triggers are not exotic:** expired or missing credentials, a broken MCP source in
`buildServersFromSources`, a `postInit` auth-injection failure, the browser-pane
gate throw at `:5110`.

**Partly masked today.** `processNextQueuedMessage`'s `.catch` (`:8726`) and
`attemptAuthRetry`'s `.catch` each call `onProcessingStopped('error')` as
compensation, so the **replay** and **auth-retry** paths recover. The **RPC send
path — a user typing a message — does not.** That is the exposed surface.

## Start here — the repro already exists

Branch `fix/suv-0066-finalizer` at `244e5dc8`, worktree
`/Users/jeffhampton/dev/vorno-suv-0066-finalizer`. **Local only, never pushed.**
Branched from `1409619e` (PR #206 head).

One new file, 221 lines, **zero production lines changed**:
`packages/server-core/src/sessions/turn-finalization-on-build-failure.test.ts`
— 5 tests pinning the turn-lifecycle contract when a send's backend build fails.

**Read the test file as a spec, and note the trap.** Four of the five tests fail
deliberately — they are the before-picture. The fifth —
*"a replayed queued message that fails to build finalises once, not twice"* —
**passes today and must keep passing.** It asserts exactly one `complete` event and
exactly one `emitSessionComplete` for the session. An owner-side fix that finalises
the turn without also handling `processNextQueuedMessage`'s `.catch` at `:8726`
flips that assertion from 1 to 2, and the visible consequence is **two queued
messages entering turns concurrently** — not merely a duplicate event.

## Scope

- Give the span between turn ownership and the chat loop an explicit owner that
  captures the turn token and finalises in its own `finally`, after the async tail.
- Resolve the collision with the two existing compensating callers, so exactly one
  finaliser runs per turn. Either make `onProcessingStopped` idempotent or retire
  the compensators — the choice is the reviewable decision in this SUV.
- Do not broaden into SUV-0066 persistence or into backend teardown (SUV-0068).

## Acceptance

- [ ] A throw in OAuth refresh, `getOrCreateAgent`, backend construction, `postInit`,
      or the source-server build surfaces as an error to the caller, clears
      `isProcessing`, and resolves the finalisation deferred.
- [ ] All five tests in `turn-finalization-on-build-failure.test.ts` pass, including
      the once-not-twice test, which must not have been weakened to get there.
- [ ] No ledger, send-admission, or finaliser leak after the failure; final session
      state is durable.
- [ ] An immediate shutdown after the failure does not consume the drain bound and
      reports a clean shutdown.
- [ ] A stale turn owner cannot resolve a successor turn's finalisation.

## Status log

- `2026-09-13` — created in `planned/` from an unmocked repro captured during the
  SUV-0066 stand-down. Deferred out of `0.22.0-beta.1`: real hang on a plausible
  path, but recoverable by restart, loses no data, pre-existing on `main`, and the
  fix's hard part is the double-finalisation constraint, which needs review time.
