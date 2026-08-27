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
  was rejected as unreproducible, and one acceptance gap closed. **(Superseded in
  part by the second 2026-08-27 entry below — three of its numbers were wrong.)**
  The 2026-08-26
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

- `2026-08-27` (second pass) — re-verified again from a clean tree after the
  previous run was rejected on verification. **No production code changed today
  and no test changed today**; `44aa3429` stands and all four acceptance items
  hold. This entry exists because three figures in the entry above do not
  reproduce. Every number below was observed in this session, and the tree was
  clean (`git status --porcelain` empty) before and after each revert/restore.

  **Three evidence defects corrected.**

  | claim above | observed today | command |
  |---|---|---|
  | revert `rpc/settings.ts` → "0 pass / **14** fail" | 0 pass / **17** fail | `cd packages/server-core && bun test src/handlers/rpc/settings-headroom.test.ts` |
  | `test:shared` "**3644** pass / 0 fail (3664 ran, 211 files)" | **3650 pass / 20 skip / 0 fail**, 3670 ran across 211 files | `bun run test:shared` |
  | "the other 12 `headroom*` keys there are **SUV-0027's**" | they are **SUV-0026's**, all 12 added by `bd68bed7` | `git log -S'"<key>":' -- packages/shared/src/i18n/locales/en.json` |

  The first is an internal contradiction, not drift: the same entry records the
  suite going 14 → 17, so reverting the handler reds all 17, not 14. The second
  is drift from sibling SUVs landing on this branch since. The third is a
  misattribution — `bd68bed7` is titled "user-visible retrieval of compressed
  originals (SUV-0026)".

  **Per-suite counts, each run on its own** (these four reproduce exactly as the
  entry above states — 7 + 8 + 17 + 15 = 47):

  | suite | observed |
  |---|---|
  | `packages/shared/src/config/__tests__/headroom-sources.test.ts` | 7 pass / 0 fail, 31 expect() |
  | `packages/shared/src/workspaces/__tests__/view-headroom.test.ts` | 8 pass / 0 fail, 30 expect() |
  | `packages/server-core/src/handlers/rpc/settings-headroom.test.ts` | 17 pass / 0 fail, 43 expect() |
  | `apps/electron/src/renderer/lib/__tests__/headroom-settings.test.ts` | 15 pass / 0 fail, 28 expect() |

  **Red-then-green re-reproduced, all four.** Each red was produced with
  `git show 44aa3429^:<path> > <path>` and undone with `git checkout HEAD -- <path>`
  (never `git stash`, in this repo or any worktree of it). The two behavioural
  reds are the load-bearing ones; the two import-level reds only prove a symbol
  is missing and are labelled as the weaker evidence they are.

  | reverted | suite | red | restored |
  |---|---|---|---|
  | `server-core/src/handlers/rpc/settings.ts` | `settings-headroom` | **0 pass / 17 fail**, every one `Invalid workspace setting key: headroom. Valid keys: name, model, …` — behavioural | 17 pass / 0 fail |
  | same, filtered `-t "survives a process restart"` | the 3 restart tests | **0 pass / 3 fail**, 14 filtered out — behavioural | 3 pass |
  | `shared/src/workspaces/headroom.ts` + `workspaces/index.ts` | `view-headroom` | **0 pass / 8 fail** — behavioural (each subprocess dies at `loadAndEvaluateModule`) | 8 pass / 0 fail |
  | `core/src/types/headroom.ts` | `headroom-sources` | 0 pass / 1 fail, 1 error — import-level: `SyntaxError: export 'resolveHeadroomConfigSources' not found in './headroom.ts'` | 7 pass |
  | `electron/src/renderer/lib/headroom-settings.ts` (absent at `44aa3429^`) | `headroom-settings` | 0 pass / 1 fail, 1 error — import-level: `Cannot find module '../headroom-settings'` | 15 pass |

  **Acceptance, each item tied to a named test that ran today.**

  1. *Section + fields + persistence + restart.* `HeadroomSettingsSection.tsx`
     renders one `SettingsRow` per `HEADROOM_CONFIG_FIELDS` entry — `enabled`
     (Switch), `compressionEngines` (Input), `verbosity` (SettingsMenuSelect),
     `exposeStats` (Switch) — and `WorkspaceSettingsPage.tsx` mounts it and
     feeds it `settings.headroomView`. The field list was checked against
     SUV-0016's `HEADROOM_CONFIG_FIELDS`, not against the implementation.
     Persistence: `round-trips every option field through a fresh handler`.
     Restart: the three `survives a process restart` cases, which `Bun.spawnSync`
     a separate process sharing only `CRAFT_CONFIG_DIR`. **Stated precisely: that
     is a process boundary, not an Electron relaunch** — it is the strongest
     evidence an automated suite can produce for this claim, and is not offered
     as more.
  2. *Provenance + clear reverts.* `attributes each field to its layer…`,
     `reports what a cleared override would revert to`, and
     `agrees with the resolver about where every value came from` (the property
     tying `resolveHeadroomConfigSources()` to `resolveHeadroomConfig()`).
  3. *Two workspaces independent.* Four cases, and each asserts the second
     workspace equals the **disabled** config rather than merely differing:
     `enabling Headroom in one workspace leaves the other disabled` (shared),
     `enabling Headroom in one workspace leaves the other resolving to disabled`
     (RPC), `each workspace overrides a shared instance base on its own`, and
     `two workspaces still resolve independently after the restart`.
  4. *Fresh install → toggle off.* `renders a usable, disabled view with no
     config files at all`, `serves a disabled view on the fresh-install path`,
     `saves from that fresh state and writes a valid config`, and
     `renders every field, with the enable toggle off and nothing overridden`.

  **Gates, all run today, all exit 0.**

  | gate | observed |
  |---|---|
  | `bun run typecheck:ci` | exit 0, no output |
  | `bun run test:shared` | 3650 pass / 20 skip / 0 fail (3670 across 211 files) |
  | `bun run test:server` | 196 pass / 0 fail (18 files) |
  | `bun run test:webui` | four runs, **1138 pass / 0 fail** — 425 electron + 24 webui + 327 ui + 362 server-core |
  | `bun run lint:i18n:parity` | `i18n parity OK (6 locales, 1992 keys each)` |
  | `bun run lint:i18n:sorted` | exit 0 |
  | `bun run lint:i18n:coverage` | `i18n coverage OK (2097 callsites, 1554 distinct keys, 1992 keys in en.json)` |
  | `bun run lint:branding` | clean (one pre-existing stale-allowlist *warning*, `apps/viewer/vite.config.ts`, unrelated) |
  | `bun run lint:headroom-boundary` | `headroom-ai imported only by packages/shared/src/headroom/sdk-adapter.ts` |
  | `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv17-recheck --no-splitting` | bundled 3403 modules, 16.36 MB |

  **Locale keys re-checked by key, not by count.** The 16 keys `44aa3429` added
  to `en.json` were extracted from the diff and each grepped in all 7 locale
  files: all present in all 7. The file now holds 28 `settings.workspace.headroom*`
  keys per locale = these 16 + SUV-0026's 12 (see the correction above).

  **Scope re-checked against `44aa3429`, not the working tree.** SUV-0018 has
  since landed on this branch (`1291b25c`), so a working-tree grep for toggle
  consumers is a false positive by construction. Against the commit:
  `git show 44aa3429 | grep setHeadroomInstanceConfig` → no match, so no
  instance-base editor; and `git grep loadEffectiveHeadroomConfig 44aa3429`
  outside its own module and tests returns exactly one line, the barrel
  re-export in `workspaces/index.ts` — no runtime consumer. Both declared
  exclusions hold.

  **Two things a reviewer should see named rather than buried.** (a) The SUV's
  scope line says provenance is two-valued ("workspace override vs instance
  default") while the model is three-valued and the UI folds `instance` and
  `default` into one label; the fold is reasoned in the code and in the entry
  above, but the SUV text does not itself authorise it. (b) The acceptance boxes
  were already `[x]` before this run; they are left checked because each is now
  tied to a test that ran today, not because they were found checked.

- `2026-08-27` (third pass) — re-verified by execution after the previous run was
  rejected on verification. **No production code and no test changed today**;
  `44aa3429` stands and all four acceptance items hold. This entry corrects
  **three** defects in the entries above — one of which is a *correction that was
  itself wrong* — and records the figures observed in this session.

  **Three evidence defects corrected.**

  | claim above | observed today | command |
  |---|---|---|
  | the other 12 `headroom*` locale keys "are **SUV-0026's**, all 12 added by `bd68bed7`" | they are **SUV-0027's**, all 12 added by **`161c6523`** — and `bd68bed7` **is not on this branch at all** | `git merge-base --is-ancestor bd68bed7 plan/plan-040` → not an ancestor; `git log plan/plan-040 -S'"<key>":' -- …/en.json` → `161c6523 feat(headroom): in-app savings and stats report view (SUV-0027)` |
  | `test:shared` "**3650** pass / 20 skip / 0 fail, 3670 ran" | **3655 pass / 20 skip / 0 fail**, 3675 ran across 211 files | `bun run test:shared` |
  | `HeadroomSettingsSection.tsx` "renders one `SettingsRow` per `HEADROOM_CONFIG_FIELDS` entry" | it renders **four `SettingsRow`s addressed by name** (`byField.enabled`, `.compressionEngines`, `.verbosity`, `.exposeStats`); only `buildHeadroomRows()` iterates the list | read `HeadroomSettingsSection.tsx:182-261` |

  The first is the significant one. The second-pass entry "corrected" the
  first-pass attribution from SUV-0027 to SUV-0026 and cited `bd68bed7` —
  a commit reachable from no branch here (it appears in this checkout's reflog
  only as a detached visit). **The first-pass attribution was right and the
  correction introduced the error.** On `plan/plan-040` the 12 keys are the
  `settings.workspace.headroomReport*` set, every one introduced by `161c6523`
  (SUV-0027); `bd68bed7`'s own diff adds them too, which is what made the
  off-branch commit look plausible, but it is not in this history. 16 + 12 = 28
  per locale, as stated.

  The third does **not** unmet any acceptance item — `HEADROOM_CONFIG_FIELDS` is
  exactly `enabled`, `compressionEngines`, `verbosity`, `exposeStats`
  (`packages/core/src/types/headroom.ts:130-135`, read from SUV-0016's own
  definition, not from the UI), and the section has a control for each of the
  four. What is false is the *durability* claim: a fifth field added to
  `HEADROOM_CONFIG_FIELDS` would appear in `buildHeadroomRows()` and be silently
  dropped by the JSX, and no test guards that. The doc comment at
  `headroom.ts:126-129` ("the UI renders this list rather than hardcoding its
  own") overstates in the same way. **Named, not fixed** — closing it means
  either a rendered-per-field refactor or a new guard test, and neither could be
  run to green in this session (see the blocker below), so nothing unverifiable
  was written.

  **Per-suite counts, each run on its own** (7 + 8 + 17 + 15 = 47 — these
  reproduce exactly as the entries above state):

  | suite | observed |
  |---|---|
  | `packages/shared/src/config/__tests__/headroom-sources.test.ts` | 7 pass / 0 fail, 31 expect() |
  | `packages/shared/src/workspaces/__tests__/view-headroom.test.ts` | 8 pass / 0 fail, 30 expect() |
  | `packages/server-core/src/handlers/rpc/settings-headroom.test.ts` | 17 pass / 0 fail, 43 expect() |
  | `apps/electron/src/renderer/lib/__tests__/headroom-settings.test.ts` | 15 pass / 0 fail, 28 expect() |

  **Red-then-green re-reproduced, all four.** Each red was produced with
  `git show 44aa3429^:<path> > <path>` and undone by writing the committed
  content back (`git show HEAD:<path> > <path>`) — never `git stash`, in this
  repo or any worktree of it. The tree was confirmed byte-identical to `HEAD`
  afterwards (`git diff --stat` empty). The two behavioural reds are the
  load-bearing evidence; the two import-level reds only prove a symbol is
  missing and are labelled as the weaker evidence they are.

  | reverted | suite | red | restored |
  |---|---|---|---|
  | `server-core/src/handlers/rpc/settings.ts` | `settings-headroom` | **0 pass / 17 fail**, each `Invalid workspace setting key: headroom` — behavioural | 17 pass / 0 fail |
  | same, filtered `-t "survives a process restart"` | the 3 restart cases | **0 pass / 3 fail**, 14 filtered out — behavioural | 3 pass |
  | `shared/src/workspaces/headroom.ts` + `workspaces/index.ts` | `view-headroom` | **0 pass / 8 fail** — behavioural | 8 pass / 0 fail |
  | `core/src/types/headroom.ts` | `headroom-sources` | 0 pass / 1 fail, 1 error — import-level: `SyntaxError: export 'resolveHeadroomConfigSources' not found in './headroom.ts'` | 7 pass |
  | `electron/src/renderer/lib/headroom-settings.ts` (absent at `44aa3429^`, confirmed by `git cat-file -e`) | `headroom-settings` | 0 pass / 1 fail, 1 error — `Cannot find module '../headroom-settings'` | 15 pass |

  **The restart claim, checked at the source rather than taken on trust.**
  `-t "survives a process restart"` is not a test name — it matches the describe
  block `workspace settings: headroom survives a process restart (SUV-0017)`
  (`settings-headroom.test.ts:260`), which holds the three cases. Those cases
  call `readViewInFreshProcess()`, which `Bun.spawnSync`s `process.execPath`
  with `--eval`, importing `loadHeadroomConfigView` and passing only
  `CRAFT_CONFIG_DIR` in the env, and **throws** on a non-zero exit — so it
  cannot pass vacuously. **Stated precisely, as before: that is a process
  boundary, not an Electron relaunch.**

  **Acceptance, each item tied to a test that ran today.**

  1. *Section + fields + persistence + restart.* The four
     `HEADROOM_CONFIG_FIELDS` each have a control — `enabled` (Switch),
     `compressionEngines` (Input), `verbosity` (SettingsMenuSelect),
     `exposeStats` (Switch) — and `WorkspaceSettingsPage.tsx:746` mounts the
     section with `settings.headroomView`. Persistence:
     `round-trips every option field through a fresh handler`. Restart: the
     three subprocess cases above. (See the third correction for the limit of
     the "renders per field" claim.)
  2. *Provenance + clear reverts.* `attributes each field to its layer and
     exposes the raw override`, `reports what a cleared override would revert
     to`, and `agrees with the resolver about where every value came from` —
     the property tying `resolveHeadroomConfigSources()` to
     `resolveHeadroomConfig()`, not a fixture.
  3. *Two workspaces independent.* Verified each asserts the second workspace
     equals the **disabled** config rather than merely differing —
     `expect(readViewInFreshProcess(ROOT_B).effective).toEqual(DISABLED)`
     (`settings-headroom.test.ts:297`), plus `enabling Headroom in one
     workspace leaves the other disabled` (shared), `…leaves the other
     resolving to disabled` (RPC), `each workspace overrides a shared instance
     base on its own`, and `a shared instance base is inherited independently by
     each workspace` — i.e. with and without a shared instance base, and across
     the process boundary.
  4. *Fresh install → toggle off.* `renders a usable, disabled view with no
     config files at all`, `serves a disabled view on the fresh-install path`,
     `saves from that fresh state and writes a valid config`, and `renders every
     field, with the enable toggle off and nothing overridden`.

  **Gates, all run today, all exit 0.**

  | gate | observed |
  |---|---|
  | `bun run typecheck:ci` | exit 0 |
  | `bun run test:shared` | **3655 pass / 20 skip / 0 fail** (3675 across 211 files) |
  | `bun run test:server` | 196 pass / 0 fail, 410 expect() (18 files) |
  | `bun run test:webui` | four runs, **1138 pass / 0 fail** — 425 electron + 24 webui + 327 ui + 362 server-core |
  | `bun run lint:i18n:parity` | `i18n parity OK (6 locales, 1992 keys each)` |
  | `bun run lint:i18n:sorted` | exit 0 |
  | `bun run lint:i18n:coverage` | `i18n coverage OK (2097 callsites, 1554 distinct keys, 1992 keys in en.json)` |
  | `bun run lint:branding` | clean (one pre-existing stale-allowlist *warning*, `apps/viewer/vite.config.ts`, unrelated) |
  | `bun run lint:headroom-boundary` | `headroom-ai imported only by packages/shared/src/headroom/sdk-adapter.ts` |
  | `bun build apps/server/src/index.ts --target=bun --outdir=/tmp/suv17-pass3 --no-splitting` | bundled 3403 modules, 16.36 MB |

  **Locale keys re-checked key by key.** The 16 keys `44aa3429` added to
  `en.json` were extracted from the diff and each grepped in all 7 locale files:
  all 16 present in all 7. Totals read from the branch blob, not the working
  tree: 28 `settings.workspace.headroom*` keys per locale = these 16 +
  SUV-0027's 12 (see the correction above).

  **Scope re-checked against `44aa3429`, not the working tree** — SUV-0018 has
  since landed (`1291b25c`), so a working-tree grep for toggle consumers is a
  false positive by construction. Against the commit:
  `git show 44aa3429 | grep -c setHeadroomInstanceConfig` → **0**, so no
  instance-base editor; and `git grep loadEffectiveHeadroomConfig 44aa3429`
  outside its own module, its tests and roadmap prose returns exactly one line —
  the barrel re-export in `workspaces/index.ts` — so no runtime consumer. At
  `HEAD` that same grep returns `tasks.ts`, `SessionManager.ts` and
  `base-agent.ts`, which is SUV-0018's work and correctly outside this SUV.
  Both declared exclusions hold.

  **Blocker encountered, reported rather than worked around.** Mid-session a
  concurrent process moved this shared checkout `plan/plan-040` → `main` →
  `jh/2026-08-27_Upstream_Merge` and left an **unresolved upstream merge** in
  it (`git status`: "merge in progress. unresolved conflicts"; `UU` on
  `package.json`, `bun.lock`, `README.md` and ~10 more; `package.json` carries
  literal conflict markers). An earlier symptom was a
  `.git/index.lock` failure during a restore, which is why that one restore was
  completed by writing the committed content back instead of `git checkout --`.
  Every test and gate figure above was observed **before** the switch, on
  `plan/plan-040` with a clean tree; the branch tip is untouched at `210a75f8`
  and every revert had been restored to `HEAD`-identical beforehand, so nothing
  from this run leaked into the merge branch. **Their merge was not resolved,
  not aborted, and no branch was switched.** This entry was committed onto
  `plan/plan-040` through a temporary index (`GIT_INDEX_FILE` + `commit-tree` +
  `update-ref`), which touches neither the conflicted index nor the working
  tree.

  **Two things a reviewer should still see named.** (a) The SUV's scope line
  says provenance is two-valued ("workspace override vs instance default") while
  the model is three-valued and the UI folds `instance` and `default` into one
  label; the fold is reasoned in the code, but the SUV text does not itself
  authorise it — an owner's call, not mine. (b) The acceptance boxes were
  already `[x]` before this run; they are left checked because each is tied to a
  named test that ran today.
