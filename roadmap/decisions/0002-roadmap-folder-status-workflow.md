---
id: ADR-0002
title: Roadmap-as-files, plans-as-folder-status
status: accepted
date: 2026-04-28
supersedes: []
superseded-by: []
---

# ADR-0002 — Roadmap-as-files, plans-as-folder-status

## Context

We need a roadmap and product-management substrate for the fork that:

- Lives in the repo (versioned, reviewable, branchable).
- Is portable across agents (Codex, Claude Code, Pi Agent — and future tooling).
- Is human-readable without rendering or a server.
- Has a state model that's hard to corrupt and easy to enforce.

Tools like Linear, Notion, and Jira are valuable, but they create source-of-truth ambiguity ("is the doc the truth or is the ticket?"). We've chosen to put the truth in the repo.

## Decision

**The roadmap is markdown files in `roadmap/`.** Plans are markdown files whose **folder is the status**. Skills in `.agents/skills/` are the self-driving mechanism.

- `roadmap/VISION.md` — long-lived north star.
- `roadmap/directions/` — multi-quarter strategic bets.
- `roadmap/plans/{planned,in-progress,blocked,done,documented}/` — folder is status.
- `roadmap/decisions/` — ADRs (this file is one).
- `roadmap/discussions/` — captured thinking, dossiers, research.
- `roadmap/upstream/` — upstream sync state and tracking.
- `.agents/skills/roadmap-*` — agent-readable skills that perform plan create/advance/status moves via `git mv` + frontmatter rewrite.

## Consequences

### Positive

- Truth is in git. Diffs are reviewable. History is permanent.
- Equally accessible to humans and agents.
- No external service dependency. Works offline. Survives any single tool's deprecation.
- The state-as-folder pattern is impossible to leave half-set: either the file is in the right folder or it's not.

### Negative

- No first-class search or query layer (mitigated by the eventual `roadmap-status` skill).
- No automatic notifications or reminders.
- Multi-person collaboration requires PR coordination rather than real-time editing.

### Neutral

- We may later add an interactive view (a static-site generator over `roadmap/`, or a Craft skill that renders this as a canvas — fitting Direction 1+2). The markdown stays the source of truth.

## Alternatives considered

- **Linear or similar SaaS.** Rejected: source-of-truth ambiguity, external dependency, agents can't operate it natively.
- **Frontmatter-only state, single folder.** Rejected: easier to leave inconsistent ("file says in-progress but it's not really"). Folder-as-status is harder to lie about.
- **Issues + Projects on GitHub.** Rejected: outside the repo, weaker for offline + agentic workflows. We may sync select items there for visibility, but the truth lives here.

## References

- [`roadmap/README.md`](../README.md)
- [`roadmap/plans/README.md`](../plans/README.md)
- ADR-0001 (fork posture) — the reason this lives in our repo.
