# Learnings

Captured debugging insights. When we root-cause a bug or recover from a recurring issue, the fix gets a markdown entry here so the next agent (or human) can recognize the **signal**, jump to the **fix**, and avoid re-debugging.

## When to capture

**Always.** Every time you:

- Diagnose a non-obvious build/runtime/test failure
- Fix something that's bitten you before (or that you anticipate will bite again)
- Solve a problem whose solution wasn't trivially derivable from the error message
- Find a workaround for upstream behavior

If the bug was a five-minute typo fix in your own code, skip it. If it required reading multiple files, comparing versions, or thinking about resolution order — capture it.

The act of writing the entry forces clarity. The artifact prevents re-debugging.

## Format

`LEARNING-NNN-short-kebab.md` — three-digit zero-padded ID.

Use [`_template.md`](_template.md). Frontmatter:

```yaml
---
id: LEARNING-NNN
title: short imperative title
date: YYYY-MM-DD
status: active        # active | resolved-upstream | obsolete
component: tag        # build | tests | upstream-sync | electron | server | agent | etc.
related-plans: []
related-decisions: []
---
```

Body sections (suggested):

- `## Signal` — exact error / symptom an agent or human would search for
- `## Root cause` — why it happens
- `## Fix` — exact remediation, ideally a code block
- `## Recurrence` — when/why it'll likely come back
- `## Prevention` — anything that would keep it from recurring
- `## References` — related plans, decisions, upstream issues

## Lifecycle

- **active** — still relevant; the fix is current.
- **resolved-upstream** — upstream landed a fix; we no longer need the workaround. Keep the entry for history.
- **obsolete** — the issue no longer applies (e.g., we removed the dependency).

Status changes belong in the frontmatter. Don't delete entries — historical context is the point.

## Index

| # | Title | Component | Status |
|---|-------|-----------|--------|
| [001](LEARNING-001-stale-nested-mariozechner-deps.md) | Stale nested `@mariozechner/*` deps in workspace packages | build / upstream-sync | active |
| [002](LEARNING-002-fork-vs-upstream-config-dir-collision.md) | Fork vs upstream stable collide on `~/.craft-agent/.server.lock` | electron / fork-isolation | active |
| [003](LEARNING-003-shared-subpath-exports-vite-enforced.md) | Shared subpath imports must be in `exports` or vite/webui build breaks | build | active |

## Related skills

- [`capture-learning`](../../.agents/skills/capture-learning/SKILL.md) — scaffold a new learning entry from a fix you just shipped.
