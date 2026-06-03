---
id: PLAN-006
title: Per-session fast-mode toggle (Stages 2–4 of Opus 4.8 rollout)
status: done
direction: none
owner: jh
created: 2026-06-02
updated: 2026-06-03
related: []
blocked-by: []
---

# PLAN-006 — Per-session fast-mode toggle (Stages 2–4)

## Goal

Plumb a per-session `fastMode: boolean` through DTO/agent/UI surfaces and switch the network interceptor from its hardcoded `FEATURE_FLAGS.fastMode` to the per-session value, gated by `supportsFastMode`. Continuation of the Opus 4.8 rollout whose Stage 1 (capability hint + model registry entry) merged in PR #29.

## Scope

- **Stage 2 — protocol/agent plumbing**
  - DTOs: add optional `fastMode?: boolean` to the three session-config DTOs in `packages/shared/src/protocol/dto.ts` (lines ~76, 115, 515).
  - Control event: add `{ type: 'setFastMode'; enabled: boolean }` next to `setThinkingLevel` (`dto.ts:234`).
  - Prompt action variant: add `fastMode?: boolean` (`dto.ts:541`).
  - Session shapes: add `fastMode?: boolean` (`packages/shared/src/sessions/types.ts:147,263,348`) and add `'fastMode'` to the persisted-key array at line 38.
  - Base agent: add `_fastMode: boolean` field + getter/setter + ctor init from `config.fastMode ?? false`, plumbing into `spawn-session-tool` (`packages/shared/src/agent/base-agent.ts:100,183,275,490–494,1188` — every `_thinkingLevel` occurrence has a parallel).
  - Claude agent: surface `_fastMode` via a `getCurrentSessionFastMode()` accessor mirroring the `is1MContextEnabled()` precedent in `interceptor-common.ts`.
  - Mini/sub-agents (summarization) default to `_fastMode = false` regardless of parent.
- **Stage 2 — automation surface**
  - `packages/shared/src/automations/schemas.ts:29` — add `fastMode` to the prompt schema.
  - `packages/shared/src/automations/types.ts:69,258` — add `fastMode?: boolean`.
  - `packages/shared/src/automations/handlers/prompt-handler.ts` — when scheduled prompt has `fastMode: true`, emit an explicit log line. Tests in `prompt-handler.test.ts` assert the log fires.
- **Stage 2 — SDK delivery (revised 2026-06-02)**
  - The Pi-only interceptor (`unified-network-interceptor.ts`) does **not** see Claude SDK requests anymore (Claude SDK runs as a native binary since v0.2.113 — see `packages/shared/CLAUDE.md`). Original handoff plan to wire the interceptor was inert for Claude.
  - Replacement: pass `settings: { fastMode: this._fastMode, fastModePerSessionOptIn: true }` into the SDK `Options` at `claude-agent.ts:965` where the `options` object is built. The Claude Agent SDK's `Settings.fastMode` (sdk.d.ts:4898) and `Settings.fastModePerSessionOptIn` (sdk.d.ts:4902) natively implement the product spec — the SDK injects `body.speed = 'fast'` and the beta header itself.
  - `packages/shared/src/feature-flags.ts:62–64` — delete the now-unread `fastMode: false` entry.
  - Existing `shouldEnableFastMode` block at `unified-network-interceptor.ts:431,804–814` becomes dead code for the Claude path. Leave as-is for now (Pi-routed Anthropic, if any, still uses it). Cleanup is a separate concern, not blocking this plan.
- **Stage 3 — UI**
  - `apps/electron/src/renderer/hooks/useSessionOptions.ts` — add `fastMode: boolean` to `SessionOptions`, default `false`.
  - `apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx:398` — add a "Speed" section below Thinking, render only when `getModelSupportsFastMode(currentModel)` is true. Single Standard/Fast toggle with cost hint "Fast mode: ~2× output cost". New `onFastModeChange` prop.
  - Thread through `FreeFormInput.tsx`, `ChatDisplay.tsx`, `ChatPage.tsx`, `App.tsx` mirroring the `thinkingLevel` pattern.
  - i18n: add `chat.modelPicker.speedSection`, `speed.standard`, `speed.fast`, `speed.fastDesc` to `en.json` and the six other locales (`de`, `es`, `hu`, `ja`, `pl`, `zh-Hans`).
