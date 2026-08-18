---
id: ADR-0026
title: Make session query a composable predicate surface with an allowlisted projection
status: proposed
date: 2026-08-17
supersedes: []
superseded-by: []
---

# ADR-0026 — Make session query a composable predicate surface with an allowlisted projection

## Context

### The commission

Jeff, 2026-08-17, on being shown that `list_sessions` exposes neither `isArchived` nor
`isFlagged`:

> "This is great and actually deserves an entire plan. `list_sessions` probably needs to expose
> some kind of filtering logic so that we can filter on multiple kinds of fields. I don't know
> what the current logic lets us do, but I think that given the fact that we need to have
> sessions exploring other sessions and more orchestrator-type workflows, this feels like a
> first-class change that we need to plan out."

Two things follow from that framing and both are binding on this ADR. The motivating consumer
class is **orchestration — sessions querying other sessions**. And the deliverable is the
**predicate surface**, not one more boolean bolted onto the existing argument list.

### The defect is a correctness defect, not a cost defect

The `session-archive-sweeper` automation has carried rule 2d — *"never archive a flagged
session"* — for its entire life, and **could never once check it**, because `list_sessions`
returns no flagged field. Two flagged sessions were archived as a result:

- `260607-lively-sparrow` — a PR code review (`archivedAt` 1786756754562)
- `260708-coral-tide` — "OAuth Scopes vs Permissions Architecture" (`archivedAt` 1786756775736)

Both verified present-and-archived by direct header read on 2026-08-17.

**An unenforceable precondition is not a weaker rule, it is an absent one.** A rule that depends
on a field the API does not return is decorative until someone finds the field somewhere else.
That is the primary argument for this ADR. The token savings below are the lesser argument, and
are stated second deliberately.

**Repaired 2026-08-17, Jeff-directed:** both sessions were unarchived. The workspace now holds
**three** flagged sessions and **zero** flagged-and-archived ones, restoring the invariant rule
2d was always supposed to hold.

That repair raises the stakes rather than closing the issue. All three flagged sessions —
`260206-sunny-stone`, `260607-lively-sparrow`, `260708-coral-tide` — are now unarchived, and
the last two are `status: done` and older than the sweeper's 3-day cutoff, so they match every
condition it archives on **except** the flag. They are protected today *only* by a predicate the
API cannot express: the sweeper's out-of-band disk read. Retire that workaround before this API
ships and the next 05:20 run re-archives the exact two sessions we just restored. This is why
PLAN-037 sequences the workaround removal last.

### The measured cost, and one correction to the received framing

Verified independently on 2026-08-17 (23:00 EDT) against
`~/.craft-agent/workspaces/my-workspace/sessions/`, by parsing the first line of every
`session.jsonl`:

| Measure | Value |
|---|---|
| Session directories with a header | 1,417 |
| `isArchived: true` | 1,313 |
| Not archived | 104 |
| Flagged | 3 (of which **2 archived**) |
| Naive `status ∈ {done,cancelled}` enumeration | **978**, of which **941 already archived** |
| Real work list under the sweeper's full predicate | **9** |
| `vshare-reaper` label backlog | 143 labelled, **142 already archived** |

Two figures moved since the original 2026-08-17 measurement and the drift is explained, not
smoothed: the corpus grew 1,413 → 1,417 (four new sessions, one of them this one), and the real
work list grew 7 → 9 as two more 2026-08-14 sessions aged past the sweeper's 3-day cutoff. The
941 redundant-call figure and the 1,313 archived figure reproduce **exactly**. The
`vshare-reaper` backlog grew 129 → 142, tracking its own recorded prediction of "growing by one
per run".

The ratio is the durable number: **941 redundant writes to find 9 real ones**, ~100:1, and it
worsens monotonically because the denominator is history.

