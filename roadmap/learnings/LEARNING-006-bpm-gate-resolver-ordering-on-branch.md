---
id: LEARNING-006
title: Browser-pane gate and resolver disagree when a session runs preflight before registration
date: 2026-06-28
status: active
component: server-core / sessions / browser-pane
related-plans: []
related-decisions: []
---

# LEARNING-006 — BPM gate and resolver disagree when preflight runs before session registration

## Signal

Creating a branch from the **web / headless client** (no co-located Electron
browser-pane manager) failed with:

```
Could not create branch: Browser pane manager unavailable despite passing the gate — this is a bug.
```

The inner throw is `SessionManager.getOrCreateAgent`:

```ts
// packages/server-core/src/sessions/SessionManager.ts (browser-pane wiring)
if (this.browserPaneManager || this.rpcServer) {        // the "gate"
  const bpm = this.getBrowserPaneManagerForSession(sid)
  if (!bpm) {
    throw new Error('Browser pane manager unavailable despite passing the gate — this is a bug.')
  }
}
```

Local Electron was unaffected; only the remote-bridge path (web "II") hit it.

## Root cause

A two-condition disagreement between the **gate** and the **resolver**:

- The gate passes when `browserPaneManager || rpcServer` is truthy.
- `getBrowserPaneManagerForSession(sid)` short-circuits to the local BPM when
  one exists; otherwise (remote-bridge path) it builds a
  `RemoteBrowserPaneManager`, but **only if `this.sessions.get(sid)` finds the
  session** — it needs `session.workspace.id`. If the session isn't registered
  yet, it returns `null`.

`createSession` ran the branch **preflight** (`getOrCreateAgent` +
`ensureBranchReady`, for `branchContextStrategy === 'sdk-fork'`) **before**
inserting the new session into `this.sessions` (the `this.sessions.set(...)` sat
~40 lines *after* the preflight block). So on the remote path the gate passed via
`rpcServer`, but the resolver couldn't find the not-yet-registered session →
`null` → throw → surfaced to the user as "Could not create branch".

Corroborating evidence the late registration was a regression, not intent: the
preflight failure handler already called `deleteFromRuntimeSessions(id)` /
`this.sessions.delete(id)` in its rollback — a no-op against a session that was
never inserted. The rollback was written assuming the session was already in the
map during preflight.

The local path masked it: `getBrowserPaneManagerForSession` returns the local
BPM before any `this.sessions` lookup, so Electron never exercised the resolver's
session-lookup branch during preflight.

## Fix

Register the session in `this.sessions` as soon as it is constructed, **before**
the branch preflight — and move mode-manager init ahead of registration so the
invariant "a session visible in `this.sessions` has its permission mode
initialized" holds across the preflight await:

```ts
// after createManagedSession(...), before the `if (isBranch)` preflight block:
setPermissionMode(storedSession.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
if (managed.previousPermissionMode) hydratePreviousPermissionMode(storedSession.id, managed.previousPermissionMode)
this.sessions.set(storedSession.id, managed)   // <-- was ~40 lines later, after preflight
```

The single late `this.sessions.set(...)` was removed. This also makes the
rollback's `deleteFromRuntimeSessions` effective.

## Recurrence

Any time a code path **gated** on `(browserPaneManager || rpcServer)` runs during
session construction before `this.sessions.set`. New eager-preflight paths (other
branch strategies, pre-warming, validation handshakes) that call
`getOrCreateAgent` early are the prime candidates. The bug is invisible to local
Electron and to any test that mocks `getOrCreateAgent` — which is exactly why the
existing `session-branch-rollback.isolated.ts` suite never caught it.

## Prevention

- Regression test added in `apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts`:
  asserts the child session is already in `this.sessions` at the moment
  `getOrCreateAgent` runs during preflight (fails against the pre-fix ordering).
- Contract tests added for the gate↔resolver invariant: with `rpcServer` set and
  no local BPM, `getBrowserPaneManagerForSession` returns `null` for an
  unregistered session and a `RemoteBrowserPaneManager` once registered.
- Rule of thumb: **a gate and the thing it gates must agree on preconditions.**
  If the gate is `(localBpm || rpcServer)` but the resolver also requires the
  session to be in `this.sessions`, then "session is registered" belongs in the
  gate's mental model — keep registration upstream of anything that can trip it.
- Note: `apps/electron` tests are **not** run in CI (`validate-pr.yml` excludes
  the app); this guard runs only via local `bun run test`. The core fix itself is
  covered by the CI `server-core` typecheck.

## References

- `packages/server-core/src/sessions/SessionManager.ts` — `createSession`,
  `getBrowserPaneManagerForSession`, `getOrCreateAgent` browser-pane wiring.
- `packages/server-core/src/domain/session-branch-cleanup.ts` — rollback whose
  `deleteFromRuntimeSessions` assumed early registration.
- `packages/server-core/src/sessions/__tests__/host-client-fallback.test.ts` —
  sibling browser-host resolution contract test.
