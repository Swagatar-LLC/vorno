---
id: ADR-0014
title: Review workbench — workspace review store, quote+hash anchors, in-app surface, vorno:workbench:* namespace
status: accepted
date: 2026-07-19
supersedes: []
superseded-by: []
---

# ADR-0014 — Review workbench — workspace review store, quote+hash anchors, in-app surface, `vorno:workbench:*` namespace

## Context

PLAN-024 builds an interactive architecture-review workbench — the first of a series of **dynamic workspaces** for working with larger volumes of data in interactive settings. Discovery (session 260719-young-willow) established: the renderer's markdown/mermaid pipeline and the inline-annotation system (`AnnotatableMarkdownDocument`, `AnnotationV1`) are reusable outside chat; the WebUI is the Electron renderer served over WS, so an in-app page ships to both surfaces; no cross-session artifact index or artifact-keyed annotation persistence exists. Four one-way doors were flagged; Jeff resolved them 2026-07-19 with refinements recorded here.

## Decision

1. **Review state lives in a workspace-level store, beside the governance corpus, as plain agent-minable files.** `{workspaceRoot}/reviews/<workbenchId>/workbench.json` + `threads/<threadId>.json` (one JSON file per thread). The corpus stays clean; git stays quiet; promotion (comment → ADR/plan edit) is an explicit act. **Binding requirements (Jeff):** the full graph — session links, artifact links, and the reviews themselves — must be surfaceable *back into sessions* and minable by agentic systems. Plain files satisfy mining by construction (Read/Grep, no new tools); every thread carries `sessionLinks` (sessions that asked/answered/were spawned from it) and the artifact URI, so traversal works in both directions. The store is also the unit of team visibility in future shared workspaces (PLAN-023): workspace-scoped, principal-attributable later via `createdBy`.
2. **Anchors are quote-based + content-hash versioned; drift is surfaced, never hidden.** Threads anchor with the existing `AnnotationV1` quote target plus `{contentHash, gitSha?}` of the artifact version reviewed (repo artifacts record the git SHA; PLAN-023's ALIGN artifacts already self-declare "valid at SHA"). A changed artifact renders the thread with a stale badge; re-anchoring is a user/agent act, never silent.
3. **The workbench is an in-app renderer surface, feature-flagged.** It ships inside the Electron renderer (desktop + WebUI from one implementation) and is the template for future **dynamically-generated surfaces** that need annotation and artifact sharing/referencing. No standalone deployable.
4. **The protocol family is `vorno:workbench:<workbench-type>:<action>`, generalized beyond review.** First type: `review` (`vorno:workbench:review:index`, `:artifact:read`, `:instances:*`, `:threads:*`). Future surface types (e.g. dataset explorers, live dashboards) claim their own `<workbench-type>` segment. **Workbench *instances* are addressed by `workbenchId` in payloads, not in channel names** — channel names stay a static, enumerable set (required by the transport's channel registry and ADR-0012's auditable additive surface); the instance segment of Jeff's `vorno:workbench:<type>:<instance>` sketch is honored as a payload field. All channels are additive per ADR-0012 and recorded in `compatibility.md`'s vorno-surface section.

## Consequences

### Positive

- Reviews become durable workspace data that agents mine with zero new machinery, and the store/index become the exact substrate a future DIR-01 canvas projects.
- One page serves desktop and WebUI; future dynamic surfaces reuse the type + store + channel patterns instead of inventing their own.
- Quote+hash anchoring makes stale feedback visible instead of silently wrong.

### Negative

- File-per-thread has no transactional cross-thread consistency; acceptable at review scale, revisit if threads ever need atomic multi-file updates.
- No push events in v0.1 — concurrent editing across clients relies on refetch; a `vorno:workbench:review:changed` push is the known follow-up.
- Workbench availability is tied to app releases (accepted deliberately — it *is* the product surface).

### Neutral

- The store schema (`schemaVersion` on every file) follows the additive-only evolution discipline ADR-0013 §4a established for the vault header.
- Channel payloads carrying `workbenchId` means AuthZ can later scope workbenches per principal at the same workspace choke point ADR-0013 fixed.

## Alternatives considered

- **Sidecar files next to artifacts** — rejected: pollutes session folders and the git corpus; scatters review state across roots; mining requires a directory walk of everything.
- **Review state written into the governance corpus** — rejected: comments are working state; the corpus is decisions. Promotion stays explicit so the corpus records outcomes, not chatter.
- **Standalone review app** (`apps/viewer` template) — rejected: duplicates transport/auth/session access the shared renderer provides free; contradicts VISION's "grow the shell."
- **Channel-per-instance naming** (`vorno:workbench:review:<workbenchId>:…`) — rejected: dynamic channel names break the static channel registry and make the additive surface unauditable; instance addressing belongs in payloads.
- **A dedicated reviews MCP tool now** — deferred (YAGNI): plain files are already minable; a tool waits for demonstrated demand.

## References

- PLAN-024 (implementation), DIR-01 (canvas direction this feeds), ADR-0012 (`vorno:*` namespace), ADR-0013 (workspace AuthZ grain, additive-format discipline).
- Options analysis: session 260719-young-willow `plans/review-workbench-options.md`.
