---
id: PLAN-054
title: Close turn lifecycle gaps around backend init
status: planned
direction: DIR-03
owner: jh
created: 2026-09-13
related:
  - ADR-0021
  - PLAN-031
related-suvs:
  - SUV-0067-finalise-the-turn-when-backend-build-fails.md
  - SUV-0068-discard-a-half-built-backend-on-failed-init.md
blocked-by: []
---

# PLAN-054 — Close turn lifecycle gaps around backend init

## Goal

Make a failure during agent construction end the turn it belongs to, and leave
no half-built backend attached to the session, so a transient credential or
source error costs the user one error message instead of a wedged session.

## Why now

Both defects were found on 2026-09-12 while stopping the SUV-0066 review loop,
by a worker sent to look at something else. Both are **pre-existing on `main`**
and reachable in `0.21.0` today — neither is a Pages regression, and neither
blocks `0.22.0-beta.1`. They are recorded here so the finding is not lost with
the session that produced it.

The shared shape: `beginTurnFromAdmittedSend`
(`packages/server-core/src/sessions/SessionManager.ts:7731`) takes turn
ownership — setting `isProcessing = true` and creating a finalisation deferred —
but the work between it and the chat loop's `try` at `:7883` runs outside every
handler. That span contains OAuth refresh, `getOrCreateAgent` (both backend
construction and `postInit`), and the source-server build. A throw there escapes
`sendMessage` entirely, so no owner exists to end the turn, and separately can
leave a partially constructed backend assigned to the session.

Measured on the unmocked repro:

```
isProcessing       true      (wedged; nothing is running)
turnFinalization   present   (no owner exists to resolve it)
flushAllSessions() 5003 ms, then "Session shutdown was not clean"
```

## Scope

- Give the span between turn ownership and the chat loop an owner that finalises
  its own turn on failure, exactly once.
- Make `onProcessingStopped` safe to reach more than once, or make the existing
  compensating callers stop reaching it — see the constraint below.
- Never leave a backend assigned to a session unless its initialisation completed.

## Non-goals

- Broadening into the SUV-0066 persistence surface. That work is frozen and
  merged; these SUVs touch turn lifecycle only.
- Reworking the shutdown drain bound. The 5 s cost is a symptom of the unfinalised
  turn, not an independent defect.

## The constraint that makes this non-trivial

`onProcessingStopped` is **not idempotent**. A second pass re-emits `complete`,
re-fires the Tasks Conductor seam, and can shift a second queued message into a
concurrent turn.

Two existing callers already invoke it as compensation — `processNextQueuedMessage`'s
`.catch` (`SessionManager.ts:8726`) and `attemptAuthRetry`'s `.catch`. That is why
the replay and auth-retry paths already recover and only the RPC send path — a user
typing a message — is exposed. **Any owner-side fix turns those two compensators
into double-finalisers unless it deals with them in the same change.** The visible
consequence of getting this wrong is two queued messages entering turns
concurrently, which is worse than the hang being fixed.

This is the whole reason the work was deferred rather than rushed into the beta.

## Prerequisites

| Work | Must precede | Reason |
| --- | --- | --- |
| SUV-0067 | SUV-0068 | Turn ownership must be correct before init teardown is changed, or the teardown has no defined finalisation path to use. |

## Acceptance

- [ ] A throw anywhere between turn ownership and the chat loop surfaces as an
      error, clears `isProcessing`, and resolves the finalisation deferred exactly
      once.
- [ ] The two existing compensating callers and the new owner cannot both finalise
      the same turn; proven by a test that counts `complete` events.
- [ ] An immediate shutdown after such a failure does not consume the drain bound
      and does not report an unclean shutdown.
- [ ] A backend whose construction or `postInit` throws is not left assigned to the
      session, and `agentReady` does not hang.

## Status log

- `2026-09-13` — created in `planned/` from two defects found during the
  SUV-0066 stand-down; deliberately scoped out of `0.22.0-beta.1`.
