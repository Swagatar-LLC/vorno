# Upstream delta

Files we own that differ from `upstream/main`. Refresh via `[skill:upstream-delta-report]`.

**Last refresh:** 2026-07-03 (post-v0.10.5 merge, PR #44)
**Method:** `git diff --name-only upstream/main...main`
**Total files in delta:** 188 (up from 122 on 2026-05-28 — growth is mostly the orchestration activity panel (PLAN-007/009), per-session fast mode (PLAN-006), live model enumeration (PLAN-010 WIP), and roadmap/governance docs)

## Major owned components

### Dual-transport HTTP trigger server (`apps/server/`)

Our largest original contribution. Bun-native HTTP/SSE + WebSocket on a single port, with API key auth, rate limiting, session pool, EventBus, and a unified `ClientRegistry` for cross-transport push.

Files (all owned, not in upstream):

- `apps/server/src/index.ts`, `router.ts`, `config.ts`
- `apps/server/src/middleware/{auth,cors,error}.ts`
- `apps/server/src/orchestrator/{agent-session,source-orchestrator,types,index}.ts`
- `apps/server/src/routes/{health,sessions,workspaces}.ts`
- `apps/server/src/services/{event-bus,session-pool}.ts`
- `apps/server/src/transport/{client-registry,types,ws-transport,index}.ts`
- `apps/server/tests/**/*.test.ts`
- `apps/server/README.md`, `apps/server/package.json`, `apps/server/tsconfig.json`

### Documentation we own

- `ARCHITECTURE.md`
- `CONTAINER-ARCHITECTURE.md`
- `docs/http-trigger-server.md`
- `apps/webui/README.md`

### CI workflow

- `.github/workflows/validate-pr.yml` — our sanity suite (typecheck, shared tests with thresholds, server tests strict, doc-tools, build check)
- `.github/workflows/validate.yml` — disabled to `workflow_dispatch` only (upstream's broken Validate)

### Electron tweaks

Server-lifecycle and remote-access:
- `apps/electron/src/main/server-lifecycle.ts` — manages embedded HTTP trigger server
- `apps/electron/src/main/browser-pane-manager.ts`
- `apps/electron/src/main/window-manager.ts` (title)
- `apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts`
- `apps/electron/src/renderer/pages/settings/RemoteAccessSettingsPage.tsx` — UI to manage API keys
- `apps/electron/src/renderer/components/workspace/AddWorkspaceStep_ConnectRemote.tsx`

Orchestration activity panel (PLAN-007 done, PLAN-009 done, PLAN-008 planned):
- `apps/electron/src/renderer/atoms/orchestration.ts` + `atoms/__tests__/orchestration.test.ts`
- `apps/electron/src/renderer/components/app-shell/{OrchestrationRail,ActiveTasksBar,AppShell}.tsx`
- `apps/electron/src/renderer/hooks/useBackgroundTasks.ts`
- `apps/electron/src/renderer/pages/ChatPage.tsx`
- `apps/electron/src/shared/types.ts`

Token-usage thresholds (PLAN-002/003 done):
- `apps/electron/src/renderer/atoms/token-usage-thresholds.ts`
- `apps/electron/src/renderer/hooks/useTokenUsageThresholds.ts`
- `apps/electron/src/renderer/components/chat/ContextUsageIndicator.tsx`
- `apps/electron/src/renderer/components/chat/context-usage.ts` + `__tests__/context-usage.test.ts`
- `apps/electron/src/renderer/pages/settings/TokenUsageThresholdsSettings.tsx`
- `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`

Per-session fast mode (PLAN-006 done):
- `apps/electron/src/renderer/hooks/useSessionOptions.ts`
- `apps/electron/src/renderer/components/app-shell/input/{ChatInputZone,CompactModelSelector}.tsx`
- `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`, `ChatDisplay.follow-ups.ts` + test
- `apps/electron/src/renderer/atoms/sessions.ts`

Other renderer changes:
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx`
- `apps/electron/src/renderer/components/fork-badge.tsx` (fork branding)
- `apps/electron/src/renderer/index.html` (title)
- `apps/electron/src/renderer/pages/{index,settings/index}.ts` (register pages)
- `apps/electron/src/renderer/playground/demos/messaging/PairingCodeDialogPreview.tsx`
- `apps/electron/src/renderer/playground/registry/types.ts`

### Shared UI orchestration components (`packages/ui`)

- `packages/ui/src/components/orchestration/{OrchestrationPanel,DefaultOrchestrationItem,registry,types,index}.{tsx,ts}`
- `packages/ui/src/index.ts`, `packages/ui/package.json`

### Agent-side fixes

- `packages/shared/src/agent/options.ts` — `buildClaudeSubprocessEnv()` carries our subprocess env contract: `delete env.CLAUDECODE` (nested-session refusal), Bedrock routing strips, and since v0.10.5 the `DISABLE_GROWTHBOOK=1` pin that keeps Task subagents blocking-by-default (LEARNING-008) plus `logSdkCliVersion()` drift logging. `CLAUDECODE` strip remains a candidate for upstream contribution.
- `packages/shared/src/agent/claude-agent.ts` — spawned-CLI version logging at agent creation; fast-mode plumbing
- `packages/shared/tests/claude-subprocess-env.test.ts` — regression test for the env contract
- `packages/shared/src/agent/{base-agent,spawn-session-tool}.ts`
- `packages/shared/src/agent/backend/types.ts` + `backend/internal/drivers/{anthropic,pi}.ts` (+ tests)
- `packages/shared/src/config/{models,model-fetcher,models-openai,storage,index}.ts` (+ tests) — fast-mode registry hints (`supportsFastMode`), live model enumeration (PLAN-010 WIP)
- `packages/shared/src/{feature-flags,unified-network-interceptor}.ts`
- `packages/shared/src/automations/{types,schemas,handlers/prompt-handler}.ts`
- `packages/shared/src/protocol/dto.ts` — token-usage threshold protocol additions
- `packages/shared/src/sessions/types.ts`, `packages/shared/src/workspaces/types.ts` (+ threshold storage test)
- `packages/shared/tests/models.test.ts`, `packages/shared/src/config/__tests__/storage-startup-migration.test.ts`
- `packages/shared/package.json`
- `packages/core/src/types/{index,message}.ts`
- `packages/server-core/src/handlers/rpc/{sessions,settings}.ts`, `handlers/session-manager-interface.ts`
- `packages/server-core/src/sessions/SessionManager.ts` (+ `message-annotation-result.test.ts`)
- `packages/server-core/src/model-fetchers/index.ts` (PLAN-010 WIP)
- `packages/server-core/src/webui/http-server.ts`

### i18n (PLAN-004)

- `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json`

### Governance / fork branding

- `roadmap/**` (README, VISION, decisions, directions, discussions, learnings, plans, upstream tracking)
- `.agents/skills/**` (capture-learning, electron-prod-build, roadmap-plan-{advance,create,document}, roadmap-status, upstream-{sync,delta-report}, README)
- `AGENTS.md`, `CLAUDE.md` (root)

### Root configuration

- `tsconfig.base.json` (added by us; absent in upstream)

### Scripts

CI helpers, deployment glue, and dev-time automation affordances under `scripts/`.

- `scripts/check-i18n-coverage.ts` (PLAN-004)
- `scripts/daily-driver.ts`
- `scripts/webui-serve.ts` (PLAN-005)

## Lock file

- `bun.lock` — always diverges due to dependency resolution differences. Mechanical, not a true delta.

## Refresh command

```bash
cd /Users/jeffhampton/dev/craft-agents-oss
git fetch upstream
git diff --name-only upstream/main...main
```

To group by directory:

```bash
git diff --name-only upstream/main...main | awk -F/ '{print $1"/"$2}' | sort | uniq -c | sort -rn
```
