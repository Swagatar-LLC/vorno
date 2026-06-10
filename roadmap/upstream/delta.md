# Upstream delta

Files we own that differ from `upstream/main`. Refresh via `[skill:upstream-delta-report]`.

**Last refresh:** 2026-06-10 (post-v0.10.2→v0.10.3 merge, PR #37)
**Method:** `git diff --name-only upstream/main...main`
**Total files in delta:** 162 (was 122 on 2026-05-28)

**By bucket:** apps/server 33 · apps/electron 32 · apps/webui 1 · packages 36 · .github 2 · roadmap 39 · .agents 9 · scripts 3 · docs 1 · root `*.md` 4 · `tsconfig.base.json` 1 · `bun.lock` 1. Growth since the last refresh is mostly `roadmap/**` (plan churn — PLAN-007 done, PLAN-008 planned) and new fork-owned **orchestration UI** components under `packages/ui/src/components/orchestration/`.

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
- `apps/electron/package.json`
- `apps/electron/src/renderer/pages/settings/RemoteAccessSettingsPage.tsx` — UI to manage API keys
- `apps/electron/src/renderer/components/workspace/AddWorkspaceStep_ConnectRemote.tsx`

Token-usage thresholds (PLAN-002 done, PLAN-003 in progress):
- `apps/electron/src/renderer/atoms/token-usage-thresholds.ts`
- `apps/electron/src/renderer/hooks/useTokenUsageThresholds.ts`
- `apps/electron/src/renderer/components/chat/ContextUsageIndicator.tsx`
- `apps/electron/src/renderer/components/chat/context-usage.ts`
- `apps/electron/src/renderer/components/chat/__tests__/context-usage.test.ts`
- `apps/electron/src/renderer/pages/settings/TokenUsageThresholdsSettings.tsx`
- `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`

Other renderer changes:
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx`
- `apps/electron/src/renderer/components/fork-badge.tsx` (fork branding)
- `apps/electron/src/renderer/index.html` (title)
- `apps/electron/src/renderer/pages/{index,settings/index}.ts` (register pages)
- `apps/electron/src/renderer/playground/demos/messaging/PairingCodeDialogPreview.tsx`
- `apps/electron/src/renderer/playground/registry/types.ts`

### Agent-side fixes

- `packages/shared/src/agent/options.ts` — adds `delete env.CLAUDECODE` inside `buildClaudeSubprocessEnv()` so the SDK CLI doesn't refuse to spawn in nested-session contexts. Candidate for upstream contribution.
- `packages/shared/src/protocol/dto.ts` — token-usage threshold protocol additions
- `packages/shared/src/workspaces/types.ts` — workspace settings for thresholds
- `packages/shared/src/workspaces/__tests__/storage-token-usage-thresholds.test.ts`
- `packages/server-core/src/handlers/rpc/settings.ts` — settings RPC handler
- `packages/server-core/src/handlers/rpc/sessions.ts`, `session-manager-interface.ts`, `sessions/SessionManager.ts` — session surface tweaks
- `packages/server-core/src/webui/http-server.ts` — webui HTTP server tweaks
- `packages/shared/src/agent/{base-agent,claude-agent,spawn-session-tool}.ts`, `agent/backend/types.ts` — agent-side fork deltas (incl. fast-mode gating in `claude-agent.ts`)
- `packages/shared/src/config/models.ts`, `packages/shared/tests/models.test.ts` — `supportsFastMode` / `getModelSupportsFastMode` fork delta (see compatibility audit 2026-06-10)
- `packages/shared/src/automations/{handlers/prompt-handler,schemas,types}.ts` — automations surface
- `packages/shared/src/{feature-flags,unified-network-interceptor}.ts`, `sessions/types.ts`

### Orchestration UI (PLAN-007 done / PLAN-008 planned)

Fork-owned orchestration activity panel under `packages/ui/`:

- `packages/ui/src/components/orchestration/{DefaultOrchestrationItem,OrchestrationPanel}.tsx`, `{index,registry,types}` + `packages/ui/src/index.ts` export

### i18n (PLAN-004)

- `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json`

### Governance / fork branding

- `roadmap/**` (README, VISION, decisions, directions, discussions, learnings, plans, upstream tracking)
- `.agents/skills/**` (capture-learning, electron-prod-build, roadmap-plan-{advance,create,document}, roadmap-status, upstream-{sync,delta-report})
- `AGENTS.md`, `CLAUDE.md` (root)

### Root configuration

- `tsconfig.base.json` (added by us; absent in upstream)
- `package.json` (root — workspaces / scripts diverged)

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
