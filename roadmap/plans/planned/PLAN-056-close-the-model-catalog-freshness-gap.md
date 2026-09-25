---
id: PLAN-056
title: Close the model-catalog freshness gap
status: planned
direction: DIR-03
owner: jh
created: 2026-09-24
updated: 2026-09-24
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
  external catalog; on failure serve the cache; on cold-start failure fall
  through to the registry. Never block session start on a network fetch.
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
- [ ] Same for a ChatGPT-plan (`openai-codex`) connection
- [ ] Offline/failed catalog fetch degrades to today's behavior exactly
      (persisted list, then registry) — no picker regression, no startup block
- [ ] `getModelSupportsFastMode` and `isAdaptiveThinkingAlwaysOnModel` remain
      registry/predicate-driven; a catalog entry can never enable them
- [ ] Release process surfaces "pi-ai behind npm latest" as a visible check
- [ ] Tests added/updated
- [ ] Updated relevant docs in `roadmap/` or `docs/`

## Status log

- `2026-09-24` — created in `planned/`. Cut from the model-picker staleness
  investigation: pickers were missing Claude Opus 5.5 and GPT-6 Sol/Luna; the
  immediate fix is the upstream v0.13.5 sync (registry + Pi SDK 0.87.1), this
  plan removes the structural release-coupling that made it recur.
