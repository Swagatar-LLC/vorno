# CLAUDE.md — craft-agents-oss (Swagatar fork)

This is the root context file for Claude Code working in this repo. Mirrors [`AGENTS.md`](AGENTS.md) (which serves Codex / Pi Agent) with Claude-specific notes.

## What this repo is

A fork of [craft-ai-agents/craft-agents-oss](https://github.com/craft-ai-agents/craft-agents-oss) maintained at [Swagatar-LLC/vorno](https://github.com/Swagatar-LLC/vorno). Bun monorepo. Wire-compatible with upstream, deliberately divergent on direction.

## Read these first

1. [`roadmap/VISION.md`](roadmap/VISION.md)
2. [`roadmap/README.md`](roadmap/README.md)
3. [`roadmap/directions/`](roadmap/directions/) — current strategic bets
4. [`roadmap/plans/in-progress/`](roadmap/plans/in-progress/) — active work
5. [`roadmap/suvs/README.md`](roadmap/suvs/README.md) — the shippable unit you actually work in
6. Package-scoped: [`packages/core/CLAUDE.md`](packages/core/CLAUDE.md), [`packages/shared/CLAUDE.md`](packages/shared/CLAUDE.md)

## Skills

Project skills live at [`.agents/skills/`](.agents/skills/). Reference with `[skill:<slug>]`.

- `roadmap-plan-create`
- `roadmap-suv-create`
- `roadmap-plan-advance` (serves plans *and* SUVs)
- `roadmap-plan-document`
- `roadmap-status`
- `capture-learning`
- `electron-prod-build`
- `upstream-sync`
- `upstream-delta-report`
- `release-and-version`

When the user references one, read its `SKILL.md` *first* — tool calls are blocked until you do, and the procedures contain non-obvious details (especially around git state and conflict resolution).

## The work ladder

```
DIR ──▶ ADR ──▶ PLAN ──▶ SUV ──▶ task.yaml
```

- **DIR** — a multi-quarter strategic bet.
- **ADR** — a shape we'd need another ADR to change.
- **PLAN** — a **feature**. Spans multiple PRs.
- **SUV** — a **Shippable Unit of Value**: what one PR closes. One owning plan,
  a checkable acceptance list, at most one task definition. Lives in
  `roadmap/suvs/<status>/`.
- **task.yaml** — the executable DAG, defined at
  `roadmap/suvs/definitions/SUV-NNNN.task.yaml` and published into a workspace.

**If you are asked to advance a plan, work at SUV granularity. Do not invent
your own scope.** Read the plan's `related-suvs:`, pick one, and ship exactly
that. If no SUV covers the next step, cut one first with
`[skill:roadmap-suv-create]` and get it agreed — decomposing is a separate act
from executing. A plan cannot express a scope small enough to be a PR; that is
what the SUV level is for. See [ADR-0028](roadmap/decisions/0028-suv-as-the-shippable-unit-between-plan-and-task.md).

## Workflow expectations

- Branch + commit + PR. Don't push directly to `main`.
- Plans for non-trivial work — see `[skill:roadmap-plan-create]`.
- SUVs before execution — see `[skill:roadmap-suv-create]`. One SUV, one PR.
- Update the roadmap as state changes (a status folder move *is* the state change).
- The user runs upstream stable side-by-side. The fork is distinguished by its own branding (Vorno name, icon, tray identity); the old "FORK" accent stripe was removed 2026-07-14 at Jeff's request — do not reintroduce it.
- **ALWAYS capture debugging insights** when you fix a non-obvious bug. Use `[skill:capture-learning]` to write a `LEARNING-NNN` markdown in [`roadmap/learnings/`](roadmap/learnings/) before moving on. See the hard rule below.

## Hard rules

- **Never self-scope a plan.** Execution happens at SUV granularity (ADR-0028). Cut the SUV, then ship it.
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
- `roadmap/` — our governance system (directions, decisions, plans, SUVs, discussions, upstream tracking)
- `.agents/skills/` — project-co-located skills

## CI

- `.github/workflows/validate-pr.yml` — typecheck, shared tests (threshold-based), server tests (strict), webui tests (strict), share Worker tests (strict), doc tools, i18n gates, branding gate, Headroom boundary gate, build check. **All ten must pass.**
- `.github/workflows/validate.yml` — disabled (`workflow_dispatch` only). Was upstream's broken Validate.

## Quick commands

```bash
bun install
cd apps/server && bun test
bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting
```
