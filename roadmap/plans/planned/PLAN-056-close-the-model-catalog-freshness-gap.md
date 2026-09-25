---
id: PLAN-056
title: Close the model-catalog freshness gap
status: planned
direction: DIR-03
owner: jh
created: 2026-09-24
updated: 2026-09-25
related:
  - PLAN-050-make-model-list-staleness-observable.md
related-suvs: []
blocked-by: []
---

# PLAN-056 — Close the model-catalog freshness gap

## Goal

A newly released Anthropic or OpenAI model appears in Vorno's model pickers
without waiting for a Vorno release, wherever the provider's own API allows it —
and where it doesn't, the remaining lag is a measured dependency-bump cadence,
not an open-ended silence.

## Scope

Findings from the 2026-09-24 investigation (session `260924-awake-fjord`) frame
the work. The refresh architecture is already dynamic-with-fallback
(`ModelRefreshService`, `packages/server-core/src/model-fetchers/index.ts`);
exactly two paths remain pinned to ship-time data:

1. **Anthropic subscription OAuth** (`claude-max`-style connections). The
   OAuth token is scoped to Claude Code and is not entitled to
   `/v1/models`, so `drivers/anthropic.ts` deliberately serves the hardcoded
   `MODEL_REGISTRY`. New Claude models wait for a registry edit in a release.
2. **ChatGPT-plan connections** (`piAuthProvider: 'openai-codex'`). Not in
   `LIVE_FETCH_PI_AUTH_PROVIDERS`; the list is the static `@earendil-works/pi-ai`
   catalog, so new GPT models wait for a Pi SDK dependency bump in a release.

In scope:

- A runtime catalog overlay for the two pinned paths: fetch a trusted external
  catalog (models.dev — the same source the Pi SDK regenerates from — or a
  Vorno-published mirror) on the existing refresh cadence, merge it over the
  hardcoded registry, and treat the registry as offline fallback + metadata
  overlay (fast-mode flags, curated names/descriptions, context-window
  corrections). Capability hints that can make the API reject a request
  (`supportsFastMode`, always-on adaptive thinking) stay registry/predicate-only
  and conservative, exactly as `getModelSupportsFastMode` does today.
- Evaluate promoting `openai-codex` into the live-fetch set if the ChatGPT
  backend exposes a usable model-listing surface for subscription tokens;
  otherwise it rides the catalog overlay.
- A refresh timer for overlay-backed connections. Today `PiModelFetcher`'s
  `refreshIntervalMs` is 0 and only `LIVE_FETCH_PI_AUTH_PROVIDERS` connections
  get a periodic timer, so an `openai-codex` connection is refreshed only at
  startup/auth. Overlay-backed connections must join the timer set (a daily
  interval matches the catalog cache TTL) so a long-running app discovers new
  models without a restart.
- Execution-time resolution for overlay-discovered Pi models. The picker list
  and the runnable-model set are different systems: the Pi subprocess resolves
  the selected id against the *installed* SDK catalog
  (`pi-agent-server/src/index.ts` → `resolvePiModel`), so a model known only to
  the overlay would be selectable but fail at session start. The plan must
  either synthesize a runnable model entry from overlay metadata (id, baseUrl,
  api type, context window — the mechanism custom-endpoint models already use)
  and pass it to the subprocess, or exclude overlay-only ids from the Pi picker
  until the SDK knows them (showing them as "pending SDK update"). Either
  choice needs a test that starts a session on a model found only in the
  overlay. This asymmetry does not exist on the Anthropic-direct path, where
  the Claude SDK accepts the model id as a plain string.
- A release-time tripwire for the residual dependency lag: CI (or the release
  skill) reports when the installed `@earendil-works/pi-ai` is behind npm
  `latest`, so a catalog-bearing bump is a visible checklist item instead of a
  discovery.

## Non-goals