**Correction to a premise in the commission.** The brief states that a filtered query "must
report a true post-filter total," implying it does not today. It does. At
`packages/server-core/src/sessions/SessionManager.ts:4442`, `total` is computed *after* every
filter and *before* the page slice. The real pagination defect is different and worth naming
accurately: `DEFAULT_LIMIT = 20` and `MAX_LIMIT = 100` mean a sweep **cannot ask for its whole
work list in one call** and must run an offset loop — which is precisely what `vshare-reaper`
does, paginating `limit 100, offset 100, …` to reach `total`. The problem is the absence of a
"give me every match" mode, not a lying counter.

### This is a projection problem, not a storage problem

The data is already in memory at the exact line where it is thrown away.

- `packages/shared/src/sessions/types.ts:26` — `SESSION_PERSISTENT_FIELDS` declares 40+ fields
  that round-trip to disk, including `isArchived`, `archivedAt`, `isFlagged`, `hidden`,
  `sessionStatus`, `labels`, `projectId`, `parentSessionId`, `taskSlug`, `taskRunId`,
  `taskNodeId`, `kanbanColumn`, `triggeredBy`, `createdAt`, `lastMessageAt`, `lastUsedAt`.
- `packages/shared/src/sessions/storage.ts:355` — `listSessions()` reads **only the first line**
  of each `session.jsonl` and spreads the whole header into `SessionMetadata`.
- `packages/server-core/src/sessions/SessionManager.ts:2444` — `getSessions()` serves from
  `this.sessions`, an already-hydrated in-memory `Map`. No disk read on the query path.
- `packages/server-core/src/sessions/SessionManager.ts:4450` — and here the entire record is
  narrowed to **six fields**:

  ```ts
  sessions: page.map(s => ({
    id: s.id, name: s.name ?? s.id, labels: s.labels ?? [],
    status: s.sessionStatus ?? 'todo', createdAt: s.createdAt ?? 0, projectId: s.projectId,
  }))
  ```

  No `isArchived`. No `isFlagged`. And **no archived filter anywhere in the function** —
  archived sessions are returned as ordinary results.

`get_session_info` (`SessionManager.ts:4394`) has the same shape and the same omissions; a
live call against this workspace returns eleven fields, none of them `isArchived` or `isFlagged`.

The host application already knows better. `getUnreadSummary()` (`SessionManager.ts:2463`)
carries the comment *"Excludes hidden and archived sessions from counts/indicators."* Every
human-facing surface filters archived sessions. The agent-facing tool is the outlier.

### A semantic detail that must not be missed

`isArchived` has **three** on-disk states, not two, and one of them is easy to miss.

Measured 2026-08-17 23:00 EDT, before any repair: present-and-`true` on 1,313 headers, and
**absent** on the other 104 — never `false`. A predicate treating `isArchived: false` as "the
stored value equals false" would have matched **zero** sessions.

Re-measured 23:45 EDT, after unarchiving `260607-lively-sparrow` and `260708-coral-tide`
(Jeff-directed): `true` on 1,311, **absent** on 105, and **explicit `false` on 2**. Unarchiving
*writes* `isArchived: false`; it does not delete the key. So the field is absent until a session
is first archived, and boolean thereafter.

Both absence and explicit `false` must normalize to false, and the tests must cover **both**
representations. A test written against absence alone passes on 105 sessions and silently
mishandles every session that was ever unarchived — a population that starts at 2 and grows
every time someone restores something. Same for `archivedAt`, which is dropped on unarchive.
`sessionStatus` is absent on 273 headers; `labels` on 319.

### Two live automations depend on the on-disk header format

`vshare-reaper` (`0 */6 * * *`) and `session-archive-sweeper` (`20 5 * * *`) in
`~/.craft-agent/workspaces/my-workspace/automations.json` both read
`sessions/<id>/session.jsonl` header lines directly, each carrying an inline comment explaining
that `list_sessions` cannot do the job. The header is **not a contract** — it is an internal
serialization governed by `SESSION_PERSISTENT_FIELDS`, free to change in any release. Two
production automations are pinned to it. That coupling is the debt this work exists to retire.

