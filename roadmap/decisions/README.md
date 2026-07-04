# Decisions

Architecture Decision Records (ADRs). Numbered, immutable once accepted, superseded by new ADRs.

## When to write one

- A load-bearing architectural commitment we'd need to revisit deliberately.
- A choice between two or more viable options that future contributors should understand the *why* of.
- A protocol/wire commitment that has external implications (e.g., upstream compatibility).

## Format

`NNNN-short-kebab-title.md` — four-digit zero-padded ID, kebab-case slug.

Use [`_template.md`](_template.md) as a starting point.

## Lifecycle

```
proposed ──▶ accepted ──▶ (superseded by NNNN)
                │
                └──▶ rejected
```

Status is in frontmatter. **Never edit an `accepted` ADR's substance** — supersede with a new one. Cosmetic fixes (typos, broken links) are fine.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-fork-relationship-with-upstream.md) | Fork relationship with upstream | accepted |
| [0002](0002-roadmap-folder-status-workflow.md) | Roadmap-as-files, plans-as-folder-status | accepted |
| [0003](0003-canvas-as-paradigm-direction.md) | Canvas as the paradigm direction | accepted |
| [0004](0004-sessionevent-extensible-union-and-renderer-mirroring.md) | SessionEvent extensible union & renderer mirroring | accepted |
| [0005](0005-fork-owned-config-dir-vorno-agent.md) | Fork-owned config dir `~/.vorno-agent` + one-time copy migration | accepted |
