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
   drift apart. *(Amended 2026-08-05:)* the removal must additionally land with **a session-action
   executor wired into SessionManager's `AutomationSystem`** — `onSessionActions` is currently
   supplied only by the webhook dispatcher, so deleting the restriction without the executor
   converts the loud validation error into a silently dead rule, the exact defect §4 exists to
   prevent.

2. **Keep `allowClosed` as the closure gate, and keep it registration-time only.** Moving a
   session into a `closed`-category status still requires `allowClosed: true` written in
   config. There is no runtime, prompt, or tool-mediated path to set it. The agent-facing MCP
   guard is unchanged and remains unconditional: a model may never close a task from inside a
   turn, on any event.

   *(Amended 2026-08-05 — third writer, and the choke point.)* This section originally enumerated
   two writers, agent and automation, and reasoned carefully about both. There is a **third**: the
   renderer. `sessions.ts`'s `setSessionStatus` RPC — the path Kanban drag-drop and every status
   menu use — went straight into `SessionManager.setSessionStatus`, which validated nothing. So
   the invariant this section states was enforced on the agent path only; a human's own mouse, and
   any future call site, had no gate at all.

   The resolution follows this ADR's own title rather than adding a fourth rule: **the gate moves
   to the single choke point every writer shares**, and each caller declares an origin
   (`user | host | automation | agent | unattributed`). Closure authority is a property of the
   declaration, not of the call site remembering to check. A caller that declares nothing cannot
   close — new code fails closed.

   **The renderer path is declared intent and stays frictionless.** Dragging a card into a closed
   column *is* the human declaring the task done; the product's premise is that when a task is
   done it should be Done. So `user` may close with **no confirmation dialog** — the gate exists
   to classify callers, not to obstruct the primary way a human closes a task. Adding friction
   there would be a regression, and was explicitly rejected.

   `host` (TaskRunner's DAG completion, mini-agent auto-complete) may close, formalizing the
   bypass this ADR's Context already described as legitimate. `automation` may close only with
   `allowClosed: true` — unchanged. `agent` may never close, and the MCP handler keeps its own
   unconditional refusal, which produces a better message for a model than the choke point can.
   Implemented in PLAN-031.

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

   *Mechanism (amended 2026-08-05 — see Amendments).* Provenance does **not** thread through the
   filesystem watcher, because the watcher never sees it: mutation and event were separated by a
   disk round-trip. Instead, the `SessionManager` mutation sites call
   `automationSystem.updateSessionMetadata` **directly** with a complete metadata snapshot spread
   from the managed session, and `causedBy` rides that call. The diff-against-snapshot design
   makes the fs-watch echo a natural no-op, and the watcher demotes to an external-writes-only
   fallback (its automation notify skips self-writes via the existing persistence-queue write
   signature, and fires for external headers at the moment they are *applied*, not read).
   External writes carry no provenance and are treated as user-origin for depth-capping.
   `updateSessionMetadata` is serialized per session (it is read-modify-write around an awaited
   emit), and the executor dispatch is fire-and-forget so a rule can never reenter a mutation
   call already on the stack. This is the same direct-push-on-self-write idiom
   `setKanbanColumn`/`setTaskNodeCount` already use.

4. **Unknown action types and unknown matcher keys are diagnostics, never silence.** Parsing
   stays lenient — an unrecognized type must not fail the whole config load, so a config written
   by a newer build still opens. But an unrecognized action type is a **validation error** and
   the matcher is **skipped at runtime with a history record**, and an unrecognized matcher key
   is a **validation warning** naming the key. A rule that cannot run must never present as
   healthy.

   Three classes of "validates clean, can never run" are in scope, not one. Beyond the invented
   type, an action whose type is *real* but whose required fields are missing falls through the
   union's catch-all identically (and throws at runtime rather than no-opping), and a whole
   block filed under a typo'd event name is discarded by the config transform with a single
   lumped warning. All three are inspection-path errors and all three write a load-time
   diagnostic.

   **The inspection path is also the agent write gate.** `validateAutomationsContent` backs both
   `config_validate` and the PreToolUse gate on agent edits to `automations.json`. Making
   unknown action types hard errors there means an older build's agent cannot edit *any* part of
   a config carrying a newer build's action type — a real narrowing of the forward-compatibility
   promise the load-path leniency is designed to keep. This is deliberate. The failure this ADR
   exists to prevent was an agent writing an invented action type and reporting success; a gate
   that lets that through is not a gate. Loading a newer config still works, which is the
   property that protects a user who downgrades. Only agent-mediated *edits* are blocked, and
   they fail loudly with the offending type named.

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

- Loop safety is real engineering, not a flag flip. The emit path had to be restructured so the
  mutation sites feed the automation differ directly — a change in `SessionManager`, well outside
  the automations package (shipped as Phase 1 groundwork; see Amendments).
- `allowClosed: true` on a `LabelAdd` matcher is a genuinely sharper tool than it was on a
  webhook: applying a label now closes a task. That is the requested behavior, and it is
  opt-in, declared, and auditable — but it is sharper.
- Tightening validation will surface existing broken configs as errors, including two in Jeff's
  live workspace. That is the point, but it is a visible break at upgrade.
- An older build's agent cannot edit a config carrying a newer build's action type (see §4).
  Loading is unaffected; only agent-mediated edits are gated. Accepted as the cost of having a
  gate at all.

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

## Amendments

- **2026-08-05 — §1, §3: provenance mechanism corrected from "thread through emission sites" to
  "direct emit at the mutation sites"; §1 pairing widened to include the executor.** The Phase 0
  review verified two findings against the code: (a) `onSessionActions` is wired only into the
  webhook dispatcher, so the §1 "removed together" pair named the wrong components; (b) the
  mutation sites never emitted the events at all — a filesystem watcher did, one disk round-trip
  later, leaving no parameter to thread. An interim proposal (short-TTL correlation claims
  matched across the round-trip, making provenance heuristic) was reviewed by Jeff and
  **withdrawn** in favor of the strictly simpler mechanism now described in §3: the mutation
  sites call the automation differ directly with a full snapshot and exact `causedBy`; the
  watcher demotes to an external-writes-only fallback. The *decision* — loop safety replaces
  transport scoping — is unchanged. PLAN-030's Phase 1 section carries the verified findings
  and the implementation ordering.

- **2026-08-05 — §2: the closure gate moves to the choke point, and a third writer is named.**
  A whole-system review of the Projects/Tasks/Kanban surface found that §2's two-writer model was
  incomplete: `SessionManager.setSessionStatus` performed no validation at all, and the renderer's
  status RPC (Kanban drag-drop, status menus) reached it ungated. "The human owns closure" was
  asserted in three places and enforced in one — the agent-facing MCP handler. Rather than add a
  fourth per-call-site check, the gate moved into the one choke point all writers share, with each
  caller declaring a `StatusChangeOrigin`; callers that declare nothing cannot close. Decided at
  the same time: the human UI path closes **without a confirmation prompt**, because dragging a
  card into a closed column is itself the declaration of intent and is the product's intended way
  to close a task. The trust model in §2 is otherwise unchanged — `allowClosed` still gates
  automations, and models still may never close. Implemented in PLAN-031; no wire change.

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
