# AGENTS.md — craft-agents-oss (Swagatar fork)

This file orients any AI agent (Codex, Claude Code, Pi Agent, etc.) that lands in this repo.

## What this repo is

A fork of [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss) maintained at [Swagatar-LLC/craft-agents-oss](https://github.com/Swagatar-LLC/craft-agents-oss). Bun monorepo with `packages/*` and `apps/*`.

We are **wire-compatible** with upstream and **deliberately divergent** on direction (canvas paradigm, contribution model, observability). See [`roadmap/decisions/0001-fork-relationship-with-upstream.md`](roadmap/decisions/0001-fork-relationship-with-upstream.md).

## First reads (in order)

1. [`roadmap/VISION.md`](roadmap/VISION.md) — where we're going and why
2. [`roadmap/README.md`](roadmap/README.md) — how the governance system works
3. [`roadmap/directions/`](roadmap/directions/) — active strategic directions
4. [`roadmap/plans/in-progress/`](roadmap/plans/in-progress/) — what's actively being built
5. [`packages/core/CLAUDE.md`](packages/core/CLAUDE.md), [`packages/shared/CLAUDE.md`](packages/shared/CLAUDE.md) — package-scoped notes
6. [`apps/electron/resources/AGENTS.md`](apps/electron/resources/AGENTS.md) — bundled-resources notes

## Skills (project-co-located)

The [`.agents/skills/`](.agents/skills/) directory contains skills that drive the roadmap workflow. Each `SKILL.md` is portable across Codex / Claude Code / Pi Agent.

- `roadmap-plan-create` — start a new plan
- `roadmap-plan-advance` — move a plan to a new status (folder)
- `roadmap-status` — print a roadmap overview
- `upstream-sync` — merge the latest upstream release
- `upstream-delta-report` — refresh the upstream delta report

When the user asks for any of those, read the matching `SKILL.md` first.

## Workflow defaults

- **Branch for feature work.** Branches are named `jh/<topic>` or `jh/<date>_<topic>`.
- **Commit at sizable changes.** Test incrementally.
- **Open PRs in our own repo for review.** Don't auto-submit upstream.
- **CI is green or it doesn't merge.** Validate workflow lives at `.github/workflows/validate-pr.yml`.
- **Plans before significant work.** Anything > half a day → write a plan via `[skill:roadmap-plan-create]`.

## Hard rules

- **Never break wire compatibility** with upstream's `MessageEnvelope`, `AgentEvent`, channel names, or skill schema unless an ADR sanctions it. See [`roadmap/upstream/compatibility.md`](roadmap/upstream/compatibility.md).
- **Never put secrets in commits.** Stop and ask if you encounter `.env`, credentials, API keys.
- **Never force-push.** Never amend merged commits.
- **Never skip hooks** (`--no-verify`) unless the user explicitly asks.
- **No marketing fluff in docs.** Plain technical English.
- **No emojis** unless the user explicitly asks.

## Build/test quick commands

```bash
# From repo root
bun install
bun run typecheck              # repo-wide; some pre-existing upstream errors are tolerated

# Per-package
cd packages/core && bunx tsc --noEmit
cd packages/shared && bunx tsc --noEmit
cd apps/server && bunx tsc --noEmit && bun test

# Build check (must succeed)
bun build apps/server/src/index.ts --target=bun --outdir=/tmp/build-check --no-splitting
```

## Visual fork indicator

This fork ships with a visible "FORK" badge in the desktop app (rust accent color) so it's never confused with the upstream stable build. The user runs both side-by-side. See [`roadmap/decisions/`](roadmap/decisions/) for the rationale and `apps/electron/src/renderer/components/fork-badge.tsx` for the implementation.

## When in doubt

Ask the user. If you must proceed, prefer additive, reversible, feature-flagged changes.
