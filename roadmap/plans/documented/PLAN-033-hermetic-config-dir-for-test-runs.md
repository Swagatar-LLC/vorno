---
id: PLAN-033
title: Hermetic CRAFT_CONFIG_DIR for all test runs
status: documented
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

- `[test] preload` bunfigs for `apps/electron`, `apps/server`, and
  `packages/server-core` (`packages/shared` already has one), reusing the
  proven `packages/shared/tests/setup/config-fixture.ts`. The server-core leg
  was found post-merge by the docs-hygiene review: `token-entropy.test.ts` →
  `headless-start` transitively evaluates `config/paths.ts`, and a fresh-HOME
  run created a full `.vorno-agent` tree (create/migrate writes, no credential
  clobber).
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
- [x] Guard test proven live: removing any of the three new bunfigs makes the
      corresponding `config-dir-guard.test.ts` fail.
- [x] `packages/server-core` leg hermetic: fresh-HOME run creates no config
      dir (pre-fix it created `.vorno-agent` with migration marker + subdirs).
- [x] Cross-package contract documented in `packages/shared/CLAUDE.md`
      (owner of `config/paths.ts`).
- [x] Dead module-scope env assignments removed; comments corrected.
- [x] Release skill states the hermeticity invariant.
- [x] All eight validate-pr gates green locally.
- [x] No packaged-app code in the diff (test infra + docs only → no release).

## Status log

- `2026-08-15` — created in `planned/`
- `2026-08-15` — moved from planned to in-progress: implementation on branch `jh/plan-033-test-hermeticity` (diagnosis pre-established in LEARNING-056, session 260815-prime-badger)
- `2026-08-15` — moved from in-progress to done: PR #149 merged (f8970c0b), all eight validate-pr gates green. No release required — test infra + docs only.
- `2026-08-15` — post-merge docs-hygiene review caught a fourth non-hermetic leg (`packages/server-core`, reached only via the `test:webui` script chain — it has no `test` script of its own); closed in PR #150 alongside this move (bunfig + guard + `packages/shared/CLAUDE.md` contract note). Residue, deliberately not fixed: `packages/server/src/__tests__/smoke.test.ts` reaches `config/paths` but spawns a subprocess and is not CI-run — latent, not live.
- `2026-08-15` — moved from done to documented: hermetic test-run config dir enforced across all four bun-test packages, with red-test guards. Docs touched: CLAUDE.md (CI section listed seven of the eight validate-pr jobs — added webui tests), packages/shared/CLAUDE.md (contract note, landed in PR #150). Code-review pass: staff-code-reviewer on the #149 diff; its two findings (server-core leg, contract-not-documented) were both closed in #150, which followed the review's own prescriptions.
