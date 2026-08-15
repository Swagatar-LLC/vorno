---
id: PLAN-033
title: Hermetic CRAFT_CONFIG_DIR for all test runs
status: in-progress
direction: DIR-03
owner: jh
created: 2026-08-15
updated: 2026-08-15
related: []
blocked-by: []
---

# PLAN-033 — Hermetic CRAFT_CONFIG_DIR for all test runs

## Goal

No `bun test` invocation in any package can ever read or write the live config
directory — the entire LEARNING-056 bug class becomes a red test instead of a
silent live-credential rewrite.

## Scope

- `[test] preload` bunfigs for `apps/electron` and `apps/server` (the two
  test-running packages without one; `packages/shared` already has it), reusing
  the proven `packages/shared/tests/setup/config-fixture.ts`.
- Delete the dead module-scope `process.env.CRAFT_CONFIG_DIR = …` lines that ES
  import hoisting defeats (`apps/electron/src/main/webui/__tests__/{handler,settings.e2e,supervisor}.test.ts`,
  `apps/server/tests/unit/config.test.ts`) and correct the misleading comments —
  especially supervisor.test.ts's claim that routing through `save/loadServerConfig`
  is the safe choice (it was precisely the hazard).
- `config-dir-guard.test.ts` in both suites: assert the frozen `CONFIG_DIR`
  resolves under `os.tmpdir()`, fail loudly otherwise.
- Release-skill pre-flight note: the hermeticity invariant, and what to do if
  the guard fires on the daily driver.

## Non-goals

- No shipped product code changes (`config/paths.ts` module-eval freeze stays —
  it is load-bearing app behavior).
- No fix for the trigger-server `beforeAll` + dynamic-import test pattern's
  shared-registry fragility (isolation-run documented, preload makes it safe).
- Auth-log source-IP observability gap — separate follow-up if pursued.

## Approach

`CONFIG_DIR` freezes at module-eval of `packages/shared/src/config/paths.ts`;
a bunfig `[test]` preload is the only hook that runs before any module graph
evaluates. Bun reads bunfig.toml from cwd only (verified empirically on bun
1.3.8 — the repo-root bunfig's top-level `preload` is not applied by `bun test`
even from the root cwd), so each package that runs `bun test` from its own cwd
needs its own bunfig. Full diagnosis, evidence, and verification harness:
LEARNING-056 (vorno-internal).

## Acceptance

- [x] Sandboxed repro (sentinel config + `HOME` override): before the fix,
      `bun test src/main/webui` rewrites the sentinel password and wipes apiKeys
      with 85 pass / 0 fail; after the fix, sentinel intact across all four
      `test:webui` legs and the full `apps/server` suite.
- [x] Guard test proven live: removing either bunfig makes the corresponding
      `config-dir-guard.test.ts` fail.
- [x] Dead module-scope env assignments removed; comments corrected.
- [x] Release skill states the hermeticity invariant.
- [x] All eight validate-pr gates green locally.
- [x] No packaged-app code in the diff (test infra + docs only → no release).

## Status log

- `2026-08-15` — created in `planned/`
- `2026-08-15` — moved from planned to in-progress: implementation on branch `jh/plan-033-test-hermeticity` (diagnosis pre-established in LEARNING-056, session 260815-prime-badger)
