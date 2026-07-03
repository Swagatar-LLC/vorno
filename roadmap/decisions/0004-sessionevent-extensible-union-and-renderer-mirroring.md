---
id: ADR-0004
title: SessionEvent is a fork-extensible union; renderer AgentEvent mirroring is opt-in
status: accepted
date: 2026-06-28
supersedes: []
superseded-by: []
---

# ADR-0004 — SessionEvent is a fork-extensible union; renderer AgentEvent mirroring is opt-in

## Context

The artifact-store design (`plans/artifact-store-design.md`) adds ONE additive arm,
`craft-fork:artifact_changed`, to the wire `SessionEvent` union in
`packages/shared/src/protocol/dto.ts` (the union spans lines 178-222). To make that
arm "safe," the design repeatedly instructed implementers to *"add default/no-op cases
to every exhaustive `switch` over `SessionEvent`."* An adversarial wire-compat review,
independently confirmed against the repo, found this guidance is **mis-aimed**: it
targets a type that has no exhaustive consumer, while ignoring the type that actually
does.

There is a **dual-union reality** that the original guidance conflated:

1. **The wire union — `SessionEvent`** (`packages/shared/src/protocol/dto.ts:178-222`).
   This is the over-the-wire payload (main → renderer). Verified: there is **NO**
   `never`-checked / exhaustive `switch` anywhere over this union. (No `switch` exists
   in `dto.ts` at all; no consumer in the repo does a `_exhaustiveCheck: never` over the
   wire `SessionEvent`.)

2. **The renderer-local union — `AgentEvent`** (`apps/electron/src/renderer/event-processor/types.ts:475-516`).
   This is a separate, hand-maintained union of `*Event` interfaces local to the
   renderer's central event-processor reducer. The ONE exhaustive switch lives here:
   `apps/electron/src/renderer/event-processor/processor.ts` switches over `AgentEvent`
   and ends with `const _exhaustiveCheck: never = event` in its `default` case
   (processor.ts:215).

The wire event is bridged into the renderer union by an **unchecked cast** at
`apps/electron/src/renderer/App.tsx:956`:

```ts
const agentEvent = event as unknown as AgentEvent
```

Because this is `as unknown as AgentEvent`, the cast does not require the wire `type`
to be a member of the renderer `AgentEvent` union. An unmapped wire arm passes through
the cast and reaches the processor's `default` branch.

Critically, ADR-0001 clause 2 (`roadmap/decisions/0001-fork-relationship-with-upstream.md:23`)
names ONLY `MessageEnvelope`, `AgentEvent` (the *wire-level* one under
`packages/shared/src/agent/`), source/skill conventions, and CRDT contracts as the
protected wire contract. It does **not** mention `SessionEvent`. Note three distinctly
named things must not be conflated: the wire `SessionEvent` (dto.ts), the renderer-local
`AgentEvent` (event-processor/types.ts), and the protected wire-level `AgentEvent`
(`packages/shared/src/agent/`). `SessionEvent` is therefore not a frozen ADR-0001
contract — adding an arm to it is doubly safe.

## Decision

**`SessionEvent` is a fork-extensible union. Renderer-local `AgentEvent` mirroring is
opt-in, required only when an arm must be handled inside the central event-processor
reducer.**

1. **`craft-fork:artifact_changed` is added ONLY to the wire `SessionEvent` union in
   `dto.ts`.** It is consumed by a dedicated artifact event bridge/hook
   (`useArtifactEventBridge`, subscribing to `onSessionEvent`), NOT by the renderer-local
   `AgentEvent` processor. It is therefore **NOT** added to the renderer-local `AgentEvent`
   union, and **NO** "default cases" are added to any `SessionEvent` switch — none exist.
   It round-trips safely via the processor's existing `default` branch (zero risk; see
   proof below).

2. **The convention going forward:** the wire `SessionEvent` is a FORK-EXTENSIBLE union;
   additive arms (especially `craft-fork:`-prefixed ones) are safe and require no new ADR.
   Renderer-local `AgentEvent` mirroring is OPT-IN — required ONLY when an arm needs
   handling inside the central event-processor reducer (`processor.ts`). Arms consumed by
   their own dedicated hooks/subscriptions MUST NOT be mirrored into `AgentEvent`.

### Round-trip safety proof (structural, not merely "ignored")

The safety claim rests on two facts, both verified:

**(a) The envelope carries event payloads as opaque `unknown`.** `MessageEnvelope`
(`packages/shared/src/protocol/types.ts:20`) declares:

```ts
/** Request args or event payload. */
args?: unknown[]
/** Response payload. */
result?: unknown
```

A new `SessionEvent` `type` string is transported as opaque JSON. Any parser — including
a vanilla upstream client — deserializes the envelope without error; the unknown `type`
is just a string in an `unknown` payload. The envelope shape is structurally unchanged.

**(b) The renderer's exhaustive `default` no-ops BEFORE the `never` assertion runs.**
The processor's `default` case (`processor.ts:212-220`) is:

```ts
default: {
  // Unknown event type - return state unchanged but as new reference
  // to ensure atom sync detects the "change"
  const _exhaustiveCheck: never = event
  return {
    state: { ...state, session: { ...state.session } },
    effects: [],
  }
}
```

