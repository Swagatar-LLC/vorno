# Upstream delta

Files we own that differ from `upstream/main`. Refresh via `[skill:upstream-delta-report]`.

**Last refresh:** 2026-07-13 (post-v0.11.1 merge)
**Method:** `git diff --name-only upstream/main...main`
**Total files in delta:** 360 (up from 227 post-v0.11.0). The growth is **not** from the v0.11.1 merge — that release was taken wholesale from upstream (thinking-levels, Pi constants, GPT-5.6 defaults) and added nothing to our delta. It reflects fork work that landed on `main` in the intervening days, dominated by the **PLAN-014 / VOR-37 workspace-webhooks subsystem** (~60 files across `packages/shared/src/automations/`, `apps/server/src/webhooks/`, `apps/electron/.../trigger-server/` + renderer `components/automations/`, and the `craft-fork:webhooks:*` RPC group in `server-core`). The **orchestration/Activity panel code is fully removed** (ADR-0006, done at v0.11.0) — the only `orchestration`-named entries left in the delta are archived roadmap markdown. Protocol delta is now `channels.ts` + `routing.ts` (fork-owned `craft-fork:webhooks:*` group, classified LOCAL_ONLY) + `dto.ts` (webhook DTOs + PLAN-003 `TokenUsageThresholdsDto`); `events.ts` matches upstream byte-for-byte. Remaining code delta is dominated by the dual-transport server, headless deployment, config-dir isolation, branding gate, the token indicator, fast mode, and the subprocess-env security keeps.

## Major owned components

### Dual-transport HTTP trigger server (`apps/server/`)

Our largest original contribution. Bun-native HTTP/SSE + WebSocket on a single port, with API key auth, rate limiting, session pool, EventBus, and a unified `ClientRegistry` for cross-transport push.

Files (all owned, not in upstream):

- `apps/server/src/index.ts`, `router.ts`, `config.ts`
- `apps/server/src/core/create-trigger-server.ts`
- `apps/server/src/middleware/{auth,cors,error}.ts`
- `apps/server/src/orchestrator/{agent-session,source-orchestrator,types,index}.ts`
- `apps/server/src/routes/{health,sessions,workspaces}.ts`
- `apps/server/src/services/{event-bus,session-pool}.ts`
- `apps/server/src/transport/{client-registry,types,ws-transport,index}.ts`
- `apps/server/src/provisioning.ts` (PLAN-013 — headless provisioning CLI)
- `apps/server/src/standalone/host.ts` (PLAN-013 — standalone headless host composition)
- `apps/server/tests/**/*.test.ts`
- `apps/server/README.md`, `apps/server/package.json`, `apps/server/tsconfig.json`

### Workspace webhooks (PLAN-014 / VOR-37)

Inbound webhook ingestion + management subsystem. Fork-owned end-to-end; the largest addition since the last refresh. No upstream contract changed shape — new RPC lives in the fork-scoped `craft-fork:webhooks:*` namespace, classified **LOCAL_ONLY** in `routing.ts` (see compatibility.md audit-log 2026-07-09).

- **Shared engine** (`packages/shared/src/automations/`): `automation-system.ts`, `event-bus.ts`, `history-store.ts`, `missed-fire.ts`, `on-failure.ts`, `validation.ts`, `schemas.ts`, `types.ts`, `constants.ts`, `name-utils.ts`, `utils.ts`, `webhook-management.ts`, `webhook-utils.ts`, `handlers/{prompt-handler,session-action-handler}.ts` (+ matching `*.test.ts`)
- **Webhook ingest** (`packages/shared/src/automations/webhook-ingest/`): `receiver.ts`, `dispatcher.ts`, `ingest-queue.ts`, `dedup.ts`, `rate-gate.ts`, `tokens.ts`, `verify.ts`, `jsonpath-lite.ts`, `host.ts`, `index.ts` (+ tests)
- **Server executors** (`apps/server/src/webhooks/`): `executors.ts`, `init.ts` (+ `webhook-executors`, `webhook-route`, `webhook-route-mounting` tests)
- **Electron trigger server** (`apps/electron/src/main/`): `trigger-server/{webhooks,webhook-executors}.ts` (+ `__tests__/{webhook-executors,webhooks-e2e}.ts`), `handlers/webhooks.ts`
- **Electron renderer UI** (`apps/electron/src/renderer/components/automations/`): `AutomationInfoPage.tsx`, `AutomationsListPanel.tsx`, `CreateWebhookDialog.tsx`, `WebhookEndpointSection.tsx`, `WebhookTokenDialog.tsx`, `types.ts`; `hooks/useAutomations.ts`; bundled `resources/docs/automations.md`
- **Server-core RPC**: `packages/server-core/src/handlers/rpc/automations.ts`; `sessions/{automation-outcome-records,execute-prompt-automation-test-mode}.test.ts`
- **Protocol**: `craft-fork:webhooks:*` channels in `channels.ts`, LOCAL_ONLY classification in `routing.ts`, webhook DTOs in `dto.ts`

