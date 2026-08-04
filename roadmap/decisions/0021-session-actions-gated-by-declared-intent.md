---
id: ADR-0021
title: Gate session-mutating automation actions on declared intent, not on transport
status: proposed
date: 2026-08-04
supersedes: []
superseded-by: []
---

# ADR-0021 — Gate session-mutating automation actions on declared intent, not on transport

## Context

PLAN-014 introduced three session-mutating automation actions — `set-status`, `set-labels`,
`send-message` — and scoped them to `WebhookReceived` matchers only. The restriction is
enforced twice:

- `packages/shared/src/automations/validation.ts:24` — `WEBHOOK_ONLY_ACTION_TYPES`, producing
  the error *"Action type `X` is only supported on WebhookReceived matchers (v1)"*.
- `packages/shared/src/automations/handlers/session-action-handler.ts:80` —
  `if (event !== 'WebhookReceived') return;`

The `(v1)` marker in both the constant's comment and the error string records this as **scope
limitation, not a security property**. Nothing about the webhook transport makes a status
change safer. The actual safety properties are elsewhere:

- **Declared intent.** A session action is written into `automations.json` by a human, reviewed
  at registration time, and executed deterministically. It is not inferred by a model mid-run.
- **`allowClosed` opt-in.** `set-status` refuses a `closed`-category status unless the action
  explicitly sets `allowClosed: true` (`apps/server/src/webhooks/executors.ts:121`, mirrored in
  `apps/electron/src/main/trigger-server/webhook-executors.ts:177`).

Meanwhile the *agent-facing* path is gated differently and more tightly: the
`set_session_status` MCP tool refuses closed statuses unconditionally, with no bypass
(`packages/session-tools-core/src/handlers/set-session-status.ts:29`) — "closing a task is the
user's decision." These are two different trust models that have been conflated under one
house rule, and the conflation is what makes the current behavior confusing.

The restriction has a real cost, now observed. Every practical session-lifecycle rule keys off
`LabelAdd` or `SessionStatusChange`, not a webhook. Attempts to write such rules fail in ways
the system does not report:

1. `ActionDefinitionSchema` ends in a `z.object({ type: z.string() }).passthrough()` catch-all
   (`schemas.ts:114`), so an invented action type such as `setSessionStatus` validates clean and
   dispatches to no handler.
2. `AutomationMatcherSchema` is non-strict (`schemas.ts:231`), so an invented matcher key such
   as `labelId` is silently stripped. `matchesBasePredicate` treats a missing `matcher` as
   *match everything* (`utils.ts:174`), converting a mis-keyed filter into an unfiltered rule.
3. History records **dispatch, not effect**. The live `next-step-spawn-followup` automation has
   eight `ok: true` history entries while its final instruction — set the originating session to
   `done` — is rejected on every run by the MCP closed-status guard. The record says success;
   the outcome never happened.

The net result is a class of automation that is silently dead, and a config surface that
reports "valid" for it. Two such rules exist in the live workspace with zero history entries.

There is also a third-party precedent inside our own code: the Tasks Conductor sets terminal
statuses directly via `SessionManager.setSessionStatus`, bypassing the MCP guard entirely —
because a declarative DAG that has run to completion *is* declared intent. That exception is
already documented in the guard's own comment.

## Decision

**The trust boundary for session-mutating actions is whether the intent was declared by a human
at registration time — not which event carried it.**

1. **Lift the transport restriction.** `set-status`, `set-labels`, and `send-message` become
   valid on any app event, not only `WebhookReceived`. `WEBHOOK_ONLY_ACTION_TYPES` and the
   `SessionActionHandler` early-return are removed together, so validation and runtime cannot
   drift apart.

2. **Keep `allowClosed` as the closure gate, and keep it registration-time only.** Moving a
   session into a `closed`-category status still requires `allowClosed: true` written in
   config. There is no runtime, prompt, or tool-mediated path to set it. The agent-facing MCP
   guard is unchanged and remains unconditional: a model may never close a task from inside a
   turn, on any event.

