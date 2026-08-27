---
id: SUV-0023
title: Compress tool outputs in the agent session loop
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
related: []
blocked-by:
  - SUV-0018-resolved-config-drives-the-headroom-boundary.md (sessions must already hold a config-driven adapter)
---

# SUV-0023 — Compress tool outputs in the agent session loop

## Goal

Make the agent session loop pass tool outputs through the session's
`HeadroomAdapter` so compression is actually active in enabled workspaces, with
originals retrievable through the adapter.

## Scope

- Call sites in the `packages/shared` session loop: tool outputs (the dominant
  context consumers) go through `adapter.compress()` before entering session
  context, and each compressed item carries a retrieval handle.
- All calls go through the SUV-0015 boundary — no new SDK imports.
- Disabled workspaces take the no-op path and behave byte-identically to today.
- Deliberately out: Conductor node dispatch (SUV-0024), any UI affordance for
  retrieval (SUV-0026), and stats surfaces (SUV-0027/0028).

## Acceptance

- [x] In a Headroom-enabled workspace, tool outputs pass through `adapter.compress()` before entering session context, asserted by an integration test using a representative large tool output.
- [x] Each compressed context item carries a retrieval handle, and `adapter.retrieve()` on that handle returns the byte-identical original, asserted by a round-trip test.
- [x] With Headroom disabled, session context is byte-identical to pre-SUV behavior — a test compares transcripts with and without the change on the no-op path.
- [x] The SUV-0015 import guard still passes: no file outside the boundary module imports the Headroom SDK.
- [x] Existing session persistence/replay tests pass unchanged with compression active.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-27` — **implemented** on `plan/plan-040`. The adapter SUV-0018 gave
  every session now has its first caller.

  **What landed**

  - `headroom/tool-output.ts` — `compressToolOutput(adapter, {toolCallId,
    toolName, content})`. Wraps one tool result as a single `role: 'tool'`
    message, calls `adapter.compress()`, and returns the text to put in context
    plus a handle. No SDK import; the boundary gate still finds exactly one
    importer.
  - `agent/tool-result-context.ts` — `prepareToolResultForContext()`, the
    session loop's tool-result ingest step, **extracted** from the inline block
    in `claude-agent.ts`. Runs the pre-existing large-result guard, then
    compresses. Returns `null` for "unchanged", which is precisely the control
    flow the guard's own `null` had, so the loop below it is untouched.
  - `claude-agent.ts` — the inline guard block is now one call to that function.
  - `AgentEvent.tool_result` gained optional `headroomHandle?: string`, present
    only on genuinely compressed items.

  **Decisions worth stating, because a reader will expect otherwise**

  - **Compression runs *after* the large-result guard, not before.** The guard's
    replacement is what the model actually reads, so it is what is worth
    shrinking; compressing the pre-guard text would spend a service call on
    content about to be replaced by a file reference. It also means the case
    compression now covers is the dominant one — the many results that sit
    *below* the guard threshold and today enter context verbatim.
  - **A compressed response is refused unless it issues exactly one retrieval
    handle.** This is the strict reading and it is deliberate. The carrier is one
    handle on one context item, so it can only make the round-trip promise for a
    response whose single handle covers the whole original. Accepting a
    multi-handle response and taking `handles[0]` would ship compressed content
    whose `retrieve()` returns a *fragment* dressed as the original — the
    fabrication failure in its most damaging form. Widening the carrier to a
    handle list is real follow-up work, most naturally alongside SUV-0026.
  - Three more refusals, all failing towards pass-through: a response that isn't
    exactly one `role: 'tool'` message, one answering a different `toolCallId`,
    and empty input content.
  - **No branch on `adapter.kind`.** The no-op adapter is called like any other;
    "Headroom is off" is expressed by which adapter the session holds, never by
    a call site deciding for itself. That is what makes the disabled path
    byte-identical without a special case.
  - `compressToolOutput` catches anyway, despite the contract forbidding throws.
    A context-compression bug must not be able to fail a turn.

  **Verified (red first, then green)**

  - The five compression assertions were watched fail against a temporary
    guard-only `prepareToolResultForContext`: **10 pass / 5 fail**. With the real
    implementation: **15 pass / 0 fail**.
  - `cd packages/shared && bun test` — 3568 pass / 20 skip / **1 fail**. The one
    failure is `headroom/__tests__/session-adapter.test.ts`
    ("finds no call site building an adapter implementation for itself") and it
    names its cause: `packages/server-core/src/tasks/TaskRunner.headroom.test.ts`,
    an **untracked SUV-0024 file from a concurrent worker in this checkout**. Not
    in this diff, not this SUV's to fix — none of the four files touched here
    reference `SdkHeadroomAdapter` or `createNoopHeadroomAdapter`.
  - `cd packages/server-core && bun test` — 355 pass / 0 fail
  - `cd apps/server && bun test` — 196 pass / 0 fail
  - `bun run typecheck` — clean
  - `bun run lint:headroom-boundary` — `headroom-ai` still imported only by
    `packages/shared/src/headroom/sdk-adapter.ts`
  - `bun run lint:branding` — clean
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv0023-build-check --no-splitting` — 3401 modules
  - `cd apps/electron && bun test` — 1090 pass / **19 fail**, all pre-existing on
    this branch and unrelated (RPC channel-count drift 357→372, BrowserPaneManager,
    TriggerServerSupervisor); `git status` shows no modification under
    `apps/electron`.
  - `bun run lint` — fails at `lint:ipc-sends` / `lint:tool-name-checks`, whose
    shell scripts (`scripts/check-raw-sends.sh`, `scripts/check-task-tool-checks.sh`)
    **do not exist in the repo**. Pre-existing. `lint:shared` reports 5 errors, none
    in the files this SUV touches. `lint` is not one of the ten CI gates.

  **Left alone, deliberately**

  - Conductor node dispatch (SUV-0024), retrieval UI (SUV-0026), stats surfaces
    (SUV-0027/0028).
  - `mcp-pool.ts` and `api-tools.ts` also call `guardLargeResult`, but they are
    tool implementations, not the session loop this SUV scopes. Compressing there
    would be a second, independent call site.
  - The `headroomHandle` field is carried on the event; nothing yet *reads* it.
    That reader is SUV-0026.