### Headless deployment (`deploy/`, PLAN-013 / ADR-0008)

Fork-only deployment artifacts + docs for running `apps/server` headless:

- `deploy/{Dockerfile,compose.yaml,README.md}`, `deploy/systemd/vorno-server.service`,
  `deploy/reverse-proxy/{Caddyfile,nginx.conf}`
- `docs/server-deployment.md`

Two upstream-adjacent edits widen the diff (small, additive, in-process — not
wire changes; recorded here per PLAN-013):

- `packages/server/src/index.ts` `getMessagingDir` now routes through `CONFIG_DIR`
  instead of a hardcoded `~/.craft-agent` literal. This file is fork-exclusive
  (the standalone-server messaging bootstrap is a Swagatar addition), so no
  upstream collision.
- `packages/server-core/src/bootstrap/headless-start.ts` exports
  `acquireServerLock` (was module-private) so the standalone host reuses identical
  `.server.lock` staleness handling. One added `export` keyword.

### Documentation we own

- `ARCHITECTURE.md`
- `CONTAINER-ARCHITECTURE.md`
- `docs/http-trigger-server.md`
- `docs/server-deployment.md`
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

> The orchestration/Activity panel (former PLAN-007/008/009) was **removed** at v0.11.0 per ADR-0006 in favor of upstream's background-task/Conductor system. No `atoms/orchestration.ts`, `OrchestrationRail.tsx`, `ActiveTasksBar.tsx`, or `packages/ui/.../orchestration/` code remains in the delta.

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

### Agent-side fixes

- `packages/shared/src/agent/options.ts` — `buildClaudeSubprocessEnv()` carries our subprocess env contract: `delete env.CLAUDECODE` (nested-session refusal), Bedrock routing strips, and since v0.10.5 the `DISABLE_GROWTHBOOK=1` pin that keeps Task subagents blocking-by-default (LEARNING-008) plus `logSdkCliVersion()` drift logging. `CLAUDECODE` strip remains a candidate for upstream contribution.
- `packages/shared/src/agent/claude-agent.ts` — spawned-CLI version logging at agent creation; fast-mode plumbing
- `packages/shared/tests/claude-subprocess-env.test.ts` — regression test for the env contract
- `packages/shared/src/agent/{base-agent,spawn-session-tool}.ts`
- `packages/shared/src/agent/backend/types.ts` + `backend/internal/drivers/{anthropic,pi}.ts` (+ tests)
- `packages/shared/src/config/{models,model-fetcher,models-openai,storage,index}.ts` (+ tests) — fast-mode registry hints (`supportsFastMode`), live model enumeration (PLAN-010 WIP)
- `packages/shared/src/{feature-flags,unified-network-interceptor,interceptor-common}.ts`
- `packages/shared/src/protocol/dto.ts` — token-usage threshold + webhook protocol additions
- `packages/shared/src/sessions/types.ts`, `packages/shared/src/workspaces/types.ts` (+ threshold storage test)
- `packages/shared/src/{auth,logging,version,release-notes,prompts,sources,docs}/**` — assorted fork touches
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

- `roadmap/**` (README, VISION, decisions, directions, discussions, evidence, learnings, plans, upstream tracking)
- `.agents/skills/**` (capture-learning, electron-prod-build, roadmap-plan-{advance,create,document}, roadmap-status, upstream-{sync,delta-report}, README)
- `AGENTS.md`, `CLAUDE.md` (root)

### Root configuration

- `tsconfig.base.json` (added by us; absent in upstream)

### Scripts

CI helpers, deployment glue, and dev-time automation affordances under `scripts/`.

- `scripts/check-branding.ts` + `scripts/branding-allowlist.json` (VOR-3 branding gate)
- `scripts/check-i18n-coverage.ts` (PLAN-004)
- `scripts/electron-build-subprocess.ts`
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
