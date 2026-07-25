# Roadmap

The product brain of our Craft Agents fork. Markdown is the substrate; folders encode workflow state; skills self-drive the management.

## Layout

```
roadmap/
├── VISION.md                      # Where we're going, why, and what we won't do
├── directions/                    # Multi-quarter strategic bets ("Direction 1, 2, 3")
├── plans/                         # Active work, status = folder
│   ├── _template.md
│   ├── planned/                   # Drafted, not yet started
│   ├── in-progress/               # Actively being worked on
│   ├── blocked/                   # Waiting on external/dep work
│   ├── done/                      # Completed but not yet documented
│   └── documented/                # Completed AND user-facing docs landed
├── decisions/                     # ADRs (Architecture Decision Records)
│   └── _template.md
├── discussions/                   # Captured conversations, dossiers, research
└── upstream/                      # Tracking craft-ai-agents/craft-agents-oss
    ├── compatibility.md           # Wire/protocol commitments (public)
    └── README.md                  # How upstream tracking works
```

> **Public / private split.** This directory is the **public** roadmap
> (`Swagatar-LLC/vorno`). Internal-only material lives in the private repo
> **`Swagatar-LLC/vorno-internal`** (same subpaths):
>
> - `learnings/` — debugging insights (next id **030**; new LEARNINGs land there).
> - `upstream/HEAD.md`, `upstream/delta.md`, `upstream/contribution-candidates.md`
>   — upstream sync logs and owned-diff tracking.
> - A handful of internal plans and one discussion.
>
> Everything remaining under `roadmap/` here is public. Cross-links to internal
> material use the form `vorno-internal:learnings/LEARNING-NNN-...` (private repo).

## How to use this system

### As a human

- **Read [`VISION.md`](VISION.md) first** — that's the only doc that should rarely move.
- **Browse [`directions/`](directions/)** to see active strategic bets.
- **Browse [`plans/in-progress/`](plans/in-progress/)** to see what's actually being worked on.
- **Open a PR** to add a plan, advance a plan, or write a decision. The file move *is* the state change.

### As an agent (Codex, Claude Code, Pi Agent)

Skills in `.agents/skills/` self-drive this system. They're equally readable by Codex, Claude Code, and Pi Agent — the SKILL.md format is portable.

- `[skill:roadmap-plan-create]` — start a new plan
- `[skill:roadmap-plan-advance]` — move a plan to the next status (folder)
- `[skill:roadmap-status]` — print a status overview
- `[skill:upstream-sync]` — merge the latest upstream release
- `[skill:upstream-delta-report]` — refresh the upstream delta log (in `vorno-internal`)

The root `AGENTS.md` and `CLAUDE.md` point any agent that lands here at this system.

## Plan lifecycle

```
planned ──▶ in-progress ──▶ done ──▶ documented
                │
                └──▶ blocked ──▶ in-progress (when unblocked)
```

A plan **must** have frontmatter (id, title, status, direction, owner, created). The frontmatter `status` field always matches the folder it lives in — `roadmap-plan-advance` keeps them in sync via `git mv` + frontmatter rewrite.

## Decisions vs plans vs discussions vs learnings

- **Decision** — a load-bearing architectural commitment we'd need to revisit deliberately. Numbered, immutable once accepted (supersede with a new ADR).
- **Plan** — a unit of work moving through status folders. May be small or large.
- **Discussion** — captured thinking. Never authoritative; references for plans/decisions to draw from.
- **Learning** — a captured debugging insight: signal, root cause, fix, recurrence, prevention. Written *during the fix*, not after the project. Learnings now live in the private `vorno-internal` repo (`learnings/`, next id 030); see the hard rule in [`AGENTS.md`](../AGENTS.md).

## Upstream relationship

We are a fork of [craft-ai-agents/craft-agents-oss](https://github.com/craft-ai-agents/craft-agents-oss) at [Swagatar-LLC/vorno](https://github.com/Swagatar-LLC/vorno). We aim to:

1. Stay **wire/protocol compatible** with upstream as long as feasible (`MessageEnvelope`, `AgentEvent`, source/skill conventions).
2. Contribute portable improvements back upstream when valuable.
3. Diverge deliberately on direction (canvas paradigm, contribution model, observability) where upstream's product roadmap doesn't align.

See [`upstream/`](upstream/) for current sync state, owned diffs, and contribution candidates.
