---
id: PLAN-004
title: Restore lint:i18n:coverage script (referenced but missing)
status: planned
direction: none
owner: jh
created: 2026-05-07
updated: 2026-05-07
related: [PLAN-003]
blocked-by: []
---

# PLAN-004 — Restore `lint:i18n:coverage` script

## Goal

Restore the missing `scripts/check-i18n-coverage.ts` so `bun run lint:i18n:coverage` (and therefore `bun run validate:ci`) runs cleanly, and so the documented "every `t('...')` callsite resolves against `en.json`" gate is actually enforced.

## Symptom

```
$ bun run lint:i18n:coverage
$ bun run scripts/check-i18n-coverage.ts
error: Module not found "scripts/check-i18n-coverage.ts"
error: script "lint:i18n:coverage" exited with code 1
```

References that expect the script to exist:

- `package.json` → `lint:i18n:coverage`
- `package.json` → `validate:ci` (chains parity + sorted + coverage)
- `packages/shared/CLAUDE.md` — documents three i18n gates; coverage is one of them
  > _"`parity` alone is insufficient — it can't detect symmetric losses across all locales … `coverage` closes that gap by verifying every literal `t(...)` / `i18n.t(...)` / `<Trans i18nKey>` reference resolves against `en.json`."_

Only `scripts/check-i18n-parity.ts` and `scripts/sort-locales.ts` are present in `scripts/`.

## Scope

- Add `scripts/check-i18n-coverage.ts` that:
  - Walks `apps/electron/src/**` and `packages/**/src/**` for `.ts`/`.tsx` files
  - Extracts literal call expressions: `t('...')`, `i18n.t('...')`, `<Trans i18nKey="...">` (template-literal / dynamic keys are skipped, matching the documented contract)
  - Loads `packages/shared/src/i18n/locales/en.json`
  - Errors if any literal key isn't present in `en.json`
- Ignore test fixtures and `node_modules`.
- Match exit-code behavior of `check-i18n-parity.ts` (exit 1 on mismatch).
- Confirm `.github/workflows/validate-pr.yml` runs `validate:ci` so the gate becomes binding (and update if not).

## Non-goals

- Refactoring the parity / sorted scripts.
- Adding new i18n features (pluralization checks, length budgets, etc.).
- Validating dynamic keys — explicitly out of scope per the existing contract.

## Approach

`scripts/check-i18n-parity.ts` is a reasonable scaffold for locale-loading and file-walking. The new script is mostly:

1. Walk source files (Bun's `Glob` or `node:fs` recursive read).
2. Regex-extract literal callsites. The set of call shapes is narrow enough that a regex pass is fine; keeps the script free of an AST dependency.
3. Diff extracted key set against `Object.keys(en.json)`; report missing keys with file:line locations.

## Acceptance

- [ ] `scripts/check-i18n-coverage.ts` exists and runs to completion on `main`
- [ ] `bun run lint:i18n:coverage` exits 0 on a clean tree
- [ ] Introducing a fake `t('this.key.does.not.exist')` callsite makes it exit 1 with a useful error
- [ ] `bun run validate:ci` runs all five gates without "module not found"
- [ ] Confirmed CI (`validate-pr.yml`) actually invokes the gate (or follow-up filed)

## Status log

- `2026-05-07` — created in `planned/`. Found while running pre-PR validation for PLAN-003 (PR #15). Issues disabled on the repo, so tracked as a plan.
