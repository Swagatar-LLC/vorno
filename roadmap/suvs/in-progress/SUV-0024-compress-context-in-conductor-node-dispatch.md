---
id: SUV-0024
title: Compress context in Conductor node dispatch
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related:
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (same adapter pattern, session-loop side)
blocked-by:
  - SUV-0018-resolved-config-drives-the-headroom-boundary.md (dispatch needs the config-driven adapter)
---

# SUV-0024 — Compress context in Conductor node dispatch

## Goal

Wire the `HeadroomAdapter` into Conductor node dispatch so workflow runs
(PLAN-039) execute with compression active on the context handed between nodes.

## Scope

- Conductor dispatch call sites: node outputs and context carried into
  downstream nodes pass through `adapter.compress()`, with retrieval handles
  preserved in the run record.
- Run-log durability untouched: Conductor persistence (run logs, node outputs)
  keeps storing what it stores today — Headroom manages context, not execution
  state (plan non-goal).
- Deliberately out: session-loop call sites (SUV-0023), benchmarks
  (SUV-0025), and any UI.

## Acceptance

- [x] A workflow run in a Headroom-enabled workspace passes node outputs through `adapter.compress()` before they enter downstream node context, asserted by an integration test over a multi-node workflow.
- [x] Retrieval handles for compressed node context are recorded and `adapter.retrieve()` returns byte-identical originals, asserted by a test.
- [x] With Headroom disabled, workflow dispatch behavior and run records are unchanged from pre-SUV behavior.
- [x] Existing Conductor persistence tests pass unchanged — run logs and node outputs are stored as before.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-27` — implemented on `plan/plan-040`; moved to `in-progress/` (unmerged).

  **Where the compression happens.** `ActiveRun.buildPrompt` — the one place an upstream node's
  output becomes a downstream node's context. `this.outputs` keeps the originals, so persistence,
  the run snapshot and the orchestrator's verification message all read exactly what they read
  before; only the interpolation view is compressed. Only outputs the consuming node actually
  references (`extractRefs`, field refs excluded — those resolve against typed `params`, not text)
  are sent to the boundary: `this.outputs` accumulates every finished node, and compressing all of
  them would ship content to the service that no prompt was going to contain.

  **Reversibility.** A new additive run-log entry, `node-compressed { nodeId, handles, tokensSaved? }`
  (`packages/shared/src/tasks/storage.ts`), records the boundary's retrieval handles. Emitted only
  when the adapter actually compressed, so the disabled path writes nothing new and every existing
  run-log reader (which folds the log through if/else chains) is unaffected. The node output on disk
  is still the uncompressed original — two independent routes back to the bytes.

  **Wiring.** `TaskRunnerDeps.headroom?: HeadroomAdapter | Promise<HeadroomAdapter>`; the RPC handler
  (`handlers/rpc/tasks.ts:runnerFor`) resolves the workspace's effective config once per runner and
  hands over `createSessionHeadroomAdapter(...)` — the same captured-at-start shape a session has
  (SUV-0018). A disabled workspace gets the no-op adapter *through* the factory rather than a branch
  in the Conductor.

  **Found while testing:** two dependants of one node are dispatched in the same `scheduleReady`
  pass, so memoizing the compressed text only on completion let both miss the cache and compress the
  same output twice — duplicate service calls and two handle sets for one output. The memo now holds
  the *promise*, keyed on the source text so a repair re-run recompresses.

  **Red-then-green:** with `buildPrompt` reverted to interpolate `this.outputs` directly, 3 of the 6
  new tests fail (compress-on-dispatch, handles-in-run-log, compress-once-per-output); restored, all
  6 pass. `TaskRunner.test.ts` was not edited.

  Commands: `cd packages/server-core && bun test src/tasks/` (40 pass), `bun run typecheck:ci`,
  `bun run test:shared` (3569 pass), `bun run test:server` (196 pass), `bun run test:webui`
  (355 pass), `bun run scripts/check-headroom-boundary.ts`, `bun run scripts/check-branding.ts`,
  `bun run lint:i18n:{parity,sorted,coverage}`, `bun build apps/server/src/index.ts --target=bun
  --outdir=/tmp/build-check-suv0024 --no-splitting`.

  Deliberately not touched: session-loop call sites (SUV-0023), benchmarks (SUV-0025), UI, and the
  orchestrator's verification message (not node dispatch).