## Decision

**Session query becomes a composable, conjunctive predicate surface over an explicitly
allowlisted contract projection — and archived sessions leave the default result set.**

Six parts.

### 1. A flat AND-map of field predicates, not a query DSL

`ListSessionsOptions` gains a `where` object. Every key is a contract field; keys are combined
with **AND**. There is no OR, no NOT-tree, no nesting.

```ts
where?: {
  isArchived?: boolean            // absence normalizes to false
  isFlagged?: boolean
  hidden?: boolean
  status?: string | { in: string[] } | { not: string }
  labels?: { includesAny: string[] } | { includesAll: string[] }
  projectId?: string | { in: string[] }
  parentSessionId?: string | { in: string[] }
  taskSlug?: string | { in: string[] }
  triggeredBy?: string | { in: string[] }
  createdAt?:     { before?: number; after?: number }
  lastMessageAt?: { before?: number; after?: number }
  lastUsedAt?:    { before?: number; after?: number }
  messageCount?:  { gt?: number; lt?: number }
}
```

Conjunction is what the real consumers need and all they need: the sweeper's predicate is four
ANDed conditions, the reaper's is two. Both express directly. **The named ceiling:** the first
consumer that genuinely needs disjunction gets a `$or` array of these same maps — additive, no
migration. Building the boolean-algebra tree now would be complexity adopted speculatively.

`limit`, `offset`, `status`, `label`, and `search` are **retained verbatim** with unchanged
semantics. `status`/`label` become documented sugar for their `where` equivalents; supplying
both is an error rather than a silent precedence rule.

### 2. Sort gets a direction

`sortDir?: 'asc' | 'desc'`, defaulting to today's behaviour for each existing `sortBy` value
(`recent` → `desc`). Orchestrators get oldest-first for drains and newest-first for triage
without a new sort vocabulary.

### 3. Caller-shaped output over a three-tier allowlist — never a header spread

The returned record is always an **enumerated allowlist**, never `...header`. But the allowlist
is split into three tiers rather than one flat contract set, and the caller shapes which of the
first two it gets:

```ts
fields?: SessionField[]   // omitted = default projection
```

**Tier 1 — default projection** (returned when `fields` is omitted). Today's six, plus the two
that make rule 2d enforceable:

`id`, `name`, `status`, `labels`, `createdAt`, `projectId`, **`isArchived`**, **`isFlagged`**

**Tier 2 — requestable via `fields`**: tier 1 plus `archivedAt`, `kanbanColumn`, `lastMessageAt`,
`lastUsedAt`, `parentSessionId`, `taskSlug`, `taskRunId`, `taskNodeId`, `triggeredBy`,
`messageCount`, `permissionMode`, `model`, `llmConnection`, `hidden`.

**Tier 3 — never exposed, not requestable at any value of `fields`**: `sdkSessionId`, `sdkCwd`,
`workspaceRootPath`, `shareEditToken`, `sharedId`, `sharedUrl`, `branchFrom*`,
`pendingPlanExecution`, `transferredSessionSummary*`, `connectionLocked`, `enabledSourceSlugs`,
`taskDraft`, `lastReadMessageId`, `lastFinalMessageId`, `preview`, `workingDirectory`,
`tokenUsage`.

**`fields` is validated against tier 2, and an unknown or tier-3 name is an error — never a
silent passthrough.** This is the whole security property. A `fields` implementation that picks
keys off the header by name is precisely the leak the allowlist exists to prevent:
`shareEditToken` is a declared persistent field (`types.ts:40`), unpopulated in this workspace
today, but a name-indexed projection would hand it to any agent that guessed the key the moment
a session is shared with an edit token. `preview` and `workingDirectory` are conversation and
filesystem content and stay in tier 3 on the same principle.

