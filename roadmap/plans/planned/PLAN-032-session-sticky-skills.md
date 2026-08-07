---
id: PLAN-032
title: Session-sticky skills — make skills a session knob so a context profile can carry them
status: planned
direction: DIR-03
owner: jh
created: 2026-08-07
updated: 2026-08-07
related:
  - PLAN-030
  - ADR-0022
blocked-by: []
---

# PLAN-032 — Session-sticky skills

## Goal

Give a session a durable set of active skills, so that `apply-context` (ADR-0022) can carry
`skills` as a fourth profile knob without lying about what it does.

## Why this is a separate plan

PLAN-030 Phase 3 names four context knobs: working directory, skills, sources, permission
mode. Three of them are real session state — persisted fields in `SESSION_PERSISTENT_FIELDS`
with setters on `SessionManager` (`updateWorkingDirectory`, `setSessionSources`,
`setSessionPermissionMode`). **Skills are not.** Verified against the code on 2026-08-07:

- No `skills` / `enabledSkills` field on `SessionHeader`, `ManagedSession`, or
  `SESSION_PERSISTENT_FIELDS`.
- No `setSessionSkills` method and no RPC case for one.
- A skill is activated by a `[skill:<slug>]` **mention in a message**, parsed by
  `base-agent.ts:extractSkillPaths` → `parseMentions`, which then blocks tool use until the
  SKILL.md is read.
- `sendMessage`'s `options.skillSlugs` is *not* an activation path. Its only effect is
  pre-enabling the sources a skill declares (`SessionManager.ts:6142`, issue #249). Wiring a
  profile to it would produce a knob that looks like it works and does not — worse than
  having no knob.
- `TaskRunner.skillsPreamble` is the one existing mechanism, and it confirms the shape:
  activation means **prepending `Apply these skills: [skill:x]` to a prompt**.

So a profile field named `skills` requires inventing the session-state knob first. That work
carries design questions PLAN-030 Phase 3 has no business answering, which is why ADR-0022
rejects the alternative of accepting the field and no-oping it — a silently ignored field is
the exact defect PLAN-030 exists to eliminate.

## Scope

- A persisted per-session set of active skill slugs.
- A mechanism that makes those skills actually apply to the agent's turns.
- Once both exist: add `skills` to `ContextProfileSchema` and delete the deliberate
  rejection in `packages/shared/src/context-profiles/schema.ts`.

## Non-goals

- Changing how `[skill:<slug>]` mentions work in user-typed messages.
- A skills marketplace, versioning, or scoping — unrelated.

## Open questions (the actual work)

1. **Where does activation happen?** Prepending a preamble to the user's message changes
   what the user typed and shows up in the transcript. Injecting it as hidden context is
   less intrusive but makes "which skills are on" invisible. `TaskRunner` chose the former
   for a path where the prompt is machine-authored; a live session is not that path.
2. **Every turn, or once?** A skill's SKILL.md read is enforced once per session by the
   base-agent gate. Re-sending the preamble every turn is wasteful; sending it once means a
   compaction can lose it.
3. **How does the user see and remove it?** A session silently carrying three skills is its
   own kind of invisible state. Needs a surface, which means renderer work and i18n keys.
4. **Interaction with `options.skillSlugs`.** The existing source pre-enable should
   presumably also fire for sticky skills; confirm it does not double-enable.
5. **Does a sticky skill survive branching, transfer, and task promotion?** Those paths copy
   `SESSION_PERSISTENT_FIELDS` selectively.

## Acceptance

- [ ] A session carries a durable set of active skill slugs across restart.
- [ ] An active skill demonstrably reaches the agent — asserted by the SKILL.md read gate
      firing, not by the field being set.
- [ ] The user can see and clear a session's active skills.
- [ ] `ContextProfile.skills` is accepted, and the `z.never()` rejection plus its test case
      in `context-profiles/storage.test.ts` are removed in the same commit.
- [ ] `apply-context` applies skills and names them in the history record's `applied` list.
- [ ] `automations.md` drops the "Skills are not a profile field" note.
- [ ] Tests added/updated.

## Status log

- `2026-08-07` — created in `planned/`, split out of PLAN-030 Phase 3 per that plan's
  "Phase 3 is separable and may be split into its own plan" clause. Phase 3 shipped the
  other three knobs; this is the fourth.
