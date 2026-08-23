---
id: ADR-0022
title: Activate session context through named profiles, not one action type per knob
status: accepted
date: 2026-08-07
supersedes: []
superseded-by: []
---

# ADR-0022 — Activate session context through named profiles, not one action type per knob

## Context

PLAN-030 exists because two rules in Jeff's live workspace named action types that do not
exist. One of them, `steward-context-activate`, wanted to point a session at a repo and turn
on the sources it needs. The names it invented were `addWorkingDirectory` and `enableSkill`.
Phase 0 made those fail loudly instead of validating clean; it did not answer what the rule
should have said instead.

The obvious answer is to make the invented names real. `validation.ts` even carried five
alias entries mapped to `null` — `addworkingdirectory`, `setworkingdirectory`, `enableskill`,
`enablesource`, `applycontext` — annotated "no equivalent today". Implementing them is a
small diff each, and each looks reasonable in isolation.

It is the wrong shape, and the reason is arithmetic. A session has several context knobs and
the number only grows. One action type per knob means the automation surface is N action
types, N schema entries, N executor branches in three hosts, N documentation rows — and, the
part that actually hurts, every rule that wants a full context has to spell out N actions and
be reviewed as N separate grants. N knobs × M rules. Adding a knob later edits every rule
that already existed.

Two further constraints came out of building it:

1. **Permission mode is one of the knobs**, and it is privileged. An action that can raise a
   session to `allow-all` turns "add a label" into an unreviewed privilege escalation.
2. **Skills have no per-session representation at all.** Working directory, sources, and
   permission mode are persisted session fields with setters. Skills are not: a skill is
   applied by a `[skill:<slug>]` mention in a *message*, parsed out of the message text by
   `base-agent.ts`. There is no session field, no setter, and nothing in
   `SESSION_PERSISTENT_FIELDS`. A profile field named `skills` would either lie or require
   inventing a session-state knob underneath it first.

## Decision

**Session context is activated by exactly one automation action — `apply-context` — which
names a profile declared in `context-profiles/config.json`. New context knobs become fields
on the profile, never new action types.**

```jsonc
// automations.json
{ "type": "apply-context", "session": { "id": "$CRAFT_SESSION_ID" }, "profile": "steward" }
```

```jsonc
// context-profiles/config.json
{ "version": 1, "profiles": [{
  "id": "steward",
  "workingDirectory": "/Users/jeffhampton/dev/steward",
  "sources": ["dev"],
  "permissionMode": "ask"
}] }
```

The indirection is the whole point: the profile is reviewed **once** and referenced by id
from any number of rules, so the review burden is per-context rather than per-rule, and it
is auditable in one file. The automation surface stays at one action type permanently.

Four consequences of that ruling, each load-bearing:

**1. The profile schema is strict.** Unlike `ActionDefinitionSchema`'s deliberate
`.passthrough()` catch-all (ADR-0021 §4), an unknown profile key is an error. The
forward-compatibility argument does not transfer: an unknown *action type* must not take a
whole `automations.json` down with it, but an unknown *profile key* means someone reached
for a knob that does not exist — the exact failure Phase 0 exists to make loud. An invalid
file loads **no** profiles rather than the valid subset; a profile carries a permission mode,
so half-accepting one is worse than rejecting it, and `apply-context` then reports
`rejected:unknown-profile` in run history rather than silently applying a partial context.

**2. Raising permission mode requires `allowEscalation` on the profile.** Lowering is always
permitted. This mirrors `allowClosed` (ADR-0021 §2) exactly: the privileged direction is
opt-in at registration time, in a file a human reads, with no runtime path that sets it. The
flag sits on the **profile** rather than on the action because the profile is the artifact a
reviewer reads — splitting it into `automations.json` would mean the file declaring
`"permissionMode": "allow-all"` cannot tell you whether that escalation is authorized.

This guard is **not** a closure guard, and conflating the two would be a mistake.
`apply-context` cannot close a session: there is no status field on a profile, and permission
mode is not an input to either closure rule. The PLAN-031 choke point refuses on the caller's
declared *origin* (`agent` never closes) and the MCP `set_session_status` handler refuses
every closed category unconditionally — neither reads permission mode. Escalating a session
buys an agent nothing on the closure path. The guard exists because unreviewed escalation is
bad on its own terms.

**3. Profiles do not carry skills, and saying so is a config error.** The schema declares
`skills` explicitly so that writing it produces an explanation — "skills activate per-message
via a `[skill:<slug>]` mention; there is no session-level skill state" — rather than a bare
`Unrecognized key`. Making skills a session-level knob is real work with its own design
questions and is deferred to **PLAN-032**. Accepting the key before that knob exists would
ship precisely the silent no-op PLAN-030 was written to eliminate.

