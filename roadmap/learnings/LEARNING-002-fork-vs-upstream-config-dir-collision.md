---
id: LEARNING-002
title: Fork vs upstream stable collide on `~/.craft-agent/.server.lock`
date: 2026-04-29
status: active
component: electron / fork-isolation
related-plans: [PLAN-001]
related-decisions: []
---

# LEARNING-002 — Fork vs upstream stable collide on `~/.craft-agent/.server.lock`

## Signal

Fork desktop boots, window opens but renders blank, and the main-process log contains:

```
2026-04-29T04:56:42.198Z ERROR [main] Failed to initialize app: Another server instance is already running (PID 72101). If this is stale, delete /Users/jeffhampton/.craft-agent/.server.lock and retry. Error: Another server instance is already running (PID 72101). If this is stale, delete /Users/jeffhampton/.craft-agent/.server.lock and retry.
    at acquireServerLock (/.../apps/electron/dist/main.cjs:917909:19)
    at bootstrapServer (/.../apps/electron/dist/main.cjs:917976:3)
```

Bundled stable Craft Agents holds the lock (PID 72101 in this instance). The fork tries to acquire the same lockfile path and fails. The window stays blank because the bootstrap aborts before it can wire the renderer.

## Root cause

Both upstream stable and our fork resolve `CONFIG_DIR` to `~/.craft-agent` by default — see `packages/shared/src/config/paths.ts`:

```ts
export const CONFIG_DIR = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');
```

The single-instance lock at `${CONFIG_DIR}/.server.lock` (`packages/server-core/src/bootstrap/headless-start.ts`) is by design — it prevents two instances from corrupting the shared config directory.

For our purposes (running upstream stable side-by-side with our fork), the fork must use a *different* config root. The mechanism already exists upstream: the `CRAFT_CONFIG_DIR` env var was added for multi-instance dev (their pattern: numbered folders → `~/.craft-agent-1`, `~/.craft-agent-2`). We just have to set it.

## Fix

Set `CRAFT_CONFIG_DIR=$HOME/.craft-agent-swagatar` before running `electron:dev`. Already baked into our `package.json` scripts as of this learning's commit:

```json
"electron:dev": "CRAFT_CONFIG_DIR=${CRAFT_CONFIG_DIR:-$HOME/.craft-agent-swagatar} bun run scripts/electron-dev.ts",
"electron:dev:terminal": "CRAFT_CONFIG_DIR=${CRAFT_CONFIG_DIR:-$HOME/.craft-agent-swagatar} bun run scripts/electron-dev.ts --terminal",
"electron:dev:menu": "CRAFT_CONFIG_DIR=${CRAFT_CONFIG_DIR:-$HOME/.craft-agent-swagatar} bash scripts/electron-dev.sh",
```

The `${CRAFT_CONFIG_DIR:-...}` syntax respects an explicit override; if the user wants a different path they can `export CRAFT_CONFIG_DIR=...` before running.

After the fix, the fork sees an **empty config root** on first launch — no sessions, no sources, no credentials. That's intentional: the fork is fully isolated from upstream stable's data. Bootstrap will create defaults and onboard.

## Recurrence

- **Never recurs in dev** for this user, since the env var is now permanent in `package.json`.
- **Will recur in production** if a fork `.dmg` is installed alongside upstream stable on the same Mac — `electron-builder` doesn't currently set `CRAFT_CONFIG_DIR` at runtime. We must address this in fork-branding before shipping a fork installer.
- **Will recur for other developers** who clone upstream and run our fork without our `package.json` changes.

## Prevention

- Done: `package.json` `electron:dev*` scripts set `CRAFT_CONFIG_DIR` by default.
- TODO (for fork production builds): set `CRAFT_CONFIG_DIR` in the main process before any `CONFIG_DIR` import is evaluated. Likely need to set it as one of the very first statements in `apps/electron/src/main/index.ts` based on a build-time `IS_FORK_BUILD` flag, OR via electron-builder's `extraEnv`. Tracked under fork-branding follow-ups.
- The fork's first-run UX should explicitly call out the empty config root ("Welcome to the Swagatar Fork — your config lives at `~/.craft-agent-swagatar`").

## References

- `packages/shared/src/config/paths.ts` — `CONFIG_DIR` definition
- `packages/server-core/src/bootstrap/headless-start.ts` — `acquireServerLock` (lines 116–166)
- `roadmap/decisions/0001-fork-relationship-with-upstream.md` — the wire-compatible-but-divergent posture this learning supports
- LEARNING-001 — sibling learning capturing a different recurring fork-vs-upstream issue
