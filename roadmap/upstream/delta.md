# Upstream delta

Files we own that differ from `upstream/main`. Refresh via `[skill:upstream-delta-report]`.

**Last refresh:** 2026-04-28 (post v0.8.12 merge)
**Method:** `git diff --name-only upstream/main...main`

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
- `tsconfig.base.json` (added by us; absent in upstream)

### CI workflow

- `.github/workflows/validate-pr.yml` — our sanity suite (typecheck, shared tests with thresholds, server tests strict, doc-tools, build check)
- `.github/workflows/validate.yml` — disabled to `workflow_dispatch` only (upstream's broken Validate)

### Electron tweaks

- `apps/electron/src/main/server-lifecycle.ts` — manages embedded HTTP trigger server
- `apps/electron/src/renderer/pages/settings/RemoteAccessSettingsPage.tsx` — UI to manage API keys
- `apps/electron/src/renderer/pages/{index,settings/index}.ts` — register the page

### Agent-side fix (still owned but trivial)

- `packages/shared/src/agent/options.ts` — adds `delete env.CLAUDECODE` inside `buildClaudeSubprocessEnv()` so the SDK CLI doesn't refuse to spawn in nested-session contexts. Candidate for upstream contribution.

### Governance / fork branding (this PR)

- `roadmap/**` — new
- `.agents/skills/**` — new
- `AGENTS.md`, `CLAUDE.md` (root) — new
- `apps/electron/src/main/window-manager.ts` (title), `apps/electron/src/renderer/components/fork-badge.tsx` (new), `apps/electron/src/renderer/index.html` (title), `apps/electron/src/renderer/index.css` (accent stripe) — fork branding

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