3. **Replace transport-scoping with loop safety**, which is the property the webhook restriction
   was incidentally providing. Session actions mutate session state, and session state changes
   emit events — so `set-status` on `SessionStatusChange` and `set-labels` on `LabelAdd` are
   self-feeding by construction. Three guards, all mandatory:
   - **Provenance + depth cap.** Events emitted as a consequence of an automation action carry
     a `causedBy: { matcherId, depth }` marker. Actions are refused past a fixed depth (3).
   - **Self-trigger suppression.** A matcher never re-enters on an event its own action caused,
     regardless of depth.
   - **Rate gate.** Per-matcher rate limiting, reusing
     `packages/shared/src/automations/webhook-ingest/rate-gate.ts`.

4. **Unknown action types and unknown matcher keys are diagnostics, never silence.** Parsing
   stays lenient — an unrecognized type must not fail the whole config load, so a config written
   by a newer build still opens. But an unrecognized action type is a **validation error** and
   the matcher is **skipped at runtime with a history record**, and an unrecognized matcher key
   is a **validation warning** naming the key. A rule that cannot run must never present as
   healthy.

5. **History records effect, not dispatch.** A session action writes its outcome — applied,
   rejected, skipped, and why. Prompt actions whose instructions are rejected downstream are out
   of scope here (the prompt succeeded; the model's tool call failed), but the rejection is
   surfaced in the session rather than swallowed.

## Consequences

### Positive

- Label- and status-driven session lifecycle rules become expressible — the common case that
  motivated PLAN-014's action types in the first place.
- The two trust models are separated and each is stated: models never close tasks; humans may
  declare that a rule does. The house rule stops being ambiguous.
- Misconfigured automations become loud. This is the larger practical win: the failure that
  prompted this ADR cost more than the missing feature did.
- Loop safety becomes an explicit, tested property rather than an accident of transport choice.

### Negative

- Loop safety is real engineering, not a flag flip. Provenance has to thread through the event
  bus, which touches emission sites well outside the automations package.
- `allowClosed: true` on a `LabelAdd` matcher is a genuinely sharper tool than it was on a
  webhook: applying a label now closes a task. That is the requested behavior, and it is
  opt-in, declared, and auditable — but it is sharper.
- Tightening validation will surface existing broken configs as errors, including two in Jeff's
  live workspace. That is the point, but it is a visible break at upgrade.

### Neutral

- Fork-owned surface. The automations webhook/session-action layer is +4,126 lines over
  upstream and carries `fork(PLAN-014)` markers throughout; upstream has no equivalent. No
  wire-compatibility contract is touched, so `roadmap/upstream/compatibility.md` needs no
  amendment — but the delta grows, and upstream sync cost with it.
- `~/.craft-agent/docs/automations.md` documents only `prompt` and `webhook`. The docs were
  behind the build before this ADR and will be further behind after it; PLAN-030 carries the
  doc update as an acceptance item, not a follow-up.

## Alternatives considered

- **Leave the restriction; use prompt actions for lifecycle rules.** This is the current
  workaround and it cannot reach a closed status by design — the MCP guard refuses, correctly.
  It also spawns a full agent session per fire to perform a deterministic state change, which is
  expensive, non-deterministic, and observably unreliable (`next-step-spawn-followup`).
- **Lift the restriction without loop guards.** The cheapest change and the most dangerous:
  `set-status` on `SessionStatusChange` is an unbounded loop on first use. Rejected outright.
- **Allow closed statuses only on webhooks, lift the rest.** Preserves a distinction that has no
  underlying rationale, and blocks the exact rule that motivated the work (`auto-close` →
  `done`). Rejected as incoherent once the trust model is stated plainly.
- **Make the schema strict (`.strict()`, drop the catch-all).** Correct diagnosis, wrong
  severity: a hard parse failure on one unknown key takes down every automation in the file,
  including on downgrade. Lenient parse plus loud diagnostics gets the same protection without
  the cliff.

## References

- PLAN-014 (`roadmap/plans/done/PLAN-014-workspace-webhooks.md`) — origin of the action types
  and the `(v1)` webhook scoping.
- PLAN-030 — implementation of this ADR.
- `packages/shared/src/automations/{schemas,validation,utils}.ts`,
  `handlers/session-action-handler.ts`.
- `packages/session-tools-core/src/handlers/set-session-status.ts` — the agent-facing guard,
  deliberately unchanged.
- DIR-03 (The Live Observatory) — conducting a session fleet; DIR-04 (Dynamic Workspaces) —
  context profiles as declarative surface state.
