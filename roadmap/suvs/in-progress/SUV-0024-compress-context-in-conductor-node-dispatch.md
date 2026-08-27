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

- `2026-08-27` — **re-verified from scratch on `plan/plan-040`; two numbers in the entry above are
  wrong and are corrected here.** The previous verification was rejected for evidence that could not
  be reproduced. **No source file changed in this pass** — the implementation is unchanged at
  `2c03b035` — but every figure below was re-measured in this session rather than carried forward,
  and nothing is reported that I did not watch a command print.

  **Corrections to the entry above**

  1. **`test:shared` is 3644 pass / 20 skip / 0 fail across 211 files, not "3569 pass".** The
     shared suite is green either way; the stated count was simply not the count.
  2. **`test:webui` is 362 pass / 0 fail across 45 files, not "355 pass".** Likewise green, likewise
     misreported.
  3. **These totals measure branch HEAD, not this SUV in isolation.** `plan/plan-040` carries
     SUV-0025 through SUV-0032 on top of `2c03b035`, so the suite sizes are the branch's. Stated
     because the entry above reads as though the numbers were SUV-0024's alone. `test:server`
     (196 pass / 18 files) and `cd packages/server-core && bun test src/tasks/` (40 pass / 3 files)
     re-measured to exactly what the entry above claims.

  **Red-then-green, reproduced in this session.** In `buildPrompt`, replace
  `const nodeOutputs = await this.contextOutputsFor(node);` with `const nodeOutputs = this.outputs;`
  — the pre-SUV line, nothing else — then run
  `cd packages/server-core && bun test src/tasks/TaskRunner.headroom.test.ts`:

  - pre-SUV line → **3 pass / 3 fail** (11 expect() calls)
  - restored → **6 pass / 0 fail** (23 expect() calls)

  The three that go red are exactly the three asserting new behaviour: compress-on-dispatch
  (`compressCalls.length` 1→0), handles-in-the-run-log (`node-compressed` entries 1→0), and
  compress-once-per-output. Restored by `Edit` reversing the same one line; `git status --porcelain`
  empty and `git diff --stat` empty afterwards, so the tree is byte-identical to `2c03b035`'s content.

  **Stated plainly, because it bounds what the red proof shows:** the other three tests — output
  uncompressed on disk, unreferenced output not compressed, and the whole disabled-path comparison —
  pass in *both* states, and in the red state two of them pass vacuously (nothing compresses, so
  "didn't compress" is trivially true). They guard acceptance 3 against regression; they are not
  evidence that this SUV changed anything. Only the three above are.

  **Acceptance 2 given real teeth (new in this pass).** "Byte-identical" is only meaningful if the
  assertion fails on a one-byte change, which the previous entry asserted but never demonstrated.
  Mutating the fake adapter's store to `m.content.replace(/\r\n/g, '\n')` — deleting a single `\r`
  from `AUDIT_TEXT` — turns that test red, and bun renders the failure as `- Expected - 0 /
  + Received + 0` because the difference is invisible whitespace. That is the case a length or
  normalized comparison would have waved through. Mutation reverted; suite back to 6 pass / 0 fail.

  **Acceptance 4 checked by absence, not by greenness.** `git show --stat --format="" 2c03b035`
  contains no `TaskRunner.test.ts` — the persistence suite is unedited, and it passes inside the
  40-test `src/tasks/` run with compression wired.

  **The commit typechecks on its own** (the failure mode that sank SUV-0026 last round). Verified
  directly, not inferred: `git worktree add --detach /tmp/suv24-check 2c03b035`, root `node_modules`
  symlinked, then `bun run typecheck:ci` → **exit 0** and `bun test src/tasks/` → **40 pass / 0 fail**
  at that commit alone. Worktree removed afterwards (`git worktree remove --force`); it was detached,
  so no second branch was created and no work moved between checkouts.

  **Gates, all re-run in this pass, exit codes captured under `set -o pipefail`**

  - `bun run typecheck:ci` — exit 0
  - `bun run test:shared` — exit 0, **3644 pass / 20 skip / 0 fail**, 211 files
  - `bun run test:server` — exit 0, **196 pass / 0 fail**, 18 files
  - `bun run test:webui` — exit 0, **362 pass / 0 fail**, 45 files
  - `cd packages/server-core && bun test src/tasks/` — **40 pass / 0 fail**, 3 files
  - `bun run scripts/check-headroom-boundary.ts` — exit 0, `✓ headroom-ai imported only by
    packages/shared/src/headroom/sdk-adapter.ts`
  - `bun run scripts/check-branding.ts` — exit 0, clean (warns one stale allowlist entry,
    `apps/viewer/vite.config.ts`, unrelated to this SUV)
  - `bun run lint:i18n:parity` / `lint:i18n:sorted` / `lint:i18n:coverage` — exit 0 each
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check-suv0024
    --no-splitting` — exit 0, `index.js 16.36 MB`

  **Concurrent commits on this branch, disclosed.** `17029b77` (SUV-0023) and `be50716d` (SUV-0029)
  landed from sibling re-verification sessions while these gates ran. `git diff --name-only
  f4989175..HEAD` lists two `.md` files and zero non-markdown files, and neither touches SUV-0024,
  so the code under test was identical before and after and the figures above stand.

  **Status folder left alone, deliberately.** All four acceptance items check out, but this SUV is
  `blocked-by` SUV-0018, which is still in `roadmap/suvs/in-progress/`. Moving this file to `done/`
  while its declared blocker is unfinished is a state change I am not making unilaterally.

  **Not claimed:** this SUV does not close PLAN-040's retrieval acceptance item. It delivers recorded
  handles plus a programmatic `adapter.retrieve()`; the *user-visible* affordance the plan asks for
  is SUV-0026's, and I did not touch UI or retrieval surfacing.
