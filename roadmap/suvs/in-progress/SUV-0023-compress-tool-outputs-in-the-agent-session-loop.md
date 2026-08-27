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