- `2026-08-27` — **re-verified from scratch on `plan/plan-040`; the entry above
  is corrected in two places.** The previous verification was rejected for
  evidence that could not be reproduced. No source file changed in this pass —
  the implementation is unchanged at `9bcff769` — but every number below was
  re-measured rather than carried forward, and two prior claims did not survive.

  **Corrections to the entry above**

  1. **The claimed shared-suite failure no longer exists, and its stated cause is
     not checkable.** The entry above reports `bun test` in `packages/shared` as
     3568 pass / **1 fail**, blaming an untracked
     `packages/server-core/src/tasks/TaskRunner.headroom.test.ts` left by "a
     concurrent worker in this checkout". `git status --porcelain` returns empty
     in this checkout, so that file is not present and the claim cannot be
     reproduced either way. Re-run now: **3644 pass / 20 skip / 0 fail**. The
     honest statement is that the shared suite is green, not that a known-benign
     failure was explained away.
  2. **The suite counts differ from the entry above because the tree is at branch
     HEAD, not at this SUV's commit.** `plan/plan-040` now carries SUV-0024
     through SUV-0032 on top of `9bcff769`, so these totals measure the branch,
     not this SUV in isolation. Stated explicitly because the earlier numbers
     read as if they were SUV-0023's alone.

  **Red-then-green, made reproducible**

  The earlier "10 pass / 5 fail" was asserted without a repeatable way to get
  back to red. It is now exact. Replace `prepareToolResultForContext` with a
  guard-only stand-in — the same function with the compression step deleted and
  nothing else, i.e. the pre-SUV inline block — then run the test file:

  - guard-only stand-in → **10 pass / 5 fail** (20 expect() calls)
  - real implementation → **15 pass / 0 fail** (29 expect() calls)

  The five that go red are exactly the five that assert the new behaviour:
  compressed content reaching context, the session model reaching the service,
  the handle existing, the byte-identical round trip, and compression seeing the
  guard's replacement. The file was restored by copy from a `/tmp` backup, not
  by `git checkout --`, and `shasum -a 256` matches the pre-edit file
  (`adb2e48a…`) with `git status --porcelain` empty afterwards.

  **Stated plainly, because it limits what the red proof shows:** the other ten
  tests — the five refusal cases, the retrieval-miss case, and the four
  disabled-path cases — pass in *both* states. That is correct rather than
  weak: they assert pass-through, and pass-through *is* pre-SUV behaviour. They
  guard against regression; they are not evidence that this SUV changed
  anything. Only the five above are.

  **Gates, all re-run in this pass**

  - `cd packages/shared && bun test src/agent/__tests__/tool-result-context-headroom.test.ts` — 15 pass / 0 fail
  - `bun test` (repo root, shared) — **3644 pass / 20 skip / 0 fail**, 211 files
  - `cd packages/server-core && bun test` — **362 pass / 0 fail**, 45 files
  - `cd apps/server && bun test` — **196 pass / 0 fail**, 18 files
  - `cd packages/shared && bun test src/sessions/__tests__/` — **27 pass / 0 fail**
    (acceptance 5: `git show --name-only 9bcff769` confirms this SUV edited no
    test outside its own new file, so these pass *unchanged* with compression active)
  - `bun run typecheck` — clean, exit 0, no `error TS` lines
  - `bun run lint:headroom-boundary` — `✓ headroom-ai imported only by packages/shared/src/headroom/sdk-adapter.ts`
  - `bun run lint:branding` — clean (one stale allowlist entry warned, `apps/viewer/vite.config.ts`, unrelated)
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv0023-build-recheck --no-splitting` — 3403 modules

  **Not re-run, and why:** `bun run lint` still fails at `lint:ipc-sends` /
  `lint:tool-name-checks`. I confirmed the cause directly — `ls` reports both
  `scripts/check-raw-sends.sh` and `scripts/check-task-tool-checks.sh` as "No
  such file or directory". Pre-existing, unrelated to this SUV, and `lint` is
  not one of the ten CI gates. `cd apps/electron && bun test` was not re-run in
  this pass; the entry above reports 19 pre-existing failures there and I am not
  restating that number as verified.

  **Status folder left alone, deliberately.** All five acceptance items check
  out, but this SUV is `blocked-by` SUV-0018, which is still in
  `roadmap/suvs/in-progress/`. Moving this file to `done/` while its declared
  blocker is unfinished is a state change I am not making unilaterally.

- `2026-08-27` — **acceptance item 5 was checked but not actually demonstrated.
  Closed with new tests; every gate re-run.** The previous pass was rejected on
  this item specifically, and the rejection was right.

  **What was wrong**

  Item 5 reads "existing session persistence/replay tests pass unchanged **with
  compression active**". The prior evidence ran `src/sessions/__tests__/`
  (27 tests) and stopped there. That set is neither the whole of what this repo
  calls persistence/replay, nor is compression active anywhere in it — those
  tests never construct a Headroom adapter, so they demonstrated the suite is
  green, not that persistence survives a compressed tool result. The box was
  checked on the wrong evidence.

  Item 3 was *not* wrong: `preSuvBehaviour` (test file, "Headroom disabled
  leaves session context byte-identical") is a genuine differential comparison
  against a real reference implementation of the pre-SUV inline block, not
  merely a pass-through assertion. It is now also asserted at the persistence
  layer — see below.

  **What landed (tests only; no production file changed in this pass)**

  Three tests appended to
  `packages/shared/src/agent/__tests__/tool-result-context-headroom.test.ts`,
  driving the **real** durability path — `messageToStored` →
  `writeSessionJsonl` → `readSessionMessages` → `storedToMessage`, the same
  write and parse a live session reload performs:

  1. *replays a compressed tool result whose handle still redeems the original* —
     with an enabled adapter, the persisted transcript carries the compressed
     text (not the original), the handle survives write/read intact, and
     `adapter.retrieve()` on the **replayed** handle still returns the
     byte-identical original. A handle that did not survive persistence would
     leave a reloaded transcript permanently smaller than the truth with no way
     back.
  2. *writes the compression marker into the JSONL line itself* — asserted
     against the parsed line rather than the mapper's return value, so it fails
     if the field is dropped at serialization rather than at mapping.
  3. *leaves the persisted transcript byte-identical when Headroom is off* —
     the serialized JSONL line with the change equals the pre-SUV line
     byte-for-byte, and does not contain `headroomHandle`.

  The message shape is rebuilt locally rather than imported: `packages/shared`
  sits below `packages/server-core`, so importing `SessionManager` would invert
  the dependency. It mirrors `SessionManager.ts:8252-8325` — result to
  `toolResult`, the three Headroom fields copied as one all-or-nothing set keyed
  off `headroomHandle` — and that citation is what makes it checkable.

  **Red-then-green, reproducible**

  Back up `packages/shared/src/agent/tool-result-context.ts`, replace its body
  with the guard-only pre-SUV stand-in (`guardLargeResult`, then
  `return guarded === null ? null : { ...event, result: guarded }`), run the
  file, restore by `cp` from the backup:

  - guard-only stand-in → **11 pass / 7 fail** (26 expect() calls)
  - real implementation → **18 pass / 0 fail** (42 expect() calls)

  The seven reds are the five from the previous pass plus new tests 1 and 2.
  **New test 3 passes in both states, and that is stated rather than counted as
  proof:** it asserts the disabled path is unchanged, and unchanged *is*
  pre-SUV behaviour. It guards against regression; it is not evidence this SUV
  changed anything.

  Restore verified: `shasum -a 256` of the restored file is
  `adb2e48a2bb584e9f9acc8e97778cf1ae305dbf8da219b4f7e872a6c849ab02a`, identical
  to the pre-edit hash. `git checkout --` was not used (LEARNING-066).

  **Acceptance 5, enumerated instead of asserted.** "Session persistence/replay
  tests" is not a path, so the set was enumerated by sweep and every member run:

  | Set | Result |
  |---|---|
  | `packages/shared` `src/sessions/__tests__/` | 27 pass / 0 fail, 5 files |
  | `packages/shared` `tests/persistence-queue.test.ts` | 3 pass / 0 fail |
  | `packages/server-core` `src/sessions/` (cold-load, durability, midstream queue recovery) | 179 pass / 0 fail, 24 files |
  | `packages/server-core` `src/transport/__tests__/webui-resume-resync.test.ts` | 17 pass / 0 fail |
  | `apps/electron` message/turn-grouping/event parity, session-persistence, session-watcher, reconnect-recovery | 49 pass / 0 fail, 6 files |

  The "unchanged" half: `git show --name-only 9bcff769` lists exactly four
  source files plus this SUV's own new test file and roadmap pages. None of the
  five sets above appears in it, and this pass touched only this SUV's own test
  file.

  **One real coverage gap, reported rather than fixed.**
  `apps/electron/src/main/__tests__/session-message-parity.test.ts:115-130`
  keeps a hand-maintained `expectedKeys` allow-list of every `StoredMessage`
  key, and it does **not** list `headroomHandle` /`headroomOriginalBytes` /
  `headroomCompressedBytes`. It passes today only because its fixture never sets
  them — so the repo's own alarm for "a persisted field nobody covered" is
  silently not covering the Headroom marker, and will red the moment someone
  adds them to the fixture. Not fixed here for two reasons: those three fields
  are `Message`/`StoredMessage` surface added by **SUV-0026**, not by this SUV
  (`9bcff769` touched only `AgentEvent.headroomHandle`); and editing that file
  is precisely what acceptance item 5's word "unchanged" forbids. It belongs to
  SUV-0026. The round trip itself is not unverified — new tests 1 and 2 above
  assert it directly.

  **Gates — all ten CI gates from `validate-pr.yml`, run in this pass**

  - `cd packages/shared && bun test src/agent/__tests__/tool-result-context-headroom.test.ts` — **18 pass / 0 fail**, 42 expect() calls
  - `cd packages/shared && bun test` — **3653 pass / 20 skip / 0 fail**, 211 files
  - `cd apps/server && bun test` — **196 pass / 0 fail**, 18 files
  - `cd packages/server-core && bun test` — **362 pass / 0 fail**, 45 files
  - `bun run test:webui` — exit 0; four segments: **425**, **24**, **327**, **362** pass, 0 fail each
  - `cd apps/viewer && bun test worker/` — **23 pass / 0 fail**
  - `bun run typecheck` — exit 0, no `error TS` lines
  - `bun run test:doc-tools` — **19 tests, OK**
  - `bun run lint:i18n:sorted` / `:parity` / `:coverage` — clean (6 locales, 1992 keys each; 2097 callsites)
  - `bun run lint:branding` — clean (one stale allowlist entry warned, `apps/viewer/vite.config.ts`, pre-existing and unrelated)
  - `bun run lint:headroom-boundary` — `✓ headroom-ai imported only by packages/shared/src/headroom/sdk-adapter.ts`
  - `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv0023-build-3 --no-splitting` — **3403 modules**

  **Not run, and why.** `cd apps/electron && bun test` (the full app suite) was
  not run; the six electron persistence/replay files named above were run
  directly instead. The earlier entry's "19 pre-existing failures" figure is
  still not restated as verified. `bun run lint` is still red at
  `lint:ipc-sends` / `lint:tool-name-checks` — `ls` reports
  `scripts/check-raw-sends.sh` and `scripts/check-task-tool-checks.sh` as "No
  such file or directory". Pre-existing; `lint` is not one of the ten gates.

  **Foreign staged change in this checkout, left untouched.** `git status`
  shows a staged rename `roadmap/suvs/in-progress/SUV-0024-…md →
  roadmap/suvs/done/SUV-0024-…md` that this pass did not make and that was not
  present at session start. It is another SUV's status move from a concurrent
  worker in this checkout. It was **not** committed here — this commit names its
  paths explicitly — and it was not reverted, moved, or stashed. By the time
  this commit landed, that worker had committed the rename itself and the tree
  was clean again, so `git status` no longer shows it; recorded here because a
  verifier reading this entry would otherwise find the observation
  unreproducible.

  **Status folder still left alone.** SUV-0018 is now in `roadmap/suvs/done/`,
  so the declared blocker is clear and this file is movable — but the move is a
  separate act from the fix this pass was asked for, and the `advance` skill
  owns it.
