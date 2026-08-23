# AGENTS.md — craft-agents-oss (Swagatar fork)

This file orients any AI agent (Codex, Claude Code, Pi Agent, etc.) that lands in this repo.

## What this repo is

A fork of [craft-ai-agents/craft-agents-oss](https://github.com/craft-ai-agents/craft-agents-oss) maintained at [Swagatar-LLC/vorno](https://github.com/Swagatar-LLC/vorno). Bun monorepo with `packages/*` and `apps/*`.

We are **wire-compatible** with upstream and **deliberately divergent** on direction (canvas paradigm, contribution model, observability). See [`roadmap/decisions/0001-fork-relationship-with-upstream.md`](roadmap/decisions/0001-fork-relationship-with-upstream.md).

## First reads (in order)

1. [`roadmap/VISION.md`](roadmap/VISION.md) — where we're going and why
2. [`roadmap/README.md`](roadmap/README.md) — how the governance system works
3. [`roadmap/directions/`](roadmap/directions/) — active strategic directions
4. [`roadmap/plans/in-progress/`](roadmap/plans/in-progress/) — what's actively being built
5. [`roadmap/suvs/README.md`](roadmap/suvs/README.md) — the shippable unit you actually work in
6. [`packages/core/CLAUDE.md`](packages/core/CLAUDE.md), [`packages/shared/CLAUDE.md`](packages/shared/CLAUDE.md) — package-scoped notes
7. [`apps/electron/resources/AGENTS.md`](apps/electron/resources/AGENTS.md) — bundled-resources notes

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

## Skills (project-co-located)

The [`.agents/skills/`](.agents/skills/) directory contains skills that drive the roadmap workflow. Each `SKILL.md` is portable across Codex / Claude Code / Pi Agent.

- `roadmap-plan-create` — start a new plan
- `roadmap-suv-create` — cut a Shippable Unit of Value out of an owning plan
- `roadmap-plan-advance` — move a plan **or an SUV** to a new status (folder)
- `roadmap-plan-document` — update docs for a shipped plan, code-review the merged diff, advance `done/` → `documented/`
- `roadmap-status` — print a roadmap overview
- `capture-learning` — scaffold a `LEARNING-NNN` debugging-insight entry
- `electron-prod-build` — produce a local production-mode Electron build for hands-on QA
- `upstream-sync` — merge the latest upstream release
- `upstream-delta-report` — refresh the upstream delta report
- `release-and-version` — cut a Vorno release: SemVer bump across workspace packages, release notes, tag-triggered `release.yml`

When the user asks for any of those, read the matching `SKILL.md` first.

## Workflow defaults

- **Branch for feature work.** Branches are named `jh/<topic>` or `jh/<date>_<topic>`.
- **Commit at sizable changes.** Test incrementally.
- **Open PRs in our own repo for review.** Don't auto-submit upstream.
- **CI is green or it doesn't merge.** Validate workflow lives at `.github/workflows/validate-pr.yml`.
- **Plans before significant work.** Anything > half a day → write a plan via `[skill:roadmap-plan-create]`.
- **SUVs before execution.** A plan is decomposed into SUVs via `[skill:roadmap-suv-create]`; one SUV is one PR. Never execute a plan directly.
- **ALWAYS capture debugging insights.** After root-causing any non-obvious bug or recovering from a recurring issue, write a `LEARNING-NNN` entry in [`roadmap/learnings/`](roadmap/learnings/) before moving on — see the hard rule below and `[skill:capture-learning]`.

## Hard rules

- **Never break wire compatibility** with upstream's `MessageEnvelope`, `AgentEvent`, channel names, or skill schema unless an ADR sanctions it. See [`roadmap/upstream/compatibility.md`](roadmap/upstream/compatibility.md).
- **Never self-scope a plan.** Execution happens at SUV granularity (ADR-0028). Cut the SUV, then ship it.
- **Never put secrets in commits.** Stop and ask if you encounter `.env`, credentials, API keys.
- **Never force-push.** Never amend merged commits.
- **Never skip hooks** (`--no-verify`) unless the user explicitly asks.
- **No marketing fluff in docs.** Plain technical English.
- **No emojis** unless the user explicitly asks.
- **ALWAYS record debugging insights during fixes.** When you root-cause a non-obvious bug, recover from a recurring issue, or work around upstream behavior, capture the insight in [`roadmap/learnings/`](roadmap/learnings/) as a `LEARNING-NNN` entry **before moving on**. Trivial typo fixes are exempt; anything that required reading multiple files, comparing versions, or reasoning about resolution order is not. Use `[skill:capture-learning]` to scaffold the entry. The artifact prevents the next agent (you, or another) from re-debugging the same issue.

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

The fork is distinguished from upstream stable by its own branding (Vorno name, app icon, tray identity). The user runs both side-by-side. The earlier "FORK" accent stripe (`fork-badge.tsx`) was removed 2026-07-14 at Jeff's request — do not reintroduce it.

## When in doubt

Ask the user. If you must proceed, prefer additive, reversible, feature-flagged changes.
