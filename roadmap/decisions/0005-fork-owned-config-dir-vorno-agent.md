---
id: ADR-0005
title: Fork default config dir is ~/.vorno-agent, with one-time copy migration
status: accepted
date: 2026-07-03
supersedes: []
superseded-by: []
---

# ADR-0005 — Fork default config dir is `~/.vorno-agent`, with one-time copy migration

## Context

Upstream Craft Agents and this fork both defaulted `CONFIG_DIR` to
`~/.craft-agent`. Running them side-by-side collides on
`~/.craft-agent/.server.lock` and cross-contaminates config, workspaces, and
credentials (LEARNING-002). The only mitigation was manually exporting
`CRAFT_CONFIG_DIR`, which a consulting client can never be required to do.
VOR-2 (VORNO M1 "Nameplate") makes isolation automatic.

## Decision

1. **Fork default is `~/.vorno-agent`** (same dot-dir-in-home convention as
   upstream on all platforms), named after the VORNO productization program.
   No env var is required.
2. **`CRAFT_CONFIG_DIR` remains the escape hatch and always wins** — used by
   multi-instance dev (`~/.craft-agent-1`, …) and `scripts/daily-driver.ts`,
   which deliberately shares upstream's `~/.craft-agent` in thin-client mode.
3. **One-time migration, copy-not-move**, implemented as a marker-file state
   machine in `packages/shared/src/config/config-dir-migration.ts` and run
   synchronously at module-eval of `config/paths.ts` (no partial-state launch
   window). Source precedence: `~/.craft-agent-swagatar` (unambiguously
   fork-originated dev data) then `~/.craft-agent`. Sources are read-only and
   checksum-verified byte-identical afterwards; a sha256 backup manifest is
   recorded in `.config-dir-migration.json`. Stale `.server.lock` and `logs/`
   are not carried over. Crash mid-copy → rollback (delete partial copy) and
   re-run on next start; a live concurrent migrator is awaited, then startup
   fails rather than launching half-migrated.
4. **`~/.claude/` is never read, written, moved, or re-keyed** — it is the
   Claude SDK native-resume store; migration copies sessions without re-keying
   so `claudeSessionId` references keep resolving.
5. Permission/path heuristics that recognized "inside the config dir" by the
   literal `.craft-agent` name now match both upstream's name and the active
   config dir basename (`CONFIG_DIR_NAME` from `config/paths.ts`).

## Consequences

- Fork and upstream stable coexist with zero shared state by default;
  prerequisite for shipping installers (VOR-2 customer value).
- Wire compatibility is unaffected — this is a local filesystem concern only.
- Slightly larger upstream-merge surface: `paths.ts` diverges, and a handful of
  previously hardcoded `~/.craft-agent` literals now route through
  `CONFIG_DIR` (docs, release-notes, workspaces default dir, window-state,
  interceptor, provider-domains cache, browser-tools prerequisite).
- Startup logs one line stating which dir is active and why
  (`[config-dir] Using … — …`) in both Electron main and headless server.
- LEARNING-002 is resolved; see that entry for the incident history.
