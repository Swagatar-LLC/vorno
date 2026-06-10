---
id: LEARNING-004
title: Live-fetch Pi providers need BOTH the refresh-guard bypass and the backfill mode-force
date: 2026-06-09
status: active
component: config/models
related-plans: [PLAN-009-live-model-enumeration]
related-decisions: []
---

# LEARNING-004 — Live-fetch Pi providers need both the refresh-guard bypass *and* the backfill mode-force

## Signal

When adding live `GET /v1/models` enumeration for an OpenAI Pi connection (PLAN-009),
the obvious-looking fix — "treat OpenAI like Copilot in the refresh service" — is a
trap. A reviewer suggested keeping the refresh-guard bypass Copilot-only. That would
**freeze the OpenAI model list after the very first live fetch**, and separately the
connection would show as "user-defined" mode in Settings even though the user never
chose that.

## Root cause

Pi connection model lists carry a `modelSelectionMode` that is **inferred**, not
always explicitly chosen. `inferModelSelectionMode(connection, providerDefaultModelIds)`
(`config/storage.ts`) returns:

- `automaticallySyncedFromProvider` only when the persisted list **set-equals** the
  provider's *static default* model set, and
- `userDefined3Tier` otherwise.

A **live** fetch persists the provider's *full* live catalog, which essentially never
set-equals the small static default list. So on the next `backfillAllConnectionModels`
pass the connection is (re)classified `userDefined3Tier` — purely as an artifact of
live enumeration, with no user curation involved.

Two independent code paths key off that mode:

1. **Refresh guard** (`server-core/.../model-fetchers/index.ts` `_doRefresh`): for
   `userDefined3Tier` Pi connections it *preserves* the stored list and skips the
   update, to protect user curation. With a Copilot-only bypass, an OpenAI connection
   (now auto-classified `userDefined3Tier`) would hit this guard and never refresh
   again → **frozen after one fetch**.
2. **Backfill mode inference** (`storage.ts` `backfillAllConnectionModels`): already
   *force-sets* `automaticallySyncedFromProvider` for Copilot, precisely because
   Copilot is server-managed and would otherwise be mislabeled.

## Fix

Generalize **both** Copilot special-cases to a single predicate,
`isLiveFetchPiConnection(connection)` (in `config/model-fetcher.ts`, covering
`github-copilot` + `openai`):

- `_doRefresh` guard: bypass for any live-fetch provider so the live list always wins.
- `backfillAllConnectionModels`: force `automaticallySyncedFromProvider` for any
  live-fetch provider so the mode label stays accurate (and, as a bonus, the refresh
  guard then never even fires for them).

The mental model: **for a live-fetch provider, the provider owns the list, not the
user.** Any new live-fetch Pi provider must be added to `LIVE_FETCH_PI_AUTH_PROVIDERS`
and will inherit both behaviors automatically. Forgetting either half reintroduces the
freeze (miss the bypass) or the mislabel (miss the mode-force).

## How to verify

- Refresh path: `packages/shared/.../drivers/pi.test.ts` (live success + fallback).
- Mode-force: `packages/shared/src/config/__tests__/storage-startup-migration.test.ts`
  ("forces automaticallySyncedFromProvider for live-fetch OpenAI connections").
- Predicate: `packages/shared/src/config/model-fetcher.test.ts`.
