# CLAUDE.md — craft-agents-oss (Swagatar fork)

This is the root context file for Claude Code working in this repo. Mirrors [`AGENTS.md`](AGENTS.md) (which serves Codex / Pi Agent) with Claude-specific notes.

## What this repo is

A fork of [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss) maintained at [Swagatar-LLC/craft-agents-oss](https://github.com/Swagatar-LLC/craft-agents-oss). Bun monorepo. Wire-compatible with upstream, deliberately divergent on direction.

## Read these first

1. [`roadmap/VISION.md`](roadmap/VISION.md)
2. [`roadmap/README.md`](roadmap/README.md)
3. [`roadmap/directions/`](roadmap/directions/) — current strategic bets
4. [`roadmap/plans/in-progress/`](roadmap/plans/in-progress/) — active work
5. Package-scoped: [`packages/core/CLAUDE.md`](packages/core/CLAUDE.md), [`packages/shared/CLAUDE.md`](packages/shared/CLAUDE.md)

## Skills

Project skills live at [`.agents/skills/`](.agents/skills/). Reference with `[skill:<slug>]`.

- `roadmap-plan-create`
- `roadmap-plan-advance`
- `roadmap-plan-document`
- `roadmap-status`
- `capture-learning`
- `electron-prod-build`
- `upstream-sync`
- `upstream-delta-report`

When the user references one, read its `SKILL.md` *first* — tool calls are blocked until you do, and the procedures contain non-obvious details (especially around git state and conflict resolution).

## Workflow expectations

- Branch + commit + PR. Don't push directly to `main`.
- Plans for non-trivial work — see `[skill:roadmap-plan-create]`.
- Update the roadmap as state changes (a status folder move *is* the state change).
- The user runs upstream stable side-by-side. The desktop fork build has a visible "FORK" badge — leave it on.
- **ALWAYS capture debugging insights** when you fix a non-obvious bug. Use `[skill:capture-learning]` to write a `LEARNING-NNN` markdown in [`roadmap/learnings/`](roadmap/learnings/) before moving on. See the hard rule below.

## Hard rules

- Wire compatibility with upstream is a contract — see [`roadmap/upstream/compatibility.md`](roadmap/upstream/compatibility.md). Breaking it requires a new ADR.
- Pre-commit hooks are not skipped (`--no-verify` is for emergencies the user authorizes).
- Don't generate URLs you aren't confident in. Ask or grep.
- **Always record debugging insights during fixes.** When you root-cause a non-obvious bug, recover from a recurring issue, or work around upstream behavior, capture it in [`roadmap/learnings/`](roadmap/learnings/) as a `LEARNING-NNN` entry **before moving on**. Trivial typo fixes are exempt; anything that required reading multiple files, comparing versions, or reasoning about resolution order is not. The artifact prevents re-debugging the same issue next time.

## Where things live (high level)

- `apps/electron/` — desktop app (Electron + React + Jotai + Tailwind)
- `apps/server/` — our HTTP trigger server (HTTP/SSE + WebSocket dual transport)
- `apps/cli/` — CLI companion
- `packages/core/` — shared types
- `packages/shared/` — agent backends, sources, sessions, config
- `packages/server-core/` — upstream's server-core (handlers, transport client)
- `packages/server/` — upstream's headless server
- `packages/messaging-gateway/`, `packages/messaging-whatsapp-worker/` — upstream messaging gateway (synced from upstream as of v0.8.10)
- `packages/ui/` — shared UI components
- `roadmap/` — our governance system (plans, directions, decisions, discussions, upstream tracking)
- `.agents/skills/` — project-co-located skills

## CI

- `.github/workflows/validate-pr.yml` — typecheck, shared tests (threshold-based), server tests (strict), doc tools, i18n gates, branding gate, build check. **All seven must pass.**
- `.github/workflows/validate.yml` — disabled (`workflow_dispatch` only). Was upstream's broken Validate.

## Quick commands

```bash
bun install
cd apps/server && bun test
bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting
```
