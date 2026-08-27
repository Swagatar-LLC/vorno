---
id: SUV-0016
title: Headroom config schema, storage, and precedence
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-26
related: []
blocked-by: []
---

# SUV-0016 — Headroom config schema, storage, and precedence

## Goal

Define and persist Headroom configuration as instance-level base config plus
per-workspace overrides, with one resolver that yields the effective config.

## Scope

- Config types in `packages/core`: an enable/disable flag plus integration
  options (compression engines, verbosity steering, stats exposure — the
  options the boundary adapter accepts), identical shape at instance and
  workspace level.
- Storage in `packages/shared` config machinery: instance base config at the
  config root, workspace overrides in per-workspace settings, following the
  existing settings persistence patterns.
- `resolveHeadroomConfig(instance, workspace)` — workspace overrides instance
  base, field-level; default is disabled everywhere until benchmarks set
  rollout defaults (plan I0).
- Types and resolver are transport-neutral: plain serializable data, no
  Electron or local-filesystem assumptions, so a future server-hosted instance
  supplies the same shapes over the wire.
- Deliberately out: any UI (SUV-0017), and wiring the resolved config into the
  boundary adapter (SUV-0018).

## Acceptance

- [x] Headroom config types live in `packages/core`, are plain serializable data (round-trip through `JSON.parse(JSON.stringify(...))` in a test), and import nothing from Electron or node filesystem modules.
- [x] Instance base config and per-workspace overrides persist through the existing config storage in `packages/shared`, and a fresh install with neither file present resolves to disabled.
- [x] `resolveHeadroomConfig()` applies field-level precedence — workspace value wins where set, instance base fills the rest — with tests covering: no config anywhere, instance-only, workspace-only, and workspace partially overriding instance.
- [x] A malformed or partial config file resolves to safe defaults (disabled) rather than throwing, with a test feeding real-world-shaped bad input (unknown keys, wrong types).

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-26` — implemented on `plan/plan-040`; moved to `in-progress/` (PR not
  yet cut). All four acceptance items met; 32 new tests, full shared suite
  3486 pass / 0 fail.

  **What landed**

  - `packages/core/src/types/headroom.ts` (new) — `HeadroomConfig`,
    `HeadroomConfigOverrides`, `HeadroomVerbosity`,
    `HEADROOM_CONFIG_DEFAULTS`, `sanitizeHeadroomConfigLayer()`,
    `resolveHeadroomConfig()`. The file has **zero imports**, so it satisfies
    the transport-neutrality requirement by construction rather than by
    convention; a test greps the source (comments stripped) to keep it that
    way. Exported from `packages/core/src/types/index.ts`.
  - `packages/shared/src/config/storage.ts` — `StoredConfig.headroom` (instance
    base at the config root) plus `getHeadroomInstanceConfig()` /
    `setHeadroomInstanceConfig()`, following the existing per-setting accessor
    idiom. The getter deliberately returns the layer *unresolved*: validation
    and defaulting belong to the resolver, not to storage.
  - `packages/shared/src/workspaces/types.ts` — `defaults.headroom`, the
    per-workspace override layer, alongside `idleAgentTtlMinutes` (PLAN-038's
    precedent).
  - `packages/shared/src/workspaces/headroom.ts` (new) —
    `loadEffectiveHeadroomConfig(workspaceRootPath?)` reads both layers and
    resolves. Placed under `workspaces/` rather than `config/` because
    `workspaces/storage.ts` already depends on `config/storage.ts`; the
    reverse edge would invert the layering.

  **Decisions taken where the SUV was silent** (flagged for SUV-0015/0018 to
  revisit rather than resolved silently):

  - *Shape is flat and the option surface is minimal.* "Field-level
    precedence" is unambiguous on a flat object; nested objects would raise a
    replace-vs-deep-merge question this SUV does not answer. Compression
    engines are modelled as an ordered `string[]` of opaque ids, not an enum —
    the real catalogue is whatever the pinned SDK exposes (SUV-0014), and the
    plan is explicit that adapter surface is verified at integration time, not
    from README claims. `verbosity` is a coarse three-value union expressing
    intent. Both are marked PROVISIONAL in the source.
  - *Malformed input fails safe at the layer level, not the field level.* A
    known field with the wrong type rejects that whole layer (it falls through
    to the layer below, ending at disabled); half-trusting a file known to be
    corrupt is the subtler bug. **Unknown keys are ignored without rejecting
    the layer** — a key written by a newer build must not disable the feature
    on an older one. Note this is a knowing drop, not Zod's silent
    non-strict `.strip()` (the trap recorded during PLAN-043).
  - *`null`/`undefined` on a known field means unset, not a value*, which is
    what lets a workspace override some fields and inherit the rest. `false`
    is a real value, so a workspace can explicitly disable an
    instance-enabled integration.
  - *No shared machinery with `resolveThresholds()`.* Its per-model →
    per-provider → default precedence is the same *shape*, but a different
    set of tiers; imitated, not reused.

  **Not done, deliberately:** no UI (SUV-0017), no boundary-adapter wiring
  (SUV-0018), no rollout default (disabled everywhere until SUV-0025's
  benchmarks), no IPC/DTO surface (`workspaceSettings:*` `validKeys` untouched
  — that is the UI's entry point), no `config-defaults.json`
  `workspaceDefaults` entry. Nothing consumes the resolved config yet.

  **Tests** (`bun test` from `packages/shared`)

  - `src/config/__tests__/headroom-config.test.ts` — 20 tests: JSON round-trip,
    zero-import assertion, the four required precedence cases, null-as-unset,
    array defensive-copy, and malformed input (wrong types on every field,
    non-object layers, corrupt-layer rejection, unknown-key forward compat).
  - `src/workspaces/__tests__/storage-headroom.test.ts` — 12 tests: workspace
    config round-trip (full, partial, and legacy-absent), plus end-to-end
    `loadEffectiveHeadroomConfig()` against a real on-disk config dir in a
    subprocess with `CRAFT_CONFIG_DIR` set (the `default-thinking-level.test.ts`
    idiom, required because `config/paths.ts` freezes `CONFIG_DIR` at
    module-eval — LEARNING-056). Covers the fresh-install case with **neither**
    file present.

  **Red-then-green verified.** With the six implementation files reverted to
  `HEAD` (backed up to a temp dir and restored — no `git stash`, ever, in this
  repo): `9 fail / 3 pass` at runtime, the whole config test file erroring on a
  missing export, and `tsc --noEmit` reporting 10+ `TS2305`/`TS2339`/`TS2353`
  errors. The 3 that still passed are the workspace-config round-trip cases —
  `loadWorkspaceConfig` is a raw JSON passthrough, so on that path the change
  is a *type* change and typecheck is what catches it. Restored, then
  `32 pass / 0 fail`.

  **Note for the reviewer:** SUV-0014 was being worked concurrently in this same
  checkout and its files (`bun.lock`, `packages/shared/package.json` pinning
  `headroom-ai@0.36.5`, `packages/shared/src/__tests__/headroom-pin.test.ts`,
  `roadmap/evidence/PLAN-040/`) were uncommitted in the tree for most of this
  run. They were left untouched throughout and are **not** in this commit;
  SUV-0014 landed on its own at `48f6e0c3`, immediately below this one. This
  SUV takes no dependency on the pinned SDK — the config module imports
  nothing. Full `packages/shared` suite re-run on the combined state:
  3486 pass / 0 fail.
