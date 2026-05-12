# Upstream HEAD

Snapshot of our most recent upstream sync.

## Current state

| Field | Value |
|-------|-------|
| Last merged upstream tag | `v0.9.3` |
| Last merged upstream commit | `c310624` |
| Merge PR | _pending — branch `jh/2026-05-12_Upstream_Merge`_ |
| Merge commit on our branch | `df477c4` |
| Date synced | 2026-05-12 |

## Versions covered in last merge

- `v0.9.3` — Mobile/compact UI rework, Manifest provider preset, oversized-tool-result poisoning fix (density-aware token estimator + `TOKEN_LIMIT=12000` for tool-result spill), Telegram polling auto-reconnect, WhatsApp audio attachments, `source_test` OAuth forwarding, GHCR/workflow namespace migration `lukilabs` → `craft-ai-agents`, repo-wide `lint:i18n:strings` scan, settings-icons cleanup.

(Single upstream commit but a large release — 242 files changed, ~+7.7k / -15.5k lines, much of the "deletion" diff is our fork-only roadmap/skills content that upstream doesn't carry. Single conflict resolved: `apps/electron/src/renderer/index.html` — combined upstream's `font-src data:` CSP addition with our fork title. Token-estimator changes apply to per-tool-result spill detection only and are independent of our session-level `ContextUsageIndicator` from PLAN-002/003.)

## Versions covered in prior merge (PR #8, 2026-05-07)

- `v0.8.13`
- `v0.9.0`
- `v0.9.1`
- `v0.9.2`

## Versions covered in PR #4 (2026-04-28)

- `v0.8.10` — Messaging Gateway (Telegram, WhatsApp), `WsRpcClient` in server-core, messaging RPC channels
- `v0.8.11` — Chat follow-ups extracted, LLM partial output handling, WhatsApp filter improvements
- `v0.8.12` — Pi agent restructuring, session drafts, URL safety, diff normalization, DeepSeek provider

## Standard conflicts seen

- `bun.lock` — resolved with `git checkout --theirs bun.lock && bun install`. Mechanical.
- `packages/shared/src/agent/options.ts` — historically conflicted with our `CLAUDECODE` env strip; now upstream-aligned via `buildClaudeSubprocessEnv()`. Re-check on each merge.

## Recurring post-sync issues

- **Stale nested `@mariozechner/*` deps** — see [LEARNING-001](../learnings/LEARNING-001-stale-nested-mariozechner-deps.md). Likely on every upstream sync that touches pi-agent versions. Fix: `rm -rf packages/{shared,server-core,pi-agent-server}/node_modules/@mariozechner`. The `[skill:upstream-sync]` skill should run a verification step after each merge.

## CI threshold notes

- `validate-pr.yml` shared-test thresholds last bumped to `2600 pass / 20 fail` to absorb upstream's i18n-parity additions and test growth. Revisit on the next major test addition.