**Why shaping rather than one wider contract set.** This ADR originally proposed a flat 20-field
contract and held `archivedAt` and `kanbanColumn` back as reviewable. Jeff's answer — that both
are genuinely useful, and that the surface wants a shaping option — is the better resolution,
and it commits us to *less*, not more:

- The default payload stays small. Agent context is the scarce resource on this surface; a
  bulk listing that returns 20 fields per row when the caller wanted 3 burns it for nothing.
- We do not have to settle the contract-set argument now. Tier 2 is the set of things a caller
  *may ask for*, and widening it later is additive and cheap.
- The `archivedAt` / `kanbanColumn` question dissolves: both go in tier 2, cost nobody anything
  when unrequested, and are there when a consumer appears.

Honest limitation: `fields` does not abolish the contract question, it relocates it. Tier 2 is
still a commitment, and tier 3 is still a judgement call that has to be defended per field. What
changes is that the *default* stops being the place where that argument has to be won.

### 4. The safe archived default is scoped to the new surface, not applied globally

**Inside `where`, `isArchived` defaults to `false`. Outside it, nothing changes.**

- A call that passes `where` at all and omits `isArchived` excludes archived sessions. Callers
  wanting history pass `isArchived: true`, or `{ in: [true, false] }` for both.
- A call using only the legacy arguments — `status`, `label`, `search`, `limit`, `offset`,
  `sortBy` — or no arguments at all behaves **exactly as it does today**, archived rows
  included.

This ADR originally proposed flipping the default globally, and that was wrong. The flip is by
definition non-additive: it changes what an unchanged call returns. Its failure mode is also the
worst available one — a historical search ("find that session from June") returns an empty set,
and an empty set is indistinguishable from *no such session ever existed*. The caller is not
told they were filtered; they conclude the record is gone.

Scoping the default to `where` gets nearly all of the correctness win at zero compatibility
cost, because **`where` is new syntax — every caller that uses it is being written after this
decision lands**. New consumers get the safe default automatically. Existing consumers, known
and unknown, are untouched. No deprecation cycle is needed because nothing is deprecated.

The residual cost, stated plainly: a bare `list_sessions()` keeps a default that is wrong for
**92%** of the corpus (1,311 / 1,418) indefinitely. That is the price of strict additivity, and
it is the right price here — the mitigation is the tool description steering callers to `where`,
not a behaviour change nobody asked for. Revisit only if upstream's own contract moves (§6).

Neither live automation regresses: `session-archive-sweeper` no longer calls `list_sessions` at
all, and `vshare-reaper` **improves** once ported to `where` — its label query drops from 143
rows across two paginated calls to 1 row in one call, with the same final work list.

### 5. Filter before projecting, not after

`getSessions()` currently runs `Array.from(map.values()).map(managedToSession).sort()` on
**every** call, before any predicate is applied — full materialization and an O(n log n) sort
regardless of how selective the query is. The predicate evaluation must move ahead of
`managedToSession`, so a query matching 9 of 1,417 sessions materializes 9 records.

### 6. Wire compatibility: additive only, revisit if upstream moves

`list_sessions` is an agent-facing tool schema, and the realistic assumption is that it **is** a
compatibility surface in practice even where `roadmap/upstream/compatibility.md` does not name
it — silently, via any consumer we do not control.

Every part of this decision is therefore additive: `where`, `sortDir` and `fields` are new
optional arguments; `isArchived`/`isFlagged` are new keys on a response object, which existing
callers ignore; no existing argument changes meaning; no existing call changes its result. There
is no version bump and no parallel endpoint.

**A second, parallel query API is explicitly not built today.** If a future requirement genuinely
collides with the existing shape — a return type that cannot be reached additively, or an
upstream contract change — that is when a separate surface earns its place. Building one now to
pre-empt a collision that has not happened is complexity adopted speculatively. Revisit this
section if upstream changes the `list_sessions` contract; until then, YAGNI.

