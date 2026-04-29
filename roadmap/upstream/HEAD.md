# Upstream HEAD

Snapshot of our most recent upstream sync.

## Current state

| Field | Value |
|-------|-------|
| Last merged upstream tag | `v0.8.12` |
| Last merged upstream commit | `d9c585b` |
| Merge PR | [Swagatar-LLC/craft-agents-oss#4](https://github.com/Swagatar-LLC/craft-agents-oss/pull/4) (merged 2026-04-28) |
| Merge commit on our `main` | `4e6cf10` |
| Date synced | 2026-04-28 |

## Versions covered in last merge

- `v0.8.10` — Messaging Gateway (Telegram, WhatsApp), `WsRpcClient` in server-core, messaging RPC channels
- `v0.8.11` — Chat follow-ups extracted, LLM partial output handling, WhatsApp filter improvements
- `v0.8.12` — Pi agent restructuring, session drafts, URL safety, diff normalization, DeepSeek provider

## Standard conflicts seen

- `bun.lock` — resolved with `git checkout --theirs bun.lock && bun install`. Mechanical.
- `packages/shared/src/agent/options.ts` — historically conflicted with our `CLAUDECODE` env strip; now upstream-aligned via `buildClaudeSubprocessEnv()`. Re-check on each merge.

## CI threshold notes

- `validate-pr.yml` shared-test thresholds last bumped to `2600 pass / 20 fail` to absorb upstream's i18n-parity additions and test growth. Revisit on the next major test addition.
