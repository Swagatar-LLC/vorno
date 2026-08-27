---
id: SUV-0017
title: Workspace settings UI for Headroom
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-27
related: []
blocked-by:
  - SUV-0016-headroom-config-schema-storage-and-precedence.md (the schema and storage this UI edits)
---

# SUV-0017 — Workspace settings UI for Headroom

## Goal

Give each workspace a settings surface to enable/disable Headroom and edit its
integration options, persisted through the SUV-0016 storage.

## Scope

- A Headroom section in the Electron workspace settings UI (`apps/electron`):
  enable/disable toggle plus controls for the SUV-0016 option fields.
- Each field shows its effective value and where it came from — workspace
  override vs instance default — and a workspace override can be cleared back
  to the instance default.
- Reads and writes go through the SUV-0016 storage and resolver only; the UI
  holds no config logic of its own.
- Deliberately out: editing the instance base config (shown as defaults only —
  its editing surface is decided with the server-hosted end-state), and any
  runtime effect of the toggle (SUV-0018).

## Acceptance

- [x] Workspace settings show a Headroom section with an enable/disable toggle and the SUV-0016 option fields; changes persist via the SUV-0016 storage and survive an app restart.
- [x] Each field indicates whether its effective value comes from a workspace override or the instance default, and clearing an override reverts the display to the instance value.
- [x] Two workspaces hold independent Headroom settings — a test (or scripted scenario) toggles Headroom on in one workspace and verifies the other still resolves to disabled.
- [x] The section renders and saves correctly when no Headroom config exists yet (fresh install path), defaulting the toggle to off.

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-26` — implemented on `plan/plan-040`; moved to `in-progress/` (PR not
  yet cut). All four acceptance items met.

  **Shape.** The section is a pure view over SUV-0016. `resolveHeadroomConfigSources()`
  (new, beside the resolver in `packages/core/src/types/headroom.ts`, still
  import-free) reports per-field provenance using the *same* validation and the
  *same* precedence as `resolveHeadroomConfig()`, so the label can never
  disagree with the value it labels. `loadHeadroomConfigView()`
  (`packages/shared/src/workspaces/headroom.ts`) bundles what an editor needs:
  `effective`, `instanceEffective` (what a cleared field reverts to),
  `sources`, and the raw stored `overrides`. The renderer resolves nothing.

  **Three-valued source, two-valued label.** A field's value comes from the
  workspace layer, the instance base, or the built-in disabled default. The
  resolver reports all three; the UI folds `instance` and `default` into
  "Instance default", because from a workspace's point of view they are the
  same thing — a value it does not set. Encoding the fold in the data model
  would have thrown away information no caller could recover.

  **Read/write split in the DTO.** `WorkspaceSettings.headroom` is the writable
  override layer (symmetric with every other key — what you read is what you
  may write); `WorkspaceSettings.headroomView` is the derived, read-only
  companion. The first shape folded both into one key and broke the generic
  `updateWorkspaceSetting<K>(key, value)` contract, which typecheck caught.
  The write is validated by `sanitizeHeadroomConfigLayer()` itself, so the
  write surface and the read-time resolver cannot disagree; unknown keys pass
  deliberately, and the UI spreads the *raw* stored layer on edit, so a key
  written by a newer build survives a round-trip through an older one.

  **Deliberately out, and honoured:** no instance-base editor (shown as
  defaults only), and no runtime effect — nothing added here reads the toggle.
  `loadEffectiveHeadroomConfig()` still has no consumers; SUV-0018 wires it.

  **Tests — 37 new, red-then-green verified.** With `headroom.ts` (core),
  `workspaces/headroom.ts`, and `rpc/settings.ts` reverted to `HEAD` (copied to
  a temp dir and restored — no `git stash`, ever, in this repo) all four new
  suites went red. Restoring core+shared but keeping `settings.ts` at `HEAD`
  gave the sharper, *behavioural* red on the RPC suite: every case failed with
  `Invalid workspace setting key: headroom`. Restored → all green.
  - `packages/shared/src/config/__tests__/headroom-sources.test.ts` (7) —
    provenance, including the property that the reported source always names
    the layer the resolver actually took the value from.
  - `packages/shared/src/workspaces/__tests__/view-headroom.test.ts` (8) —
    the view end-to-end against a real config dir in a subprocess with
    `CRAFT_CONFIG_DIR` set (LEARNING-056): fresh install, provenance,
    clear-reverts-to-instance, and **two workspaces resolving independently**
    both with and without a shared instance base.
  - `packages/server-core/src/handlers/rpc/settings-headroom.test.ts` (14) —
    the exact IPC path the UI uses. Each read/write goes through a *fresh*
    handler registration, which is the honest unit-test stand-in for "survives
    an app restart": nothing is cached between the write and the read.
  - `apps/electron/src/renderer/lib/__tests__/headroom-settings.test.ts` (8) —
    the fresh-install render path (`view === undefined` → toggle off, all
    fields present) and the override-layer arithmetic.

  **Gates, all run and green:** `bun run typecheck:ci`, `bun run test:shared`
  (3531 pass / 0 fail), `bun run test:server` (196 / 0), `bun run test:webui`
  (349 / 0), `lint:i18n:parity` + `:sorted` + `:coverage`, `lint:branding`,
  the `apps/server` build check, and `eslint` on the four touched
  `apps/electron` files (0 errors; the one `exhaustive-deps` warning is
  pre-existing at `HEAD`). 16 keys added to all 7 locales.
  `typecheck:electron` is **not** in `typecheck:ci` and has pre-existing errors
  on `HEAD` in unrelated files; it reports none for this change.

  **Note for the reviewer (superseded in part by the 2026-08-27 entry below —
  three of its numbers were wrong):** SUV-0015 was being worked concurrently in this
  same checkout. Its files (`packages/core/src/types/headroom-adapter.ts`,
  `packages/shared/src/headroom/`, `scripts/check-headroom-boundary.ts`,
  `packages/shared/package.json`, `packages/shared/src/__tests__/headroom-pin.test.ts`)
  appeared in the working tree mid-run and were left untouched; they are **not**
  in this commit. `packages/core/src/types/index.ts` carries both SUVs' export
  blocks, so only this SUV's hunk was staged.

- `2026-08-27` — re-verified on `plan/plan-040` after the previous run's evidence
  was rejected as unreproducible, and one acceptance gap closed. The 2026-08-26
  implementation (`44aa3429`) stands; this entry replaces its evidence with
  numbers observed in this run, and corrects three that were wrong.

  **Gap closed — "survives an app restart" now crosses a real process
  boundary.** The prior evidence was a fresh handler *registration*, which only
  proves `settings.ts` caches nothing between calls; it cannot rule out state
  held elsewhere in the same process. Three tests added to
  `packages/server-core/src/handlers/rpc/settings-headroom.test.ts`: each writes
  the override through the real `workspace:settings:update` handler in the test
  process, then reads it back via `loadHeadroomConfigView()` in a **separate
  process** that shares nothing but `CRAFT_CONFIG_DIR` on disk — a write, a
  cleared field, and two-workspace independence. That suite is 14 → 17 tests.

  **Red-then-green, each step reproducible.** Every red was produced by writing
  a file's pre-SUV content over it with `git show 44aa3429^:<path> > <path>` and
  restoring with `git checkout HEAD -- <path>` (never `git stash`):

  | reverted | suite | observed |
  |---|---|---|
  | `core/src/types/headroom.ts` + `types/index.ts` | `headroom-sources.test.ts` | 0 pass / 1 fail, 1 error — import-level (the symbol does not exist) |
  | `shared/src/workspaces/headroom.ts` + `workspaces/index.ts` | `view-headroom.test.ts` | 0 pass / **8 fail** — behavioural |
  | `server-core/.../rpc/settings.ts` | `settings-headroom.test.ts` | 0 pass / **14 fail**, each `Invalid workspace setting key: headroom` |
  | `server-core/.../rpc/settings.ts` | the 3 new restart tests (`-t "survives a process restart"`) | 0 pass / **3 fail** → restored → 3 pass |
  | `electron/.../lib/headroom-settings.ts` | `headroom-settings.test.ts` | 0 pass / 1 fail, 1 error — import-level |

  The two import-level reds are weaker evidence than the two behavioural ones
  and are labelled as such rather than counted as equals.

  **Corrections to the 2026-08-26 entry.** Its per-suite and total counts do not
  match what `bun test` reports. Actual, as run today: `headroom-sources` 7,
  `view-headroom` 8, `settings-headroom` 14 (now 17), `headroom-settings`
  **15** — the entry said 8, and so said "37 new" where the four suites in fact
  reported 44, now 47. Its full-suite figures were also stale: `test:shared` is
  **3644 pass / 0 fail** (3664 ran, 211 files), not 3531; `test:webui` is four
  runs totalling **1138 pass / 0 fail** (425 electron + 24 webui + 327 ui + 362
  server-core), not 349. `test:server` 196 / 0 was correct.

  **Gates, all run in this session and all exit 0:** `bun run typecheck:ci`,
  `bun run test:shared`, `bun run test:server`, `bun run test:webui`,
  `bun run lint:i18n:parity` (6 locales, 1992 keys each), `lint:i18n:sorted`,
  `lint:i18n:coverage` (2097 callsites), `lint:branding`,
  `lint:headroom-boundary`, and
  `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv17-build-check --no-splitting`.
  The 16 `settings.workspace.headroom*` keys this SUV added are present in all
  7 locale files (the other 12 `headroom*` keys there are SUV-0027's).

  **Scope re-checked against the diff, nothing added.** `44aa3429` touches only
  the settings read/write path, the provenance resolver, the renderer section,
  and locales. No instance-base editor exists; nothing added by this SUV reads
  the toggle at runtime (that is SUV-0018, landed separately in `1291b25c`).
  This entry adds test code only — no production file changed today.

  **Left alone, not mine:** `packages/shared/src/headroom/__tests__/sdk-roundtrip.test.ts`
  was modified in this checkout by a concurrent writer while this run was in
  progress. It is not staged in this commit and was not touched.