## Consequences

### Positive

- Rule 2d becomes enforceable for the first time. `isFlagged` is expressible, so "never archive
  a flagged session" stops being decorative.
- The ~100:1 redundant-write ratio collapses at the source rather than per-consumer.
- The on-disk header stops being a de-facto public API; tiers 1–2 become the thing automations
  depend on, and `SESSION_PERSISTENT_FIELDS` regains its freedom to change.
- Orchestration queries become expressible in one call: "unarchived children of task X, oldest
  first", "sessions this automation spawned that are still `needs-review`".
- The tier-3 allowlist closes a latent `shareEditToken` exposure before it can ever open.
- **Nothing breaks.** Every change is additive; no existing call returns a different result.
  There is no migration, no deprecation window, and no release note that begins "if you were
  relying on…".
- `fields` makes the default payload *smaller* than a fixed 20-field contract would, which
  matters because agent context is the scarce resource on a bulk-listing surface.

### Negative

- **The bare-call default stays wrong.** `list_sessions()` with no `where` keeps returning
  archived sessions — wrong for 92% of the corpus, indefinitely. Strict additivity buys
  compatibility by leaving the worst default in place, and the only mitigation is documentation,
  which has already failed once here.
- **Two ways to spell the same query.** `status` vs `where.status`, and now a legacy call path
  with different archived semantics from the `where` path. That divergence is a real
  comprehension cost and it is permanent. The mutual-exclusion error stops it becoming a
  precedence puzzle, but it cannot make the surface feel like one idea.
- Tier 2 is still a commitment — ~20 fields we cannot remove without an ADR. Better than the
  status quo, where 40+ are *accidentally* committed via the header, but not free.
- `fields` adds a validation path that is security-load-bearing. A lazy implementation that
  name-indexes the header is a leak, so this needs a test that tries to request a tier-3 field.
- More surface to test: absence-vs-`false` normalization, tier enforcement, and the
  `where`-scoped default each need their own cases.

### Neutral

- Watch for the first genuine `$or` consumer; that is the signal to extend, and not before.
- Watch whether the bare-call default becomes a live source of bugs. If it does, the flip
  becomes a separate, deliberate decision with its own ADR — not a rider on this one.
- Watch upstream's `list_sessions` contract; §6 is the trigger to revisit.
- The cost measurements below were taken via a Python proxy over the same corpus, not by
  instrumenting the TypeScript path. They establish orders of magnitude, not the constant.

### Cost model

Measured 2026-08-17 over the live 1,417-session workspace:

| Path | Measured | Extrapolated at 14,170 |
|---|---|---|
| In-memory 4-predicate filter over parsed headers | **0.038 ms** | ~0.38 ms |
| Disk header-line read + parse, all sessions | **38.8 ms** (27.3 µs/session) | ~390 ms |
| Whole-file read of every session | **1,066 ms** (~28× header-only) | ~10.7 s |

Filtering happens **in memory**, over a `Map` the host has already hydrated — there is no store
and no query planner, and none is warranted. Predicate evaluation is not the cost at either
scale; the per-call `map` + `sort` in `getSessions()` is, which is why decision §5 exists. At
10× the current corpus the in-memory filter remains sub-millisecond and the design holds
unchanged.

The whole-file row is the argument for a **header-line** read wherever disk is touched at all.
The `isArchived` marker currently appears in 1,313 header lines and **zero** message bodies, so
a whole-file grep is correct today only by accident of JSON escaping — one transcript quoting
the string would mark a live session archived forever.

### Interaction with ADR-0021

ADR-0021 gates **session-mutating** actions on declared intent at a single choke point. This
ADR governs a **read** surface, so it sits outside that gate by construction and contradicts
none of it — no mutation path changes, and the `set_session_status` unconditional refusal is
untouched.