The `const _exhaustiveCheck: never = event` line is a **compile-time-only** assertion. At
runtime it is an inert assignment; control always reaches the `return` and the function
yields state unchanged. It can only become a TYPE error if the renderer `AgentEvent` union
gained the arm and a `case` for it were omitted — i.e. the failure mode requires *adding*
the arm to `AgentEvent` and then forgetting a handler. Since we deliberately do NOT add
`craft-fork:artifact_changed` to the renderer `AgentEvent` union, `event` here remains
typed `never` for that arm and the assertion stays satisfied. The unchecked cast at
`App.tsx:956` lets the wire arm reach this `default` at runtime, where it returns
unchanged. The artifact bridge handles it separately off `onSessionEvent`.

## Consequences

### Positive

- The artifact arm ships with **zero** risk to the event-processor reducer and zero churn
  across non-existent "SessionEvent switches."
- The dual-union reality and the correct mirroring rule are now documented, preventing the
  same mis-aimed mitigation from recurring.
- Confirms `SessionEvent` extensibility is independent of ADR-0001's protected wire
  contract, so fork arms (`craft-fork:*`) are unambiguously additive.

### Negative

- Contributors must understand TWO unions with confusingly similar names (wire
  `SessionEvent` vs renderer-local `AgentEvent`) and a third protected one (wire-level
  `AgentEvent`). This ADR is the disambiguation reference.
- The `as unknown as AgentEvent` cast at `App.tsx:956` is the load-bearing seam that makes
  round-tripping safe but also silently swallows truly-unhandled arms. That is the desired
  behavior here, but it means a mirror is required (not optional) the moment central-reducer
  handling IS needed.

### Neutral — existing mirrored arms (inventory)

The fork already mirrors two additive wire arms into the renderer `AgentEvent` union, and
in BOTH cases the mirror exists because the central reducer genuinely does work — so they
are correct, NOT unnecessary:

- **`message_annotations_updated`** — wire arm at `dto.ts:221`; renderer interface
  `MessageAnnotationsUpdatedEvent` at `event-processor/types.ts:401` / union member :510;
  `processor.ts:189` dispatches to `handleMessageAnnotationsUpdated` (real handler in
  `event-processor/handlers/session.ts:590`, updates annotations on a message). REAL
  handler — mirror justified.
- **`working_directory_error`** — wire arm at `dto.ts:222`; renderer interface
  `WorkingDirectoryErrorEvent` at `event-processor/types.ts:287` / union member :501;
  `processor.ts:137` returns a `toast_error` effect. Does real work (emits a side effect) —
  mirror justified.

**Conclusion: no unnecessary mirrors exist today; no cleanup is warranted.** Should a
future arm be found mirrored as a pure pass-through (mirror present but the `case` only
returns state unchanged with no effect), it would be a candidate for removal — but any such
removal must be a separately tracked cleanup task, never folded into unrelated work.

## Checklist — when adding a new `SessionEvent` arm

(a) **Add it to the wire union** in `packages/shared/src/protocol/dto.ts`. Prefer a
    `craft-fork:`-prefixed `type` for fork-only arms.

(b) **Mirror it in the renderer `AgentEvent` union** (`event-processor/types.ts`) — adding
    a `*Event` interface, a union member, a `processor.ts` `case`, and a handler — ONLY IF
    the central event-processor reducer must handle it. If the arm is consumed by its own
    hook/subscription off `onSessionEvent` (like `craft-fork:artifact_changed` via
    `useArtifactEventBridge`), do NOT mirror it.

(c) **Never** instruct adding "default cases to wire-`SessionEvent` switches" — none exist.
    The only exhaustive switch is over the renderer-local `AgentEvent`
    (`processor.ts:215`), and it already no-ops in its `default` before the
    compile-time `never` check.

## Alternatives considered

- **Add the arm to the renderer `AgentEvent` union too (mirror it).** Rejected for v1: the
  artifact arm has a dedicated bridge and needs no central-reducer state; mirroring would add
  a no-op `case` and a `*Event` interface for nothing, and would (per the checklist) be a
  pure pass-through eligible for later removal anyway.
- **Add `craft-fork:artifact_changed` as a dedicated `craft-fork:artifacts:CHANGED` RPC
  push channel instead of a `SessionEvent` arm.** Rejected: it would require a second
  subscription path; the existing `onSessionEvent` broadcast (`{to:'workspace'}`) already
  carries fork arms and round-trips safely.
- **Keep the original "add default cases to all SessionEvent switches" guidance.** Rejected:
  it targets a type with no exhaustive consumer, gives false confidence, and finds nothing.

## References

- `packages/shared/src/protocol/dto.ts:178-222` (wire `SessionEvent` union)
- `packages/shared/src/protocol/types.ts:20` (`MessageEnvelope`, opaque `args`/`result`)
- `apps/electron/src/renderer/event-processor/types.ts:475-516` (renderer-local `AgentEvent`)
- `apps/electron/src/renderer/event-processor/processor.ts:212-220` (exhaustive `default` + `never`)
- `apps/electron/src/renderer/App.tsx:956` (`event as unknown as AgentEvent` bridge)
- `roadmap/decisions/0001-fork-relationship-with-upstream.md:23` (ADR-0001 protected contract)
- `plans/artifact-store-design.md`, `plans/artifact-store-scope-revision.md` (the design corrected by this ADR)