- Staleness UI — that is PLAN-050, which stays independent and complements this.
- Changing the fallback chain's order (live → persisted → registry) — it is
  correct; this plan widens what "live" covers.
- Trusting a fetched catalog for request-rejecting capability flags.
- Any change to compat providers (`pi_compat`) — user-managed by design.

## Approach

`ModelRefreshService._doRefresh` already has the right shape: Layer 1
(provider fetch) → Layer 2 (persisted) → Layer 3 (registry). Add a Layer 1.5
catalog source usable by fetchers whose Layer 1 is structurally unavailable:

- New `CatalogOverlayFetcher` helper: fetch + cache (persisted, TTL ~24h) the
  external catalog; on fetch failure serve the cached catalog. Never block
  session start on a network fetch.
- Explicit failure contract: when neither a fresh catalog nor a cached one is
  available, the fetcher **throws** — it must not return the registry as a
  successful Layer 1 result. A successful Layer 1 result makes
  `_doRefresh` skip `connection.models` entirely, so returning the bundled
  registry on failure would overwrite a previously discovered richer list with
  ship-time data. Throwing lets the service hold the persisted list (Layer 2),
  with `MODEL_REGISTRY` reached only as Layer 3 when nothing was ever
  persisted. (This deliberately flips the current OAuth-branch behavior, where
  registry-as-success is correct precisely because the registry is the *only*
  data source; once the overlay exists, the persisted list can be richer than
  the registry and must win on failure.) The registry keeps its other role —
  base + capability-metadata overlay — only when catalog data is available.
- `AnthropicModelFetcher` OAuth branch: return `overlay(registry, catalog)`
  instead of `registryResult()`. Registry entries win on name/shortName/
  description/capability; catalog contributes new ids and context windows.
- Pi static-catalog branch: same overlay keyed by `piAuthProvider`.
- Validate fetched ids (shape allowlist per provider) before persisting, so a
  poisoned or malformed catalog cannot inject arbitrary strings into stored
  connection configs.

Decision points to settle in the first SUV (likely an ADR-sized question if a
Vorno-published mirror is chosen): catalog source and its trust/signing story,
and where the fetch runs (host refresh service only — never the renderer).

## Acceptance

- [ ] With the hardcoded registry artificially frozen, a model present in the
      external catalog but absent from the registry appears in the picker of an
      Anthropic OAuth connection after a refresh cycle
- [ ] Same for a ChatGPT-plan (`openai-codex`) connection — including while the
      app stays running (periodic timer, not just startup/auth refresh)
- [ ] A session starts successfully on a Pi model discovered only via the
      overlay (or the picker visibly defers it until the SDK knows it —
      whichever resolution strategy the first SUV picks)
- [ ] Catalog fetch failure with a previously persisted list keeps that list
      (the overlay fetcher throws rather than serving the registry as success);
      the registry appears only when nothing was ever persisted. No startup
      block in any case
- [ ] `getModelSupportsFastMode` and `isAdaptiveThinkingAlwaysOnModel` remain
      registry/predicate-driven; a catalog entry can never enable them
- [ ] Release process surfaces "pi-ai behind npm latest" as a visible check
- [ ] Tests added/updated
- [ ] Updated relevant docs in `roadmap/` or `docs/`

## Status log

- `2026-09-25` — folded in three review findings from PR #227: an explicit
  throw-on-no-catalog failure contract so a persisted list is never overwritten
  by the bundled registry; a periodic refresh timer for overlay-backed
  connections (`openai-codex` has none today); and execution-time resolution
  for overlay-only Pi models, which the subprocess's `resolvePiModel` cannot
  currently run.
- `2026-09-24` — created in `planned/`. Cut from the model-picker staleness
  investigation: pickers were missing Claude Opus 5.5 and GPT-6 Sol/Luna; the
  immediate fix is the upstream v0.13.5 sync (registry + Pi SDK 0.87.1), this
  plan removes the structural release-coupling that made it recur.
