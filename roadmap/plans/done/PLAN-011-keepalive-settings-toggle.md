---
id: PLAN-011
title: Settings toggle for background-agent keep-alive
status: done
direction: none
owner: jh
created: 2026-07-08
updated: 2026-07-24
related: []
blocked-by: []
---

# PLAN-011 — Settings toggle for background-agent keep-alive (design)

Design for a runtime Settings UI toggle over upstream v0.11.0's "background agents stay alive across turns" (env-only opt-out `CRAFT_KEEP_BG_AGENTS_ALIVE=0`).

---

## 1. Mechanism analysis

### Where upstream reads the env var

`CRAFT_KEEP_BG_AGENTS_ALIVE` is read in exactly **one** place on upstream/main:

- `packages/shared/src/agent/backend/claude/persistent-input.ts:38` — `resolveKeepBackgroundTasksAlive(env = process.env)`: `'1'|'true'` → true, `'0'|'false'` → false, unset → `DEFAULT_KEEP_ALIVE = true` (line 33). Exported via `packages/shared/src/agent/index.ts:169`.

All other hits are comments/docs/tests (`persistent-input.test.ts:9–14`, release notes, `event-processor/types.ts:100`).

### Who consults the resolver, and when

Two consumers, both **`private readonly` field initializers** (snapshot-at-construction):

1. **`ClaudeAgent.keepBackgroundTasksAlive`** — `packages/shared/src/agent/claude-agent.ts:516`. `ClaudeAgent` is constructed by the backend factory (`packages/shared/src/agent/backend/factory.ts:136`) via `SessionManager.getOrCreateAgent` (`SessionManager.ts:3307`) — lazily **per session**, recreated on runtime-config refresh / clearHistory. So this snapshot is per-agent-instance.
2. **`SessionManager.keepBackgroundTasksAlive`** — `packages/server-core/src/sessions/SessionManager.ts:1229`. SessionManager is a **process-lifetime singleton** in the Electron main process → resolved once at process start. Its doc comment (1220–1228) says both copies use the shared resolver "so the main process and the Claude backend can never disagree."

### Where the flag is *acted on* (all per-turn or per-event)

- `claude-agent.ts:1654` — per turn, in `chat()`: keep-alive && !slash-command → `beginPersistentTurn()` (one long-lived streaming-input `query()`, per-turn channel); else fresh per-turn `query()`.
- `claude-agent.ts:2379–2393` — turn `finally`: keep-alive + open `persistentInput` → subprocess stays alive; else `currentQuery = null` (teardown, background agents die here).
- `SessionManager.ts:4124, 4182, 6600` — every `complete` event carries `backgroundTasksAlive: this.keepBackgroundTasksAlive` to the renderer (renderer consumes it per turn, `event-processor/types.ts:100` — no direct env read in the renderer).
- `SessionManager.ts:6793–6797` — `markOrphanedBackgroundTasks()` no-ops when keep-alive is on (per turn end).
- `SessionManager.ts:8114–8123` — idle completion surfacing (session wakes itself) gated on `this.keepBackgroundTasksAlive && !managed.isProcessing` (per background-task event).

### Effect-timing conclusion

