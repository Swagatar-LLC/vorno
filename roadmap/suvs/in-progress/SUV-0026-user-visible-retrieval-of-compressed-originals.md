---
id: SUV-0026
title: User-visible retrieval of compressed originals
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related: []
blocked-by:
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (the retrieval handles this UI surfaces)
---

# SUV-0026 — User-visible retrieval of compressed originals

## Goal

Surface compression in the session UI so a user can see that an item was
compressed and view the byte-identical original on demand — reversibility as a
user-visible affordance, not just an internal cache.

## Scope

- Session view in `apps/electron`: compressed tool outputs carry a visible
  indicator (with the compressed/original size) and a "view original" action
  that fetches through `adapter.retrieve()`.
- Graceful failure: if retrieval fails, the UI says so — it never silently
  shows compressed content as if it were the original.
- Deliberately out: the aggregate stats/report view (SUV-0027) and any
  settings surfaces.

## Acceptance

- [x] Compressed items in the session view show an indicator with compressed and original sizes; uncompressed items show nothing new.
- [x] The "view original" action displays content byte-identical to the pre-compression original, verified by a test against a known payload.
- [x] A failed retrieval shows an explicit error state rather than passing off compressed content as the original.
- [x] With Headroom disabled, the session view renders identically to today — no dormant indicators.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-27` — implemented on `plan/plan-040`; moved to `in-progress/` (unmerged).

  **What the user now sees.** A compressed tool output's row in the session view carries a badge
  reading `20.0 KB → 1.0 KB`, with a tooltip naming the saving. Clicking it opens a panel under the
  row holding the byte-identical original, retrieved on demand. An uncompressed row is unchanged —
  not "changed but hidden": `ActivityRow` returns its original element tree when there is no marker,
  so there is no wrapper div, no dormant badge, and no extra key on the activity object.

  **The carrier.** SUV-0023 already shipped `headroomHandle` on the `tool_result` event; this adds
  the two measured sizes beside it (`headroomOriginalBytes` / `headroomCompressedBytes`, UTF-8, taken
  from the two strings `compressToolOutput` actually holds) and carries all three through
  `AgentEvent` → `SessionEvent` DTO → `Message`/`StoredMessage` → renderer `Message` → `ActivityItem`.
  `messageToStored`/`storedToMessage` are spread-based, so persistence needed no change and the badge
  survives a reload. Bytes rather than tokens deliberately: the service reports tokens only when it
  has them, and a token figure the user cannot check against anything is worse than a byte figure
  they can. All three fields are written as a set and spread conditionally, so the Headroom-off path
  produces objects identical to today's, key for key.

  **Retrieval path.** New RPC `sessions:retrieveHeadroomOriginal` →
  `SessionManager.retrieveHeadroomOriginal`, which builds the adapter from the session's *workspace*
  config rather than reading `managed.agent`. The agent is lazy and is evicted when idle (PLAN-038),
  so reading it would make "view original" either fail or silently boot a session runtime depending
  on when the user clicked; retrieval is a service lookup keyed by handle, so a fresh adapter with
  the same config answers identically, including after a restart. The renderer reaches it through a
  new `PlatformActions.onRetrieveHeadroomOriginal`; the web viewer supplies none, which is why
  `unsupported` is a first-class error reason rather than a silent no-op.

  **The honesty guarantee.** `HeadroomOriginalState` has exactly one content-carrying arm
  (`retrieved`). There is no code path from a failed retrieval to `activity.content`, and the type
  makes writing one a compile error rather than a review catch. Every boundary miss reason
  (`disabled` / `sdk-unavailable` / `service-unavailable` / `unknown-handle`) passes through
  unchanged so the message names a real operational state; a malformed success answer is refused
  rather than printed under the word "original". `headroomIndicatorFor` likewise refuses a *partial*
  marker — a handle with no sizes yields no badge, because the alternative is a badge that estimates.

  **Red-then-green:** with the size measurement removed from `compressToolOutput` and the marker copy
  removed from `messageToActivity`, 3 of the 17 new tests fail (`reads a complete marker off the
  activity`, `redeems the handle the compression issued and returns the exact input bytes`, `reports
  the measured sizes of that same round trip`) — 14 pass / 3 fail. Restored: 17 pass. The round trip
  is driven through the real `compressToolOutput` and a real `SdkHeadroomAdapter` over the SUV-0015
  loader seam, against a payload containing multi-byte characters, CRLF, a lone `\r` and a trailing
  newline, asserted three ways (string equality, length, UTF-8 buffer equality).

  Commands: `cd packages/ui && bun test` (327 pass), `bun run typecheck:ci`, `bun run test:shared`
  (3607 pass / 20 skip), `bun run test:server` (196 pass), `cd packages/server-core && bun test`
  (355 pass), `cd apps/electron && bun test src/main/webui src/renderer/components/app-shell
  src/renderer/lib` (425 pass), `cd apps/webui && bun test` (24 pass), `cd apps/viewer && bun test
  worker/` (23 pass), `bun run scripts/check-headroom-boundary.ts`, `bun run scripts/check-branding.ts`,
  `bun run lint:i18n:parity`, `bun run lint:i18n:sorted`, `bun build apps/server/src/index.ts
  --target=bun --outdir=/tmp/build-check --no-splitting`.

  **Two red gates that are not this SUV's, reported rather than fixed:**
  `bun run lint:i18n:coverage` fails on four `settings.workspace.headroomReport*` keys referenced by
  `apps/electron/src/renderer/pages/settings/HeadroomReportSection.tsx` — an untracked SUV-0027 file
  that appeared in this checkout mid-run. `apps/electron/src/shared/__tests__/ipc-channels.test.ts`
  fails with 17 channels present in `RPC_CHANNELS` but absent from its "auto-generated" inventory
  (`vorno:artifacts:*`, `vorno:workbench:review:*`, `craft-fork:webui:setPassword`,
  `vorno:headroom:stats:*`); none of them is this SUV's, whose channel *is* in the list, and the
  named generator `scripts/ipc-inventory.ts` no longer exists in the repo. Neither gate runs in
  `validate-pr.yml`.

  **Working-tree note.** This checkout gained concurrent SUV-0025/0027 work mid-run (new
  `packages/shared/src/headroom/{benchmark,report,scoped-adapter}.ts`,
  `packages/core/src/types/headroom-report.ts`, `packages/server-core/src/handlers/rpc/headroom.ts`,
  `apps/electron/src/renderer/lib/headroom-report.ts`, `scripts/benchmark-headroom.ts`, plus edits to
  `packages/shared/src/headroom/{index,session-adapter}.ts`, `packages/core/src/types/index.ts`,
  `packages/shared/src/protocol/events.ts`, `packages/shared/src/agent/backend/types.ts`,
  `packages/server-core/src/handlers/rpc/index.ts`, `packages/core/src/types/headroom-adapter.ts`).
  None of it is in this commit — paths were staged explicitly. To avoid editing the contested
  `headroom/index.ts`, `compressToolOutput` is reached from the UI test through a new
  `"./headroom/tool-output"` subpath export in `packages/shared/package.json`.

  Deliberately out and untouched: the aggregate stats/report view (SUV-0027), settings surfaces
  (SUV-0017), token displays (SUV-0028), and the Conductor's compressed node context (SUV-0024) —
  the SUV's scope line says session-view tool outputs.
