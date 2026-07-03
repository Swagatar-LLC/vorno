---
id: LEARNING-008
title: node_modules SDK drift past the lockfile silently changes live-spawned Claude Code behavior
date: 2026-07-02
status: active
component: agent
related-plans: []
related-decisions: []
---

# LEARNING-008 — node_modules SDK drift past the lockfile silently changes live-spawned Claude Code behavior

## Signal

Subagents launched via the Agent/Task tool suddenly return a fire-and-forget acknowledgement instead of blocking until the child finishes, even though `run_in_background` was never set:

```
Async agent launched successfully… agentId: …
```

Downstream symptom: research fan-outs die mid-run. In-flight async subagents are killed whenever the session's backend agent is disposed + recreated (session_state shows `modeChangedBy: restore`), leaving only whatever the children flushed to `data/` before the kill. Sessions on 2026-07-01 and earlier ran blocking subagents fine; sessions on 2026-07-02 all went async.

## Root cause

Three layers:

1. **node_modules drifted past the lockfile.** `package.json` and `bun.lock` pin `@anthropic-ai/claude-agent-sdk@0.3.170` (bundles Claude Code 2.1.170), but on 2026-07-02 07:02 an install replaced the installed copy with `0.3.197` (bundles Claude Code **2.1.197**, built 2026-06-29) without touching the manifest or lockfile — so `git status` was clean and nothing flagged the drift.
2. **The running server spawns the CLI from disk at agent-creation time.** The daily-driver headless server (`bun run scripts/daily-driver` → `packages/server`) had been running since Jun 30 with the 0.3.170 bridge loaded in-process, but each agent creation spawns `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` fresh from disk. Every agent created after 07:02 got the 2.1.197 binary — behavior changed mid-flight with no server restart and no code change.
3. **Claude Code 2.1.197 launches Task/Agent subagents async by default** in this configuration (the `"Async agent launched"` path exists in the 2.1.197 binary; 2.1.170 blocked by default). Async subagents run inside the persistent SDK subprocess, so they only survive as long as that subprocess. `ClaudeAgent.destroy()` (`packages/shared/src/agent/claude-agent.ts`) aborts `currentQueryAbortController`, killing the subprocess and every in-flight async subagent. Dispose+recreate is triggered by `tryRefreshAgentRuntime` in `packages/server-core/src/sessions/SessionManager.ts` on backend-runtime signature drift (send-path refresh and `llmConnections.SAVE`) — and the ModelRefreshService rewrites connection config on timers (Copilot every 10 min, Anthropic hourly, `packages/server-core/src/model-fetchers/index.ts`), which lines up with the observed ~10–17 min kill cadence.

Note the fork's own background-task tracking (`packages/shared/src/agent/tool-matching.ts:406`) only marks a Task as backgrounded when `run_in_background === true` was explicitly set — forced-async launches are invisible to it, so the UI shows nothing to resume.

## Fix

Restore the lockfile-pinned SDK; a plain `bun install` will not downgrade an already-newer installed copy, so remove it first:

```bash
rm -rf node_modules/@anthropic-ai/claude-agent-sdk node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64
bun install
node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version   # expect 2.1.170
```

No server restart is strictly required — the binary is spawned from disk per agent creation — but restarting `daily-driver` re-aligns everything (loaded bridge + spawned binary) and is recommended at the next convenient break.

To check for this class of drift at any time:

```bash
python3 -c "import json;print(json.load(open('node_modules/@anthropic-ai/claude-agent-sdk/package.json'))['version'])"
grep -o '"@anthropic-ai/claude-agent-sdk": "[^"]*"' package.json | head -1
```

## Recurrence

Likely. Any `bun add`/`bun update` run in this repo (including by an agent session working here) can drift node_modules ahead of the lockfile without a git-visible change. Long-running daily-driver servers then pick up the new binary silently on the next agent creation. Separately, when the pinned SDK is eventually *deliberately* upgraded past 0.3.170, the async-by-default subagent behavior returns and the orchestration patterns that rely on blocking Agent calls need revisiting.

## Prevention

- Prefer `bun install --frozen-lockfile` in this repo; treat a bare `bun update` as a deliberate, committed act.
- Consider logging the spawned CLI version at agent creation (the SDK manifest carries it) so drift shows up in server logs instead of as a behavior mystery.
- Before upgrading the SDK pin, test subagent fan-out semantics (blocking vs async) — the orchestration UX and the `tool-matching.ts` backgrounded-task detection both assume explicit `run_in_background`.

## Update (2026-07-03) — permanent fix landed with the 0.3.197 upgrade

Binary analysis of Claude Code 2.1.197 (PR #44 merge) located the exact async-by-default
mechanism: the Task launch decision is
`isAsync = isRemote || (run_in_background===true || agentDef.background===true || teamsMode
|| tasksMode || (!isTeammate && run_in_background!==false && featureGate("tengu_amber_heron", false)))
&& !CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` — i.e. implicit async is driven entirely by the
remote `tengu_amber_heron` GrowthBook gate (compiled default: off). The gate helper returns
the compiled default *before* consulting cached gate values when `DISABLE_GROWTHBOOK` is set.

Fix (commit `56bb5dd6` on PR #44): `buildClaudeSubprocessEnv()` now pins `DISABLE_GROWTHBOOK=1`,
restoring blocking-by-default while preserving explicit `run_in_background: true` (unlike
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, which also removes the parameter from the Task/Bash
schemas). This also removes remote-config influence over spawned-CLI behavior generally
(harness independence). Companion changes: `logSdkCliVersion()` logs the spawned CLI version
at agent creation and loudly on mid-process change (the drift signature), and the
upstream-sync skill now verifies the gate/launch semantics on every SDK bump.

## References

- Diagnosis sessions: `260702-grand-orbit` (transcript-based post-mortem), `260702-brave-crane` (this root-cause).
- `packages/server-core/src/sessions/SessionManager.ts` — `tryRefreshAgentRuntime`, `disposeManagedAgentRuntime`, `getOrCreateAgent`.
- `packages/server-core/src/sessions/runtime-config.ts` — backend runtime signatures.
- `packages/server-core/src/model-fetchers/index.ts` — 10-min Copilot / 1-h Anthropic refresh timers writing `updateLlmConnection`.
- `packages/shared/src/agent/tool-matching.ts:406` — explicit-flag-only backgrounded-task detection.
