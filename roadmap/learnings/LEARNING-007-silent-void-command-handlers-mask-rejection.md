---
id: LEARNING-007
title: Void-returning command handlers make rejections resolve as success, hiding the failure
date: 2026-06-28
status: active
component: server-core / sessions / annotations · RPC contract
related-plans: []
related-decisions: []
---

# LEARNING-007 — Void command handlers turn rejections into silent "success"

## Signal

In the web UI, highlighting text → "follow-up" → typing a note → Save/Enter:
the popup **closes immediately**, **no error toast**, and **no follow-up chip**
appears. It "worked for a while, then suddenly stopped," coinciding with the
iPad backgrounding/reconnecting. No error anywhere the user could see.

## Root cause

`SessionManager.addMessageAnnotation` (and `update`/`remove`) returned `void`.
Every rejection branch — session missing, **message missing**, invalid payload,
**messageId mismatch**, oversized, duplicate id, per-message cap — did a bare
`return`. The RPC handler `return sessionManager.addMessageAnnotation(...)`
forwarded that `void` as a **resolved** promise. The renderer can't distinguish
"saved" from "silently dropped," so it ran `markSubmitSuccess()` (which closes
the island) and emitted no chip, because the server emitted no
`message_annotations_updated` event.

The likely runtime trigger here was a **stale message reference after reconnect**
(`message-not-found` / `message-id-mismatch`): when the iPad backgrounded and the
web client reconnected, the messageId the client annotated no longer resolved in
the server's in-memory `managed.messages`, so the add hit an early guard.

## How it was diagnosed (worth repeating)

The exact failure was pinned **without a repro**, by two moves:

1. **Symptom logic narrows the call site.** In the client save path, a lost
   selection or a throwing handler both leave the popup *open* (and a throw also
   toasts). The popup closing with *no toast* means `markSubmitSuccess` ran —
   i.e. the save **resolved as success**. So the bug is post-resolution: the
   server accepted the call and dropped the data.
2. **On-disk evidence falsifies the obvious culprit.** The 200/message cap was
   the headline suspect, but counting annotations across every recently-active
   session (`session.jsonl` per session) showed a **max of 6** on any message —
   and the failed adds were **absent from the jsonl**, proving they never
   persisted. That ruled out the cap and pointed at an *early* guard.

## Fix

Make the mutation handlers report outcome instead of returning `void`:

- New `AnnotationMutationResult = { success: true } | { success: false; reason }`
  in `@craft-agent/core` (`AnnotationMutationFailureReason` enumerates the
  guards). `add`/`update`/`removeMessageAnnotation` now return it; each guard
  returns a typed `reason`, success returns `{ success: true }`.
- The RPC already forwards the return value; widened the `sessionCommand` result
  union in `apps/electron/src/shared/types.ts`.
- The renderer (`ChatDisplay.tsx`) inspects the result: on `success: false` it
  shows a toast naming the reason and **throws**, so the follow-up popup stays
  open with the typed note (the existing catch path) instead of closing with
  nothing saved. `describeAnnotationMutationFailure` maps each reason to a
  human message; the stale-reference reasons advise reloading.

Wire-compat preserved: `MessageEnvelope`/`AgentEvent`/channel names/skill schema
unchanged. The command *result* shape is widened additively (old callers ignored
the return; the web path forwards it via the same `buildClientApi` invoke).

## Recurrence

Any RPC-backed command handler that `return`s `void` on its reject branches has
this failure mode: the client sees a resolved promise and assumes success. Watch
for `sessionLog.warn(...); return` patterns inside methods wired to
`sessions.COMMAND` (or any `server.handle` that forwards a manager method).

## Prevention

- Server reject branches should return a discriminated result (or throw), never
  a bare `void`, when a client acts on success/failure.
- Tests: `packages/server-core/src/sessions/message-annotation-result.test.ts`
  pins a result for every branch and asserts no event on rejection (CI-gated).
  `ChatDisplay.follow-ups.test.ts` covers the reason→message mapping.
- Diagnostic rule of thumb captured above: **"popup closed + no toast" ⇒ the
  call resolved ⇒ look server-side**, and **count the persisted artifacts on
  disk before blaming a cap.**

## References

- `packages/server-core/src/sessions/SessionManager.ts` —
  `addMessageAnnotation` / `updateMessageAnnotation` / `removeMessageAnnotation`.
- `packages/core/src/types/message.ts` — `AnnotationMutationResult`.
- `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` +
  `ChatDisplay.follow-ups.ts` — client surfacing.
- Sibling silent-drop in the same file: [[LEARNING-006-bpm-gate-resolver-ordering-on-branch]] (gate/resolver disagreement on branch creation).
