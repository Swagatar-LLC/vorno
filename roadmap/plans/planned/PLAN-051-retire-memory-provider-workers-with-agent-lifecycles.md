---
id: PLAN-051
title: Retire memory-provider workers with agent lifecycles
status: planned
direction: DIR-05
owner: jh
created: 2026-09-05
updated: 2026-09-05
related: [ADR-0031]
related-suvs: []
blocked-by: []
---

# PLAN-051 — Retire memory-provider workers with agent lifecycles

## Goal

Memory-provider workers exit and are reaped whenever their owning agent runtime
is retired, so repeated session lifecycles return process count and RSS to the
clean-launch baseline.

## Context

[Issue #195](https://github.com/Swagatar-LLC/vorno/issues/195) reports 58
`headroom.memory.mcp_server` workers using about 2.63 GiB RSS, with worker count
continuing to rise. The provider cardinality itself follows ADR-0031: each agent
constructs and retains one provider (`packages/shared/src/agent/base-agent.ts:380-392,
426-435`), and the Headroom provider caches one MCP client
(`packages/shared/src/memory/headroom-mcp-provider.ts:234-241,297-329`).

The lifecycle edge is missing. `BaseAgent.destroy()` does not dispose its owned
provider (`packages/shared/src/agent/base-agent.ts:1071-1093`), while
`HeadroomMcpMemoryProvider.dispose()` already closes the cached client
(`packages/shared/src/memory/headroom-mcp-provider.ts:473-483`). `ClaudeAgent`
reaches base cleanup (`packages/shared/src/agent/claude-agent.ts:2943-2980`), but
Pi teardown bypasses it (`packages/shared/src/agent/pi-agent.ts:2377-2401`). The
session manager also has an auth-retry path that drops the agent reference
without disposal (`packages/server-core/src/sessions/SessionManager.ts:6929-6963`)
and a manager shutdown path that does not retire live agents
(`packages/server-core/src/sessions/SessionManager.ts:9962-10004`). Existing
idle/archive/runtime-refresh and deletion paths already attempt agent disposal
(`packages/server-core/src/sessions/SessionManager.ts:3360-3373,3437-3514,
6180-6196`).

## Scope

- Make provider ownership explicit and teardown idempotent: one agent owns one
  provider, and each started worker reaches exited-and-reaped exactly once.
- Route Base, Claude, and Pi destruction/restart through one awaitable cleanup
  contract, including disposal racing an in-flight memory operation.
- Close the session-manager gaps for auth retry and application shutdown while
  preserving the existing idle, archive, refresh, and deletion funnel.
- Add deterministic ownership regressions plus bounded real-process verification.
- Record the root cause and prevention in the private learnings corpus required
  by repository policy.

## Non-goals

- Changing the ADR-0031 provider seam, provider cardinality, memory scope, or
  Headroom database format.
- Pooling workers across agents or adding a process supervisor, threshold change,
  settings surface, telemetry system, or new ADR.
- Fixing unrelated Headroom provisioning or memory quality behavior.

## Approach

Keep ADR-0031's architecture and repair the ownership boundary rather than
sharing or masking workers. Introduce one idempotent, awaitable agent cleanup
path that retires the owned `MemoryProvider`; make every agent and
session-manager abandonment path use it before releasing the agent reference.
Provider cleanup must also serialize with an in-flight probe/save so a late MCP
client cannot appear after disposal.

### Deterministic red/green test

In a hermetic unit test, create a `TestAgent`, replace `_memoryProvider` with a
spy whose async `dispose()` increments a counter, then invoke each supported
agent teardown path on a fresh instance. Capture the pre-fix red result
(`expected 1, received 0` for base teardown); after the fix, await teardown and
assert exactly one disposal, including repeated teardown calls. Add the same
contract test for Pi destruction/restart, then exercise idle eviction, archive,
deletion, runtime refresh, auth retry, and manager shutdown with injected agents;
each abandoned agent must be disposed exactly once. No test may pass by sleeping
or by inspecting only a mock session-manager call.

### Process-count and runtime verification

Use an opt-in integration harness with a unique temporary database and user
scope. Record the clean baseline, start a real Headroom worker through an agent,
record its PID/PPID and RSS, dispose the owner, and poll with a bounded timeout
until that exact PID has exited and been reaped. Repeat ten create/use/dispose
cycles and require the owned worker set and aggregate RSS to return to baseline
after every cycle. Fully quit a production-built Electron run launched with
`bun run electron:start` and require that no worker descended from that Vorno
run survives. Attach red/green test output and redacted before/after process-tree
and RSS evidence to the implementation PR.

### Regression scope

Run the new lifecycle tests; existing memory/provider and agent tests; the
server-core idle/archive/session lifecycle tests; package typechecks; and
`bun run validate:ci`. Exercise memory search/save in the Electron run before
session retirement so verification proves teardown of a started worker, not the
absence of one.

## Rollback

This changes no persisted data or configuration. If teardown causes session
resume, shutdown, or provider-operation regressions, revert the lifecycle change
and its dependent assertions as one unit; retain Issue #195 as open and use the
existing operational mitigation of fully quitting and relaunching Vorno when
worker count grows. Do not raise the process threshold or kill unrelated Python
processes as a substitute.

## Security and privacy

The harness may terminate only PIDs it started and recorded; never use broad
`pkill`/`killall` matching. Use temporary database/user values, keep credentials
out of fixtures and process arguments, and redact local database paths, user
identifiers, and unrelated host processes from committed evidence. The fix must
not add network egress, telemetry, or log memory contents.

## Human review gates

1. Jeff approves this plan's scope and acceptance before it advances or is
   decomposed into SUVs.
2. A reviewer confirms the deterministic red evidence and root cause before the
   implementation fix is accepted.
3. A human reviews the lifecycle diff, redacted process/RSS evidence, regression
   results, and learning reference; all CI must be green before human merge.

## Acceptance

- [ ] The deterministic test is captured red before the fix and green after it;
      Base, Claude, Pi, and every named session-manager abandonment path dispose
      each owned provider exactly once.
- [ ] Disposal waits for or cancels in-flight provider work, closes the MCP
      client, and reaps the exact child without a late replacement process.
- [ ] Ten real create/use/dispose cycles and full Electron quit return owned
      process count and aggregate RSS to the recorded baseline within the bounded
      timeout.
- [ ] The regression scope passes, and the PR contains redacted before/after
      process-tree and RSS evidence.
- [ ] Security/privacy constraints, rollback steps, and all human review gates
      are satisfied.
- [ ] A debugging learning is recorded in `vorno-internal` per repository policy.

## Status log

- `2026-09-05` — created in `planned/` from Issue #195; pending Jeff review.
