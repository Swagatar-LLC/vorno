# Skills

Project-co-located skills. Read by Claude Code, Codex, Pi Agent, and any other agent that follows the SKILL.md convention.

These are different from upstream's `apps/electron/resources/skills/` (which ship to user homes). Skills here are **product-management skills** — they drive the [`roadmap/`](../../roadmap/) workflow.

## Available skills

| Skill | Purpose |
|-------|---------|
| [roadmap-plan-create](roadmap-plan-create/SKILL.md) | Create a new plan in `roadmap/plans/planned/` |
| [roadmap-suv-create](roadmap-suv-create/SKILL.md) | Cut a Shippable Unit of Value out of an owning plan into `roadmap/suvs/planned/` |
| [roadmap-plan-advance](roadmap-plan-advance/SKILL.md) | Move a plan **or an SUV** between status folders |
| [roadmap-plan-document](roadmap-plan-document/SKILL.md) | Update docs for a shipped plan, code-review the merged diff, advance `done/` → `documented/` |
| [roadmap-status](roadmap-status/SKILL.md) | Print a roadmap overview |
| [capture-learning](capture-learning/SKILL.md) | Scaffold a `LEARNING-NNN` debugging-insight entry |
| [electron-prod-build](electron-prod-build/SKILL.md) | Produce a local production-mode Electron build for hands-on QA |
| [upstream-sync](upstream-sync/SKILL.md) | Merge the latest upstream release |
| [upstream-delta-report](upstream-delta-report/SKILL.md) | Refresh `roadmap/upstream/delta.md` |
| [release-and-version](release-and-version/SKILL.md) | Cut a Vorno release: SemVer bump across workspace packages, release notes, tag-triggered `release.yml` |

## How agents invoke these

- **Claude Code**: user references `[skill:slug]` in chat. Agent reads `SKILL.md` before acting.
- **Codex / OpenAI Codex CLI**: reads `AGENTS.md`. The root [`AGENTS.md`](../../AGENTS.md) lists these.
- **Pi Agent**: same convention as Codex (`AGENTS.md`-based).

All three should land at the same destination: read the SKILL.md, follow the procedure.
