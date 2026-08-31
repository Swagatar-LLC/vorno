---
id: ADR-0027
title: Lean on the OS  — filesystem and OS primitives for lifecycle chores
status: accepted
date: 2026-08-22
supersedes: []
superseded-by: []
---

# ADR-0027 — Lean on the OS: filesystem and OS primitives for lifecycle chores

## Context

Vorno keeps accumulating *lifecycle chores*: storage cleanup, TTL-based
eviction, retention windows, pruning of run artifacts. Each one, considered in
isolation, tempts a bespoke in-app subsystem — a scheduler here, a retention
manager there, a database to track ages somewhere else. The leaked-subprocess
incident (LEARNING-061 → PLAN-038) is the cautionary tale in both directions:
the *absence* of any lifecycle discipline stranded 243 subprocesses over nine
days, and the *fix* was not a new framework — it was a minute-tick sweep over
existing state with a TTL read from workspace settings.

Meanwhile the substrate underneath Vorno already solves most of this. The
production stack of every large system ultimately rests on an operating system
that has spent fifty years getting good at exactly these jobs: file mtimes are
free age-tracking, directories are free state machines (this roadmap's own
status folders are the proof), periodic processes (launchd, cron, systemd
timers) are free schedulers, and `mv` to an archive location is a free
retention policy. The product owner's framing: the big systems are literally
resting on top of Linux — why aren't we?

The forces to balance:

- Some lifecycle decisions require **app semantics** the OS cannot see —
  PLAN-038's quiescence guards (running background task, queued messages,
  pending auth handoff) are the canonical example. A file's mtime cannot tell
  you a session is mid-turn.
- Everything else — age, size, count, location — the filesystem already tracks,
  and re-tracking it in app state creates a second source of truth that drifts.

## Decision

**Lifecycle chores default to filesystem + OS primitives. App code participates
only where a decision requires app semantics.**

Concretely, the architectural lines:

| Concern | Owner | Mechanism |
|---|---|---|
| Age / staleness | OS | file mtime; no parallel age-tracking in app state |
| Workflow/lifecycle state | OS | directory location (status folders, archive dirs); a move *is* the state change |
| Scheduling of sweeps | OS-first | launchd/cron/systemd timers for host-level chores; in-process tickers only when the sweep must consult live app state |
| Retention / deletion | OS | sweep recipes over paths + mtimes; deletion is a recipe, and **preservation is a different, explicit recipe** (archive/move), never a flag buried in app config |
| Quiescence / in-flight safety | App | app code answers "is it safe to touch this now?"; the sweep asks, the app answers (PLAN-038's guards are the template) |

Candidate applications (each still gets its own design pass; this ADR sets the
default, not the schedule):

- **Idle runtime TTL eviction** (PLAN-038, shipped) — already conforms:
  TTL policy + quiescence guards in app code because the inputs are live app
  state; cited as the precedent for the guard split.
- **Session/artifact retention** — sweep recipes over workspace storage paths.
- **Workflow-run pruning** (PLAN-039's `runs/run-<id>/` layout) — age/count
  based recipes over run directories; a run worth keeping is *moved*, not
  flagged.
- **Share/upload retention** (PLAN-035 territory) — retention windows as
  scheduled recipes, not Worker-side bookkeeping.

**Portability note:** this decision consciously binds lifecycle machinery to
POSIX-flavored hosts (macOS, Linux). Windows portability of these mechanisms is
explicitly deprioritized by the product owner; if a future Windows target needs
lifecycle chores, it ports the *recipes*, not a new in-app subsystem.

## Consequences

### Positive

- Less app code to write, test, and leak: the OS's scheduler and filesystem are
  already debugged.
- One source of truth for age/state (the filesystem), eliminating drift between
  app bookkeeping and reality.
- Recipes are inspectable and composable — a user or agent can read a sweep
  script; nobody can read a scheduler thread.
- Consistent with the roadmap's own proven pattern (status folders) and the
  storage-provider seam's bias toward plain files (ADR-0018/0019).

### Negative

- Host-coupled: behavior depends on the host's timer infrastructure being
  configured (a missing launchd job fails silent — sweeps need a liveness
  check, e.g. a last-ran marker file that *itself* is just a file).
- Windows support for these mechanisms is explicitly out; that narrows the
  future porting surface.
- "A recipe per chore" can sprawl; recipes need a home and an inventory
  (a `recipes/` or ops-doc convention — first real application should establish
  it).

### Neutral

- Storage providers that are *not* local filesystems (ADR-0018 seam) will need
  provider-side equivalents (e.g. R2 lifecycle rules — which are themselves the
  platform's "lean on the OS" analogue, reinforcing the principle).

## Alternatives considered

- **In-app lifecycle manager** (scheduler + retention DB) — rejected: rebuilds
  cron and mtime with more code and a second source of truth; the class of bug
  it invites (LEARNING-061) is the class it claims to fix.
- **External job system** (Temporal-style) — rejected for the same reason at
  higher cost; also conflicts with DIR-05's "no second engine" non-goal.
- **Per-feature ad-hoc decisions** (status quo) — rejected: each chore
  relitigates the same question; this ADR is the reusable answer.

## References

- PLAN-038 (idle runtime TTL eviction — shipped precedent)
- LEARNING-061 (`vorno-internal:learnings/`) — the incident that proved the need
- DIR-05 (`../directions/05-workflows-and-headroom.md`) — workflow-run pruning
- ADR-0018 / ADR-0019 — storage seam's plain-file bias