As shipped, the value is frozen at **process start** (SessionManager) and **agent construction** (ClaudeAgent) — changing the env var requires an app restart. But every *behavioral decision* is made per turn or per event. Therefore: **if both snapshots are replaced with live reads, a toggle takes effect at each session's next message** (SessionManager's per-event checks react immediately). True mid-turn liveness is neither needed nor desirable — a turn should be internally consistent (upstream's "never disagree" intent), so the agent should snapshot **per turn**, not per read. Net: **next-turn effect, per session; no restart.**

---

## 2. Design

### Scope: app-level (recommended)

- `SessionManager.keepBackgroundTasksAlive` is process-wide across all workspaces; the mechanism has zero per-workspace plumbing (6797/8123 aren't workspace-parameterized). Workspace scope would force deeper divergence in hot upstream code.
- The env var it mirrors is process-global; an app-level setting is a 1:1 replacement.
- House pattern for app-level booleans is the lightest: `extendedPromptCache` (`packages/shared/src/config/storage.ts:480–493`, `settings.ts:315–321`, `channel-map.ts:303–304`, `AiSettingsPage.tsx:651/684/993–994/1183–1187`). The workspace-scoped token-thresholds pattern (`workspaces/types.ts:72`, `SETTINGS_GET/UPDATE`) is heavier and buys nothing for a single-user kill switch.

### Storage

`keepBackgroundAgentsAlive?: boolean` on `AppConfig` in `packages/shared/src/config/storage.ts` (comment: `// Keep background subagents alive across turns (default: true; env CRAFT_KEEP_BG_AGENTS_ALIVE overrides)`), persisted in `~/.craft-agent/config.json`. Default **true** (upstream default, per the maintainer). Also add to `config-defaults-schema.ts`, `apps/electron/resources/config-defaults.json`, and `FALLBACK_CONFIG_DEFAULTS` in storage.ts. Getter/setter mirror `getExtendedPromptCache`/`setExtendedPromptCache` exactly.

### Precedence: explicit env var wins (recommended)

Resolution order: **env set (`'1'/'true'/'0'/'false'`) → env wins; env unset → stored setting; nothing → true.** Justification: preserves upstream's documented kill-switch contract for scripts/CI/support instructions; an env var is a deliberate operator action per-launch, while the setting is durable state; upstream tests pin env semantics. UI mitigation for "toggle appears dead": the GET handler returns `{ enabled, envOverride }` and the toggle renders disabled with an explanatory hint when `envOverride` is true.

### New fork-additive resolver (leaves upstream `persistent-input.ts` untouched)

`packages/shared/src/agent/backend/claude/keep-alive-setting.ts`:

```ts
import { getKeepBackgroundAgentsAlive } from '../../../config/storage.ts'

export interface KeepAliveState { enabled: boolean; envOverride: boolean }

// injectable readStored for unit tests (no fs dependency)
export function getKeepBackgroundTasksAliveState(
  env: Record<string, string | undefined> = process.env,
  readStored: () => boolean = getKeepBackgroundAgentsAlive,
): KeepAliveState {
  const raw = env.CRAFT_KEEP_BG_AGENTS_ALIVE
  if (raw === '1' || raw === 'true') return { enabled: true, envOverride: true }
  if (raw === '0' || raw === 'false') return { enabled: false, envOverride: true }
  return { enabled: readStored(), envOverride: false }
}

export function isKeepBackgroundTasksAliveEnabled(): boolean {
  return getKeepBackgroundTasksAliveState().enabled
}
```

Both consumers run in the Electron main process (ClaudeAgent is spawned in-process by SessionManager), so reading `storage.ts` directly covers both — no override registry, no IPC to the agent. `apps/server` headless inherits the same config file for free.

### Consumer changes (the only hot-file edits)

**`packages/shared/src/agent/claude-agent.ts`** — change line 516 from `readonly` to a **per-turn snapshot**:
```ts
// fork(PLAN-011): settings-driven; re-snapshotted at each chat() start so a
// Settings toggle takes effect next turn without restart. Env var still wins.
private keepBackgroundTasksAlive: boolean = isKeepBackgroundTasksAliveEnabled();
```
At the top of `chatImpl` (before the branch at ~1654):
```ts
this.keepBackgroundTasksAlive = isKeepBackgroundTasksAliveEnabled();
if (!this.keepBackgroundTasksAlive && this.persistentInput) {
  this.teardownPersistentQuery('keep-alive setting toggled off');
}
```
The teardown guard prevents a subprocess leak: without it, a toggled-off turn takes the per-turn `query()` path (1656+) while the old persistent query is still open. `teardownPersistentQuery` (claude-agent.ts:543–560) is idempotent and is the sanctioned funnel. The `finally` at 2388 uses the same per-turn snapshot, so a mid-turn flip can't misroute teardown.

**`packages/server-core/src/sessions/SessionManager.ts`** — replace the readonly field at 1229 with a getter/setter pair:
```ts
// fork(PLAN-011): live read so the Settings toggle applies without restart.
// Setter preserves the test seam (background-task-surface.test.ts assigns the field).
private keepBackgroundTasksAliveForced: boolean | null = null
private get keepBackgroundTasksAlive(): boolean {
  return this.keepBackgroundTasksAliveForced ?? isKeepBackgroundTasksAliveEnabled()
}
private set keepBackgroundTasksAlive(v: boolean) { this.keepBackgroundTasksAliveForced = v }
```
The setter matters: upstream's `background-task-surface.test.ts:42` does `(sm as {keepBackgroundTasksAlive: boolean}).keepBackgroundTasksAlive = ...` — a getter-only accessor would throw in strict mode. With the pair, that upstream test passes **unmodified**. All five call sites (4124, 4182, 6600, 6797, 8123) are untouched and become live.

**`packages/shared/src/agent/index.ts`** — additive export of the new module next to the existing `resolveKeepBackgroundTasksAlive` export (line ~167–169).

### Protocol / RPC (wire-compat)

Per `roadmap/upstream/compatibility.md`: "We may add new ones under our own namespace prefix (e.g., `craft-fork:*`)". The fork's `rtk:*` group used a bare namespace; recommend the strict contract form here since upstream plausibly ships its own keep-alive setting later:

- `packages/shared/src/protocol/channels.ts` — new group:
  ```ts
  bgAgents: {
    GET_KEEP_ALIVE: 'craft-fork:bgAgents:getKeepAlive',
    SET_KEEP_ALIVE: 'craft-fork:bgAgents:setKeepAlive',
  },
  ```
- `packages/shared/src/protocol/routing.ts` — add both to `LOCAL_ONLY_CHANNELS` (matches `caching`/`rtk`/`tools` precedent; the exhaustiveness test fails CI until classified).
- No envelope/DTO/AgentEvent changes — `complete.backgroundTasksAlive` already exists upstream. Fully additive; log in the compatibility.md audit table at the next merge audit.

### RPC handler

`packages/server-core/src/handlers/rpc/settings.ts` — add both channels to `HANDLED_CHANNELS` and, mirroring the caching handlers (315–321):
```ts
server.handle(RPC_CHANNELS.bgAgents.GET_KEEP_ALIVE, async () => {
  const { getKeepBackgroundTasksAliveState } = await import('@craft-agent/shared/agent')
  return getKeepBackgroundTasksAliveState()   // { enabled, envOverride }
})
server.handle(RPC_CHANNELS.bgAgents.SET_KEEP_ALIVE, async (_ctx, enabled: boolean) => {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const { setKeepBackgroundAgentsAlive } = await import('@craft-agent/shared/config/storage')
  setKeepBackgroundAgentsAlive(enabled)
  deps.platform.logger.info(`Background-agent keep-alive set to: ${enabled}`)
})
```
No push/broadcast needed: consumers read live from storage; the renderer's per-turn `complete.backgroundTasksAlive` keeps chips consistent.

### Client plumbing + renderer

- `apps/electron/src/transport/channel-map.ts` (~303): `getKeepBackgroundAgentsAlive: invoke(RPC_CHANNELS.bgAgents.GET_KEEP_ALIVE)`, `setKeepBackgroundAgentsAlive: invoke(...SET_KEEP_ALIVE)`.
- `apps/electron/src/shared/types.ts` (~554): matching `ElectronAPI` declarations (`getKeepBackgroundAgentsAlive(): Promise<{enabled: boolean; envOverride: boolean}>`, `setKeepBackgroundAgentsAlive(enabled: boolean): Promise<void>`).
- `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx` — follow the `extendedPromptCache` pattern exactly (local `useState` + load-in-`useEffect` + fire-and-persist handler — **no Jotai atom needed**; renderer behavior is already driven by `complete.backgroundTasksAlive`):
  - state: `const [keepBgAgentsAlive, setKeepBgAgentsAlive] = useState(true)` + `const [keepBgAgentsAliveEnvOverride, ...] = useState(false)` (~651)
  - load in the existing `useEffect` (~684)
  - handler (~993): optimistic set + `await window.electronAPI?.setKeepBackgroundAgentsAlive(enabled)`
  - `SettingsToggle` next to the extendedPromptCache toggle (~1183), `disabled={keepBgAgentsAliveEnvOverride}`, with the env-override hint shown beneath when disabled.

### UI copy (honest effect timing) — en.json

- `settings.ai.keepBgAgentsAlive`: "Keep background agents alive across turns"
- `settings.ai.keepBgAgentsAliveDesc`: "Background agents keep running after a turn ends, and idle sessions wake up when one finishes. Changes apply at each session's next message — turning this off stops a session's running background agents the next time you message it."
- `settings.ai.keepBgAgentsAliveEnvOverride`: "This setting is currently forced by the CRAFT_KEEP_BG_AGENTS_ALIVE environment variable and the toggle is ignored until the variable is unset."

---

## 3. Merge-conflict posture

Fork-only feature; everything additive except two hot files. Additive new files: `keep-alive-setting.ts` + its test. Additive-in-place: storage.ts getters, config-defaults (schema + json), channels.ts/routing.ts groups, settings.ts handlers, channel-map/types entries, AiSettingsPage toggle, 7 locale files, ipc-channels.test.ts entries — all end-of-group insertions that merge clean.

Unavoidable upstream-file edits (each marked `// fork(PLAN-011): ...` so conflicts resolve as trivial keep-ours/keep-both):

| File | Why unavoidable | Size |
|---|---|---|
| `packages/shared/src/agent/claude-agent.ts` | The consumption snapshot lives here (516, 1654, `finally` 2388); per-turn re-snapshot + teardown guard must sit at `chatImpl` start | ~5 lines |
| `packages/server-core/src/sessions/SessionManager.ts` | Field at 1229 must become live; getter/setter pair | ~7 lines |
| `packages/shared/src/agent/index.ts` | Export surface | 1 line |

Deliberately **not** touched: `persistent-input.ts` (upstream's resolver + tests stay byte-identical), `background-task-surface.test.ts` (setter shim keeps it passing), event-processor, DTO/envelope files. If upstream later ships its own settings surface for this, the fork resolver is a single file to delete and the channels are namespaced out of collision.

---

## 4. Implementation plan (ordered, verbatim-followable)

1. **`packages/shared/src/config/storage.ts`** — add `keepBackgroundAgentsAlive?: boolean` to `AppConfig` (new comment group after `enable1MContext`, ~line 86); add `keepBackgroundAgentsAlive: true` to `FALLBACK_CONFIG_DEFAULTS.defaults`; add after `setExtendedPromptCache` (~line 493): `getKeepBackgroundAgentsAlive(): boolean` (`config?.keepBackgroundAgentsAlive ?? true`) and `setKeepBackgroundAgentsAlive(enabled: boolean): void` (mirror setter shape exactly).
2. **`packages/shared/src/config/config-defaults-schema.ts`** — add `keepBackgroundAgentsAlive: boolean;` beside `extendedPromptCache` (line ~22). **`apps/electron/resources/config-defaults.json`** — add `"keepBackgroundAgentsAlive": true` beside `"extendedPromptCache"` (line ~12).
3. **NEW `packages/shared/src/agent/backend/claude/keep-alive-setting.ts`** — as specified in §2.
4. **NEW `packages/shared/src/agent/backend/claude/keep-alive-setting.test.ts`** — cases: (a) default-on: env `{}`, `readStored: () => true` → `{enabled: true, envOverride: false}`; (b) toggle-off honored: env `{}`, stored false → enabled false; (c) env precedence: `'0'` beats stored true; `'1'` beats stored false; `'false'`/`'true'` string forms; (d) envOverride flag true only when env set. Style-match `persistent-input.test.ts`.
5. **`packages/shared/src/agent/index.ts`** — export `getKeepBackgroundTasksAliveState`, `isKeepBackgroundTasksAliveEnabled` next to line ~169.
6. **`packages/shared/src/agent/claude-agent.ts`** — import from `./backend/claude/keep-alive-setting.ts`; change 516 to a mutable field initialized from `isKeepBackgroundTasksAliveEnabled()` (update doc comment); at `chatImpl` start add the re-snapshot + `teardownPersistentQuery('keep-alive setting toggled off')` guard (§2).
7. **`packages/server-core/src/sessions/SessionManager.ts`** — replace 1229 with the `keepBackgroundTasksAliveForced` field + getter/setter pair (§2); import `isKeepBackgroundTasksAliveEnabled` via the existing `@craft-agent/shared/agent` import at line 11.
8. **`packages/shared/src/protocol/channels.ts`** — add `bgAgents` group after `rtk` (~line 325). **`packages/shared/src/protocol/routing.ts`** — add both channels to `LOCAL_ONLY_CHANNELS` after the caching block (~line 157). **`apps/electron/src/shared/__tests__/ipc-channels.test.ts`** — add both channel strings (exhaustiveness gates).
9. **`packages/server-core/src/handlers/rpc/settings.ts`** — add both to `HANDLED_CHANNELS`; add handlers after the caching pair (~line 330) as in §2.
10. **`apps/electron/src/transport/channel-map.ts`** (~305) + **`apps/electron/src/shared/types.ts`** (~556) — client entries + types.
11. **`apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`** — state, load, handler, `SettingsToggle` + env-override hint (§2 placements).
12. **i18n, all 7 locales** (`packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json`) — the 3 keys from §2, translated per locale, inserted alphabetically (run `bun run scripts/sort-locales.ts` if present, then `bun run lint:i18n:parity && bun run lint:i18n:sorted && bun run lint:i18n:coverage`). Parity lint fails on any missing locale.
13. **Branding gate** — `scripts/check-branding.ts` rules are only `/Craft Agents?/`, `/craft\.do/i`, `/lukilabs/i`; `CRAFT_KEEP_BG_AGENTS_ALIVE` does not match and comments are skipped. Don't use the product name in the new UI strings (copy above is clean). No allowlist changes needed.
14. **Verify**: `bun run typecheck` (or CI equivalent); `cd packages/shared && bun test agent/backend/claude` (new + upstream `persistent-input.test.ts`); `cd packages/server-core && bun test background-task-surface` (must pass **unmodified**); ipc-channels + routing exhaustiveness tests; the three i18n lints; `bun run scripts/check-branding.ts`; build check. Manual smoke: toggle off in Settings → message a session with a running background agent → agent stops at that message; toggle back on → next message resumes persistent-query mode; set `CRAFT_KEEP_BG_AGENTS_ALIVE=0` and relaunch → toggle disabled with hint.

**Test-plan summary**: `keep-alive-setting.test.ts` — default-on, toggle-off honored, env precedence both directions, envOverride flag. Persistence round-trip — only if a storage test harness with temp CONFIG_DIR already exists; otherwise cover via manual smoke. `background-task-surface.test.ts` — regression gate, unmodified. `ipc-channels.test.ts` — new channels present.

---

## 5. Risks / open questions (with defaults)

1. **Toggle-off does not kill a session's already-running background agents until that session's next message** (per-turn snapshot). **Default: accept next-turn semantics** — self-healing, keeps turns internally consistent, UI copy states it plainly. Immediate global teardown (SET handler sweeping sessions) is a follow-up if the maintainer wants a harder kill.
2. **Upstream may ship its own keep-alive setting later.** **Default:** `craft-fork:bgAgents:*` namespace + isolated fork resolver file; on such a merge, adopt upstream's surface, migrate the stored key, delete `keep-alive-setting.ts`.
3. **Config read frequency** — live getter hits `loadStoredConfig()` a few times per turn + per background-task event; matches `getExtendedPromptCache` house pattern. **Default: ship without a cache**, measure later; add a TTL cache inside `keep-alive-setting.ts` only if hot.

---

**Bottom line:** app-level boolean in the app config (default ON), env var wins when explicitly set, two surgical hot-file edits (per-turn snapshot + teardown guard in `ClaudeAgent`; live getter with test-preserving setter in `SessionManager`), everything else additive under a `craft-fork:*` namespace. Effect timing: **next message per session, no restart**.

## Status log

- `2026-07-08` — created; background-agent keep-alive settings toggle designed and implemented (`craft-fork:bgAgents:*` namespace, isolated resolver file, app-level boolean default ON, env override).
- `2026-07-24` — closing to `done/`: the keep-alive toggle is shipped and live on `main` (actively defended in upstream-merge audits). Retroactive status log added; bookkeeping catch-up (ADR-0002).
