---
id: SUV-0066
title: Serialize workspace-qualified session persistence with owner receipts
status: in-progress
plan: PLAN-052
direction: DIR-04
owner: jh
created: 2026-09-12
updated: 2026-09-12
related: [ADR-0033, SUV-0064]
blocked-by: []
---

# SUV-0066 — Serialize workspace-qualified session persistence with owner receipts

## Goal

Key every piece of session-persistence state on workspace + session id, serialize
all writes for a key onto one tail, and split "stop these writes" into deletion
and supersede — so a copied workspace cannot delete another's transcript and an
external metadata edit cannot be reverted by a write already in flight.

## Scope

- `packages/shared/src/sessions/persistence-queue.ts` — the unit:
  - `SessionWriteKey` = `sessionWriteKey(resolve(root), sessionId)`, a branded
    JSON tuple. Injective where the session file path is not.
  - One per-key write tail. Every write chains onto it; a shared `.tmp` path
    makes concurrency a correctness problem, not a fairness one.
  - Generation-scoped owner receipts (`enqueueChecked` → `SessionWriteHandle`),
    so a caller learns about the write it made rather than "the latest write".
  - Cancellation as a watermark carrying intent: `cancelForDeletion` discards a
    committed artifact, `supersedePendingWrites` never does. Re-checked at every
    commit boundary, including after the rename.
  - `resolveExternalMetadata` — one merge point, per-field authority
    (app-since-observation > disk-since-our-write > retained observation > local).
  - `lastWrittenHeaderSignature` outlives quiescence; dropped only on deletion.
- `packages/shared/src/sessions/{storage,types,index}.ts` — header passthrough
  for `pendingPlanExecution`, key-aware `saveSession`, exports.
- `packages/server-core/src/sessions/SessionManager.ts` — `writeKeyFor` and all
  13 rekeyed call sites; `applyExternalSessionMetadata` supersedes on the full
  header signature; read-state mirroring; the four pending-plan owners keep the
  managed mirror in step; `managedToSession` omits `pendingPlanExecution`.
- Tests: the checked-persistence suite (shared), the external-metadata supersede
  suite and the pending-plan mirror suite (server-core).

**Deliberately out.** Nothing Page- or callback-shaped: no session descriptor,
executor, grant, bridge, UI, status origin, callback reservation, or
`tryDeliverPageCallback`. This unit compiles and tests standalone on `main` and
exposes only the queue-level API SUV-0064 will consume. The SessionManager-side
adapters over that API (`buildStoredSession`, `enqueuePersistChecked`,
`persistSessionChecked`) are left to SUV-0064, where their second caller appears.

**Not folded in.** `permissionMode` is deliberately not mirrored into memory by
the watcher path — it is a declared-intent mutation with its own event and
ADR-0021 emit rules. Disk keeps the external value via the merge; in-memory mode
stays owned by the mode-change path. Recorded here rather than smuggled in.

## Acceptance

- [x] `packages/shared` and `packages/server-core` typecheck clean; the brand
      forced all 13 SessionManager call sites and 3 in `packages/shared/tests/`.
- [x] Two workspaces holding one session id keep independent snapshots,
      receipts, baselines and observations; a deletion in one cannot unlink the
      other's committed file mid-commit.
- [x] A supersede after the rename KEEPS the file with its content intact; a
      deletion after the rename removes it; neither ordering of the two can undo
      the other.
- [x] `applyExternalSessionMetadata` supersedes on a pure merge-only edit that
      changes nothing in memory, and does not strip the signature baseline.
- [x] `pendingPlanExecution` survives the cold-load projection and an unrelated
      persist; `draftInputSnapshot` appears in no wire projection.
- [x] 12-mutation harness run against the guards: 10 caught as written, 1 more
      after adding the cold-load test, 1 proven unreachable and labelled a
      structural backstop rather than claimed as tested.

## Residuals

- `commitHooks` is a public mutable test seam on a module singleton. Not
  reachable by a Page, a script action, or any RPC — no wire representation —
  but tightening it to a build-stripped seam is recorded, not silently accepted.
  Suites that set it must clear it in `afterEach`.
- The `through` watermark's `Math.max` has no reachable path today; it holds an
  invariant that currently rests on `retireIfQuiescent` dropping `generations`
  and `cancelledThrough` together.
- `retireIfQuiescent`'s failure-evidence guard has no live reader. Kept because
  deleting a record of failure is the wrong default for the next reader; pinned
  as state, not as behaviour.

## Status log

- `2026-09-12` — created in `in-progress/`, extracted from PR #205 as a
  standalone prerequisite of SUV-0064. Id reserved via `refs/suv-ids/SUV-0066`
  (ADR-0030 CAS) after an all-refs floor scan agreeing with the console.