The honest version of "a broader query surface is a broader read surface" is narrower than it
first sounds. The **row** set is already unrestricted: `list_sessions` returns every session in
the workspace today, archived and all, with no gating whatsoever. Predicates do not widen which
sessions an agent may read — they make targeting cheaper and, by excluding archived rows,
*narrow* the default.

What genuinely widens is the **column** set: six fields become twenty. That is the risk this
ADR actually carries, and §3 is the mitigation — an enumerated allowlist with secrets,
conversation content (`preview`) and filesystem paths (`workingDirectory`) held out by name.

One watch item, deliberately not built: ADR-0021's principle is that authority is a property of
the *declared caller*, not of the call site. Reads carry no origin today. If session-to-session
reads ever need to be restricted by caller class, the seam is the same choke point. Adding an
origin to reads now would be speculative — no consumer needs it, and the row set it would
protect is already fully open.

## Alternatives considered

- **Add an `archived: boolean` argument.** Fixes today's symptom, leaves the next orchestrator
  in the same position, and is exactly the "one more boolean" the commission ruled out. It also
  would not have caught rule 2d, which needs `isFlagged`.
- **Return the whole header and let callers filter.** Cheapest to build and the worst outcome:
  it makes the internal serialization a public contract permanently, ships `shareEditToken` to
  every agent, and moves the 1,417-row transfer cost into every caller's context window.
- **A real query DSL (nested boolean algebra, operators, projections).** No current consumer
  needs disjunction; both live automations are pure conjunctions. Speculative complexity, and
  the `$or` extension path stays open.
- **A SQLite index over sessions.** Solves a problem we do not have — filtering is 0.038 ms
  in memory and stays sub-millisecond at 10×. It would add a schema, a migration path, and a
  second source of truth for state the header already owns.
- **Flip the archived default globally** (this ADR's own first draft). Rejected: it is
  non-additive, and its failure mode is the worst available — a historical search returns an
  empty set, which is indistinguishable from "no such session exists". The `where`-scoped
  default in §4 captures nearly all the value at zero compatibility cost. If the bare-call
  default later proves to cause real bugs, that flip deserves its own ADR rather than riding
  along with this one.
- **Keep archived in the default set everywhere and just document the trap.** Rejected as the
  *only* measure: documentation has already been tried — both automations carry inline warnings,
  and the warnings exist *because* the trap was walked into twice. §4 keeps the legacy default
  for compatibility but does not rely on documentation to protect new code; the `where` path
  defaults safely on its own.
- **A fixed, wider contract set with no `fields` option.** This ADR's first draft, holding
  `archivedAt`/`kanbanColumn` back as reviewable. Rejected in favour of shaping: it forces the
  contract argument to be won at the default, commits us to more up front, and makes every
  caller pay context for fields it did not ask for.
- **A second, parallel query API** (`query_sessions` alongside `list_sessions`). Rejected today
  as speculative — the additive path has not collided with anything yet. §6 names the condition
  under which this becomes the right answer.
- **Leave the on-disk workarounds in place.** They are correct and fast today. But they pin two
  production automations to a serialization format with no compatibility guarantee, and the
  next `SESSION_PERSISTENT_FIELDS` change breaks them silently at 05:20.

## References

- PLAN-037 — the implementation plan for this decision.
- ADR-0021 — session actions gated by declared intent; the mutation-side precedent this read
  surface must not contradict.
- PLAN-031 — status invariants at the single choke point; adjacent session-state work, and the
  source of the "invariant asserted in three places, enforced in one" framing.
- `packages/server-core/src/sessions/SessionManager.ts:4412` — `listSessionsFn`; the six-field
  projection at `:4450` is the line this ADR exists to change.
- `packages/shared/src/sessions/types.ts:26` — `SESSION_PERSISTENT_FIELDS`, the candidate set.
- `packages/shared/src/sessions/storage.ts:355` — `listSessions()`, the header-line read.
- All measurements taken 2026-08-17 against `main` at `b3408db2`.
