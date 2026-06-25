---
id: LEARNING-005
title: A clean text-rebase can hide a broken cross-scope import after an upstream scope rename
date: 2026-06-24
status: active
component: build / upstream-sync
related-plans: [PLAN-010-live-model-enumeration]
related-decisions: []
---

# LEARNING-005 — A clean rebase can hide a broken import after an upstream scope rename

## Signal

PR #36 (live model enumeration) was opened on 2026-06-09, before the v0.10.4
upstream merge that migrated the Pi SDK scope from the now-frozen
`@mariozechner/*` to the rebranded `@earendil-works/*` (see [[LEARNING-001]]).
Rebasing the 5-commit branch onto the current `main` (v0.10.4) reported
**"Successfully rebased"** with zero conflicts — yet the branch still contained:

```ts
// packages/shared/src/agent/backend/internal/drivers/pi.ts:281
const { getModels } = await import('@mariozechner/pi-ai');
```

The sibling import 96 lines down (`:377`, upstream code) had already been
rewritten to `@earendil-works/pi-ai` by the v0.10.4 merge.

## Root cause

git rebase resolves conflicts **line-by-line within a file**. The branch's new
`fetchOpenAiModelsLive` block was added in a region upstream never touched, so
there was no textual overlap and therefore no conflict — even though the import
*specifier* it introduced refers to a package scope that no longer exists in the
post-v0.10.4 dependency tree. A rename that happens in *other* lines of the same
file (or in `package.json`) is invisible to the merge algorithm.

## Why it's dangerous

- It's a **dynamic** `import()`, so it does not fail the bundler with a "No
  matching export" error the way a static `@earendil-works/*` symbol mismatch
  does (the [[LEARNING-001]] failure mode). It would have failed at **runtime**,
  on the first live OpenAI `/v1/models` catalog fetch — long after merge.
- `apps/server` typecheck stays green (the dynamic-import type is `any`-ish).
- Only a test that actually exercises the catalog path, or a runtime call,
  surfaces it.

## How to apply

When rebasing a fork branch that predates an upstream **dependency rename / scope
migration**, a clean rebase is *not* sufficient evidence of correctness. After
any rebase across a known scope migration:

1. `grep -rn '@mariozechner' <branch-touched files>` (and any other renamed
   scope) — catch specifiers the merge couldn't see.
2. Run the **feature's own tests**, not just `apps/server` — dynamic imports only
   fail where they're executed.
3. Re-run the `pi-agent-server` bundle build (the [[LEARNING-001]] check) as the
   backstop for static-symbol drift.

The general rule: **treat "rebased with no conflicts" across a dependency
rename as a yellow flag, not a green one.** Conflicts track lines, not meaning.
