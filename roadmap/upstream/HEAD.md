# Upstream HEAD

Snapshot of our most recent upstream sync.

## Current state

| Field | Value |
|-------|-------|
| Last merged upstream tag | `v0.9.2` |
| Last merged upstream commit | `8981384` |
| Merge PR | [Swagatar-LLC/craft-agents-oss#8](https://github.com/Swagatar-LLC/craft-agents-oss/pull/8) (merged 2026-05-07) |
| Merge commit on our `main` | `e0386fe` |
| Date synced | 2026-05-07 |

## Versions covered in last merge

- `v0.8.13`
- `v0.9.0`
- `v0.9.1`
- `v0.9.2`

(Substantial upstream churn — ~375 files changed, ~+39k / -3k lines across the four versions. Notable areas to audit per [`compatibility.md`](compatibility.md) include any files under `packages/shared/src/protocol/` and `packages/shared/src/agent/`. Spot audit on this merge: no wire/protocol contract changes affected our HTTP trigger server.)

## Versions covered in prior merge (PR #4, 2026-04-28)

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