- **Stage 4 — validation & PR**
  - `tsc --noEmit` clean in `apps/server`.
  - `bun test` green in `apps/server` and `packages/shared`.
  - `bun build` succeeds for `apps/server` and `packages/pi-agent-server`.
  - Open PR against `Swagatar-LLC/craft-agents-oss` with two logically distinct commits (plumbing + UI) and call out upstream-ability.

## Non-goals

- Bedrock 4.8 IDs (still blocked on AWS docs ambiguity — `TODO(opus-4.8-bedrock)` stays).
- Confirmation dialog before activating fast mode (product decision: sticky per-session, no prompt).
- Bumping `@anthropic-ai/claude-agent-sdk` (`v0.2.123` is fine; SDK type doesn't yet list `'fast-mode-2026-02-01'` in `Options.betas` — interceptor sidesteps by mutating body/headers).
- Plumbing through `Options.betas` (will fight TypeScript; same trick as 1M-context).
- Removing `appendBetaHeader(..., FAST_MODE_BETA)` — that's a one-line change for whenever Anthropic GAs fast mode.

## Approach

Mirror `thinkingLevel` exactly for session-scoped DTO/agent plumbing. Delivery to Anthropic uses the Claude SDK's native `Settings.fastMode` field (no interceptor mutation needed). All edits are additive so the plumbing PR remains a clean upstream candidate once upstream adds Opus 4.8 to its MODEL_REGISTRY.

```mermaid
graph LR
    UI[CompactModelSelector toggle] --> Hook[useSessionOptions.fastMode]
    Hook --> DTO[SessionConfig DTO]
    DTO --> Agent[BaseAgent._fastMode]
    Agent --> SDK[Claude SDK Options.settings.fastMode]
    SDK --> API[Anthropic API body.speed='fast']
    Cap[getModelSupportsFastMode] --> UI
```

## Acceptance

- [ ] Stage 2 — DTO, session types, base-agent, claude-agent plumbing committed
- [ ] Stage 2 — automation schema + log line + tests
- [ ] Stage 2 — `claude-agent.ts` passes `settings.fastMode` + `fastModePerSessionOptIn` to SDK Options; `FEATURE_FLAGS.fastMode` removed
- [ ] Stage 3 — UI Speed section + i18n in all seven locales
- [ ] Tests added/updated (shared + server suites green)
- [ ] `bun build` succeeds for `apps/server` and `packages/pi-agent-server`
- [ ] PR opened against `Swagatar-LLC/craft-agents-oss` with two logical commits
- [ ] `roadmap/upstream/contribution-candidates.md` notes "fast-mode toggle" as planned upstream contribution

## Status log

- `2026-06-02` — created in `planned/`
- `2026-06-02` — moved to `in-progress/`, Stage 2 work starting on branch `jh/2026-06-02_fast-mode-toggle`
- `2026-06-02` — Stage 2 committed (`37e8813f`): DTO/agent/automation plumbing + SDK `Settings.fastMode` delivery; dead `FEATURE_FLAGS.fastMode` + interceptor block removed
- `2026-06-03` — Stage 3 committed (`721e28e4`): UI Speed toggle in `CompactModelSelector`, threading through `FreeFormInput`/`ChatDisplay`/`ChatPage`/`App`, `setFastMode` RPC + `SessionManager.setSessionFastMode`, i18n keys in all 7 locales
- `2026-06-03` — PR [#31](https://github.com/Swagatar-LLC/craft-agents-oss/pull/31) merged to `main`; moved to `done/`
