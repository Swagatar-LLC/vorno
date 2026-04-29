# Skills

Project-co-located skills. Read by Claude Code, Codex, Pi Agent, and any other agent that follows the SKILL.md convention.

These are different from upstream's `apps/electron/resources/skills/` (which ship to user homes). Skills here are **product-management skills** — they drive the [`roadmap/`](../../roadmap/) workflow.

## Available skills

| Skill | Purpose |
|-------|---------|
| [roadmap-plan-create](roadmap-plan-create/SKILL.md) | Create a new plan in `roadmap/plans/planned/` |
| [roadmap-plan-advance](roadmap-plan-advance/SKILL.md) | Move a plan between status folders |
| [roadmap-status](roadmap-status/SKILL.md) | Print a roadmap overview |
| [upstream-sync](upstream-sync/SKILL.md) | Merge the latest upstream release |
| [upstream-delta-report](upstream-delta-report/SKILL.md) | Refresh `roadmap/upstream/delta.md` |

## How agents invoke these

- **Claude Code**: user references `[skill:slug]` in chat. Agent reads `SKILL.md` before acting.
- **Codex / OpenAI Codex CLI**: reads `AGENTS.md`. The root [`AGENTS.md`](../../AGENTS.md) lists these.
- **Pi Agent**: same convention as Codex (`AGENTS.md`-based).

All three should land at the same destination: read the SKILL.md, follow the procedure.
