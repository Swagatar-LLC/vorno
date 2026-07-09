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
| [002](LEARNING-002-fork-vs-upstream-config-dir-collision.md) | Fork vs upstream stable collide on `~/.craft-agent/.server.lock` | electron / fork-isolation | resolved |
| [003](LEARNING-003-shared-subpath-exports-vite-enforced.md) | Shared subpath imports must be in `exports` or vite/webui build breaks | build | active |
| [004](LEARNING-004-live-fetch-pi-model-selection-mode.md) | Live-fetch Pi providers need both the refresh-guard bypass and the backfill mode-force | config/models | active |
| [005](LEARNING-005-clean-rebase-hides-cross-scope-import-drift.md) | A clean text-rebase can hide a broken cross-scope import after an upstream scope rename | build / upstream-sync | active |
| [006](LEARNING-006-bpm-gate-resolver-ordering-on-branch.md) | Browser-pane gate and resolver disagree when a session runs preflight before registration | server-core / sessions | active |
| [007](LEARNING-007-silent-void-command-handlers-mask-rejection.md) | Void-returning command handlers make rejections resolve as success, hiding the failure | server-core / RPC contract | active |
| [008](LEARNING-008-node-modules-sdk-drift-forces-async-subagents.md) | node_modules SDK drift past the lockfile silently changes live-spawned Claude Code behavior | agent | active |
| [009](LEARNING-009-per-app-tsconfig-paths-break-cross-package-reexports.md) | Per-app tsconfig paths silently break cross-package re-exports (TS2305 at consumers) | build/typecheck | active |
| [010](LEARNING-010-missing-nested-jiti-blocks-pi-agent-server-build.md) | Missing nested `jiti@2.7.0` breaks the pi-agent-server bundle after a Pi SDK bump (`Could not resolve: "jiti/static"`) | build | active |
| [013](LEARNING-013-ipc-channels-inventory-hand-maintained.md) | `ipc-channels` EXPECTED_CHANNELS is hand-maintained despite the "auto-generated" banner (referenced generator script doesn't exist) | tests | active |
| [014](LEARNING-014-shared-subpath-missing-from-package-exports.md) | A `@craft-agent/shared` subpath tsc resolves can still break `bun build` if it's missing from package.json `exports` | build | active |
| [015](LEARNING-015-packaged-smoke-verify-no-logs-single-instance.md) | Smoke-verifying the packaged app needs `--user-data-dir` isolation and can't rely on logs (production transports disabled) | electron | active |
| [016](LEARNING-016-bun-harness-electron-main-modules-dist-stub.md) | Electron main-process modules run under plain Bun for verification if `ELECTRON_OVERRIDE_DIST_PATH` stubs the missing dist (`require('electron')` throws otherwise) | electron | active |
| [017](LEARNING-017-electron-build-never-staged-pi-agent-server.md) | `electron:build` never staged pi-agent-server; dead staging helpers + config-dir-masked repro hid it | build | active |
| [018](LEARNING-018-embedded-host-does-not-serve-webhooks.md) | The packaged (embedded) trigger server does not serve `/hooks` — POST returns 401, not 202 (webhooks are standalone-only) | electron | active |

## Related skills

- [`capture-learning`](../../.agents/skills/capture-learning/SKILL.md) — scaffold a new learning entry from a fix you just shipped.