**4. The five `null` aliases now suggest `apply-context`.** `addworkingdirectory`,
`setworkingdirectory`, `enableskill`, `enablesource`, and `applycontext` all resolve to it.
These are the near-miss diagnostics that catch someone reaching for a knob that no longer
needs to exist. `enableskill` is included deliberately even though profiles cannot carry
skills: `apply-context` is still the right destination, and the profile schema explains the
limitation precisely when they arrive — a far better error than "valid action types are: …".

## Consequences

### Positive

- The automation action surface is fixed at six types. A seventh context knob costs a
  profile field, a line of docs, and nothing else — no schema union member, no executor
  branch in three hosts, no edit to rules that already exist.
- A label becomes a declarative context activator: `LabelAdd` → `apply-context`, reviewed
  once, reused everywhere.
- Permission-mode escalation is now a named, recorded refusal instead of an implicit
  capability, and the asymmetry (lower freely, raise on opt-in) means a rule that
  *restricts* an agent never fails closed.
- The `null` aliases stop being dead ends. Every hallucination pattern in that table now
  routes somewhere real.

### Negative

- One more config file to know about. `context-profiles/config.json` has no management UI;
  it is hand-edited, like `automations.json` was for its first three phases.
- Strict parsing means a typo in one profile disables all of them. Deliberate, and the
  refusal is recorded — but it is a sharper failure than the automations config's lenient
  path, and the two now behave differently on purpose.
- The standalone trigger server cannot execute `apply-context` and records
  `deferred:host-unreachable`. It *could* write the session header — all three knobs are
  persisted fields — which is exactly the trap: sources and permission mode only take effect
  by re-plumbing a live agent, so a header write would record success while the running
  session kept its old context.

### Neutral

- No cache and no `ConfigWatcher` entry: the config is read off disk per call, like
  `isValidStatusId`. An edit takes effect on the next fire. If a hot path ever reads
  profiles per-event this needs revisiting.
- `setSessionPermissionMode` gained an optional `cause` parameter. Without it the emitted
  metadata event reads as user-originated, resetting chain depth and defeating the depth cap
  (ADR-0021 §3). Every non-automation caller correctly omits it.
- The security note in ADR-0021 §3 applies unchanged and slightly harder: provenance is a
  correctness mechanism, not a security boundary, and `context-profiles/config.json` sits in
  the same trust domain as `automations.json` — anyone who can edit one can edit the other,
  so `allowEscalation` is a review aid, not an access control.

## Alternatives considered

- **One action type per knob** (`addWorkingDirectory`, `enableSource`, …) — the option the
  broken rules implied. Rejected on the N × M arithmetic above: it is cheapest at exactly
  one knob and gets worse monotonically, and it puts the review burden on every rule.
- **Inline context on the action** (`{ "type": "apply-context", "workingDirectory": …,
  "sources": […] }`) — no second config file, and the rule is self-describing. Rejected
  because it loses the review-once property that motivated the whole design: five rules
  sharing a context means five copies to keep in step, and an inline `permissionMode` puts
  an escalation grant in the same place as everything else rather than somewhere a reviewer
  looks deliberately.
- **`allowEscalation` on the action rather than the profile** — tighter, since each rule
  would opt in individually. Rejected because it separates the escalation from its
  declaration: `automations.json` would authorize a mode it cannot see. Both files are
  local-workspace-writable anyway, so the difference is review ergonomics, not access
  control, and review ergonomics favor keeping the two together.
- **Accept `skills` in the profile and no-op it** — matches the plan text as written.
  Rejected outright: a silently ignored field is the defect PLAN-030 exists to eliminate,
  and shipping one inside the fix would be self-defeating.
- **Ship session-sticky skills in this phase** — makes the profile cover all four knobs the
  plan names. Rejected on scope: it needs new persisted session state and a decision about
  injecting skill mentions into messages the user did not write, which has its own UI and
  transcript questions. Split to PLAN-032, which PLAN-030 explicitly sanctions.

## References

- PLAN-030 Phase 3 — `roadmap/plans/documented/PLAN-030-session-lifecycle-automation.md`
- PLAN-032 — session-sticky skills (the deferred fourth knob)
- ADR-0021 — session actions gated by declared intent (`allowClosed`, loop safety, the
  lenient-union ruling this ADR deliberately does not follow)
- PLAN-031 / ADR-0021 §2 — the status-closure choke point that `apply-context` cannot reach
- DIR-04 — dynamic workspaces; a profile is the surface-plane idea applied to sessions
