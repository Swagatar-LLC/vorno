---
date: 2026-08-22
participants: product owner (directive) + agent (execution)
topic: PLAN-045 Pass 1 — mine every plan for value that outlives the plan
related-decisions: [ADR-0021, ADR-0013, ADR-0015, ADR-0016, ADR-0024, ADR-0025, ADR-0026]
related-directions: [DIR-05]
related-plans: [PLAN-045, PLAN-039, PLAN-040, PLAN-041, PLAN-042, PLAN-043, PLAN-044]
---

# PLAN-045 Pass 1 — mining report

> **Pass 1 only.** Nothing is deprecated here. PLAN-045's first ground rule is
> that mining strictly precedes deprecation and **no plan is archived in the
> same sitting it is mined**. This document ends with a deprecation *candidate*
> list for Pass 2 to act on; it moves no files.

## What this pass did

Swept **46 plans** — all 40 in `roadmap/plans/` across every status folder, plus
the 6 paused plans in the private corpus (`vorno-internal:plans/`) — for ideas
that outlive the plan carrying them. Every salvaged idea was **relocated into
the DIR-05-era plan it now belongs to**, under a `## Salvaged from prior plans
(PLAN-045 Pass 1)` heading, each with a back-pointer to its source. Six plans
received salvage: PLAN-039, PLAN-040, PLAN-041, PLAN-042, PLAN-043, PLAN-044.

### A note on folder state

This branch was cut from `main`, which does **not** carry the 2026-08-22 status
audit still open on PR #171. In this tree PLAN-023/024/025/035 sit in
`in-progress/` and PLAN-029/034 sit in `in-progress/` too. **The dispositions
below use the post-#171 folders as authoritative** (`blocked/` and `documented/`
respectively), because that is the state PLAN-045 was written to operate on.
Pass 2 must run after #171 merges, or on a branch rebased onto it.

## The three findings that changed the shape of the roadmap

**1. PLAN-043's D1 has already been built.** The review workbench (PLAN-024)
shipped the select-region → attach-feedback → dispatch-into-a-session loop, with
artifact path, quoted anchor, and thread id in the payload and replies linked
back. It is on `main` behind `workbenchEnabled`. D1 currently reads "dispatch
mechanism is a design choice inside the phase: deep-link, webhook, or CLI" —
that choice should start from the existing seam.

**2. PLAN-043's D2 corpus index may already exist.** The artifact plane
(PLAN-025) shipped in v0.13.0 behind `artifactsEnabled` with a zero-config
corpus scan, **frontmatter parsed into the index**, and **typed relations**
(`derived-from`, `references`, `renders`, `discussed-in`). D2's workstream view
is that relation model pointed at the roadmap corpus. Two plans currently
blocked on owner QA contain most of a third plan's scope.

**3. PLAN-039's central hazard already has a name in this repo.** PLAN-032
refused to accept a `ContextProfile.skills` field it could not honour, on the
grounds that *a silently ignored field is worse than no field*. PLAN-039's own
evidence is that the task schema parses `params`/`outputs`/`when`/`loop`/`retry`
and the editor exposes none of them — the same defect at schema scale. PLAN-037
supplies the field-level proof of what it costs: the `session-archive-sweeper`
carried a rule it could never once check and archived two flagged sessions.

## Salvaged ideas → destination

| # | Idea | Source | → Destination |
|---|---|---|---|
| 1 | A field accepted but not honoured is a defect, not a shortcut | PLAN-032 | PLAN-039 |
| 2 | A rule the API cannot express silently never runs (2 sessions lost) | PLAN-037 | PLAN-039 |
| 3 | Dispatched ≠ achieved; node success must be structurally observed | PLAN-030 (LEARNING-052) | PLAN-039, PLAN-044 |
| 4 | Drift guards proven by mutation; fail-closed defaults | PLAN-031 | PLAN-039 |
| 5 | No SDK percent/total-steps exists — do not fabricate progress | *private* PLAN-008/009 | PLAN-039, PLAN-040 |
| 6 | `SDKTaskProgressMessage` / `task_started` are received and dropped by `ClaudeEventAdapter` | *private* PLAN-008 | PLAN-039 |
| 7 | Item-renderer registry (`Map<itemKind, Renderer>`) as contribution seam | PLAN-007 | PLAN-039 |
| 8 | "Derive, don't re-plumb" — exhaust derived state before new wire fields | PLAN-007 | PLAN-039 |
| 9 | Graph layout persistence: time-axis first paint, sticky user drag sidecar | PLAN-001 | PLAN-039 |
| 10 | A typed run form may be an instance of the composed-surface spec | PLAN-026 | PLAN-039 |
| 11 | Pinned model ids go stale — definitions need bind-time resolution | *private* PLAN-010 | PLAN-039 |
| 12 | A token percentage is only as true as its denominator (`/v1/models` has no context window) | *private* PLAN-010 | PLAN-040 |
| 13 | `resolveThresholds()` precedence is the contract to preserve | PLAN-003 | PLAN-040 |
| 14 | Frontmatter is free query surface for a markdown memory substrate | PLAN-025 | PLAN-040 |
| 15 | The app-server (not the trigger server) is the hosted-workspace unit | PLAN-023 | PLAN-041 |
| 16 | Three trust zones: transport token / vault / per-source OAuth tokens | PLAN-023 (ADR-0013) | PLAN-041 |
| 17 | Portable vs host-bound state table; `~/.claude` pairs with `CONFIG_DIR` | PLAN-023 (ADR-0005) | PLAN-041 |
| 18 | Secrets never in runtime env vars; none inline in root config | PLAN-013, PLAN-029 (ADR-0019) | PLAN-041 |
| 19 | `apps/server` takes **no** lock; concurrent-writer semantics unvalidated | PLAN-013, PLAN-023 | PLAN-041 |
| 20 | `SessionPool` vs `SessionManager` convergence — open in three plans | PLAN-012, PLAN-013, PLAN-023 | PLAN-041 |
| 21 | Closure invariant is single-point *per host*, not globally | PLAN-031 | PLAN-041 |
| 22 | Client-owned vault key (zero-trust, shown once, lost = re-auth) | PLAN-023 | PLAN-041 |
| 23 | Registered-origin registry keyed on `instanceId`; no wildcards; one pairing ceremony | PLAN-036 (ADR-0025) | PLAN-041 |
| 24 | An endpoint constant addresses a service, never a resource | PLAN-035 (LEARNING-057) | PLAN-041 |
| 25 | `safeStorage` encryption of the WebUI password at rest — never landed | PLAN-020 | PLAN-041 |
| 26 | Security review before code on any trust boundary | PLAN-027 | PLAN-041 |
| 27 | git push/pull is the only sync fabric; provider-agnostic interface | PLAN-023 | PLAN-041 |
| 28 | Upgrade + backup/restore story for a hosted `CONFIG_DIR` | PLAN-023 | PLAN-041 |
| 29 | PLAN-013's two unclosed checkpoints (in-container LLM turn; SDK subprocess on bun/Linux) | PLAN-013 | PLAN-041 |
| 30 | One-command setup + QR connection URL; desktop "connect to your online Vorno?" | PLAN-023 | PLAN-041 |
| 31 | Field observability gaps: stdout-only, no OS log integration, no auth source-IP | PLAN-015, PLAN-033 | PLAN-041 |
| 32 | TLS options incl. unbuilt `tailscale cert` issuance | PLAN-005, PLAN-023 | PLAN-041 |
| 33 | `StatusChangeOrigin` is the existing authority model — thread into it | PLAN-031 (ADR-0021) | PLAN-042 |
| 34 | The single-user→multi-user seam is already drawn on paper | PLAN-023 | PLAN-042 |
| 35 | **The D1 question-loop already ships behind `workbenchEnabled`** | PLAN-024 | PLAN-043 |
| 36 | Anchoring: quote-anchor + contentHash/gitSha; badge stale, never re-anchor | PLAN-024 (ADR-0014) | PLAN-043 |
| 37 | **The D2 corpus index may already exist as `vorno:artifacts:*`** | PLAN-025 | PLAN-043 |
| 38 | Agent-minable by construction — plain files, no new tools | PLAN-024 | PLAN-043 |
| 39 | Cross-session roll-up as the shape of "what is the current workstream?" | PLAN-007 | PLAN-043 |
| 40 | The generator needs a journey test; a reintroduced bug must fail it | PLAN-028 | PLAN-043 |
| 41 | Generalize `retry-scheduler.ts` to a work-item union (already named) | PLAN-014 | PLAN-044 |
| 42 | `202` in ~100 ms decoupled from executor latency | PLAN-014 | PLAN-044 |
| 43 | Indistinguishable `404`s for bad token / unknown slug / unknown workspace | PLAN-014 | PLAN-044 |
| 44 | `deferred: host-unreachable` — deferral is not success | PLAN-014 | PLAN-044 |
| 45 | Loop guards + provenance on event-triggered actions | PLAN-030 | PLAN-044 |
| 46 | Privacy policy gates any public unauthenticated write endpoint | PLAN-035 (ADR-0024) | PLAN-044 |
| 47 | Adopt-don't-invent precedent (SEP-1865 lifted verbatim) → A2A | PLAN-027 | PLAN-044 |
| 48 | Session-action-only hooks don't appear in the parsed hook list | PLAN-014 | PLAN-044 |

## Full inventory and disposition

**Disposition key** — `mined` = value extracted, candidate for Pass 2 ·
`retain` = still live work, not a deprecation candidate · `shipped` = closed,
nothing left · `active` = in flight · `keep-as-is` = already archived.

### `planned/` (13)

| Plan | Disposition | Note |
|---|---|---|
| PLAN-026 composed surfaces (C2) | **mined** | Spec-over-block-catalog idea → PLAN-039. Blocked behind PLAN-025, which is itself blocked on owner QA. Pre-DIR-05. |
| PLAN-027 interactive surfaces / MCP Apps (C3) | **mined** | Adopt-don't-invent posture + security-review gate salvaged. Blocked behind PLAN-026 behind PLAN-025 — a three-deep chain with no live head. |
| PLAN-028 CI user-journey tests | **retain** | Unblocked, direction-less, and its premise is unchanged: journey bugs pass every unit suite. Re-home under DIR-05 rather than archive. |
| PLAN-032 session-sticky skills | **mined** | Its principle is now load-bearing in PLAN-039. The feature itself only matters if a definition should carry skills — decide there. |
| PLAN-036 OAuth relay (`auth.vorno.ai`) | **retain** | Implements accepted ADR-0025; gated on the privacy policy, not superseded. |
| PLAN-037 session query predicate | **retain** | Implements accepted ADR-0026; unblocked; has a live correctness motive (the sweeper's uncheckable rule). |
| PLAN-039 workflow definitions | **active (destination)** | Received 11 salvaged items. |
| PLAN-040 integrate Headroom | **active (destination)** | Received 4. |
| PLAN-041 server-homed instances | **active (destination)** | Received 18 — the largest single relocation; PLAN-023's architecture now has a home. |
| PLAN-042 team management | **active (destination)** | Received 2. |
| PLAN-043 roadmap console | **active (destination)** | Received 6, two of which change its scope. |
| PLAN-044 cross-system work requests | **active (destination)** | Received 8. |
| PLAN-045 roadmap reduction pass | **active** | This pass. |

### `in-progress/` (1, post-#171)

| Plan | Disposition | Note |
|---|---|---|
| PLAN-031 status invariants | **active — not mined** | Two genuine end-to-end regressions still open. Its *principles* were salvaged into PLAN-039/041/042; the plan itself stays. |

### `blocked/` (4, post-#171)

| Plan | Disposition | Note |
|---|---|---|
| PLAN-023 hosted workspace server | **mined** | Phase 0 architecture + ADR-0013 shipped and remain authoritative; Phases 1–3 never built and are now PLAN-041's material. Strongest deprecation candidate. |
| PLAN-024 review workbench | **mined** | Owner already recorded (2026-07-21/22) that the standalone workbench "is not the answer." Its question loop is now PLAN-043 D1's starting point. |
| PLAN-025 artifact plane | **mined** | **Shipped code, blocked plan.** Three runtime/Obsidian QA checks unverified. Deprecating the plan is not the same as retiring the surface — see the sign-off note below. |
| PLAN-035 hosted session shares | **mined** | Lanes 1–2 merged; the cutover PR was closed unmerged. Blocked on owner decisions (retention, privacy policy), not on engineering. |

### `documented/` (4, post-#171)

| Plan | Disposition |
|---|---|
| PLAN-029 storage provider surfaces | **shipped** — ADR-0019 forward constraint salvaged to PLAN-041 |
| PLAN-030 session lifecycle automation | **shipped** — three semantics salvaged to PLAN-039/044 |
| PLAN-033 hermetic config dir | **shipped** — auth-log source-IP gap salvaged to PLAN-041 |
| PLAN-034 public docs + changelog | **shipped** — nothing left; practices already live in the release skill |

### `done/` (16)

All shipped and closed. Unchecked boxes in these files are pre-merge checklists
left un-ticked as bookkeeping, not deferred work — verified per file. Residue
salvaged where it existed:

| Plan | Residue salvaged |
|---|---|
| PLAN-002 token usage display | → PLAN-040 (via PLAN-003's precedence contract) |
| PLAN-003 token thresholds | `resolveThresholds()` precedence → PLAN-040 |
| PLAN-005 tailscale launcher | deferred TLS / `tailscale cert` → PLAN-041 |
| PLAN-006 per-session fast mode | none |
| PLAN-011 keepalive toggle | none (its leak story closed via LEARNING-061 / PLAN-038) |
| PLAN-012 tray supervision | SessionPool↔SessionManager question → PLAN-041; Windows/Linux tray parity **superseded by proposed ADR-0027** |
| PLAN-013 server-only deployment | 4 items → PLAN-041 (locking, secrets, checkpoints, identity model) |
| PLAN-014 workspace webhooks | 5 items → PLAN-044 |
| PLAN-015 production logging | observability seams → PLAN-041 |
| PLAN-017 automation outcome records | none |
| PLAN-018 update feed + port-0 | none |
| PLAN-019 rebrand + signed release | none |
| PLAN-020 webui autostart | `safeStorage` at-rest encryption → PLAN-041 |
| PLAN-021 projects navigation | none (per-workspace project ordering: minor, dropped) |
| PLAN-022 webui remote access | none (pending real-device phone test: minor, dropped) |
| PLAN-038 idle runtime TTL | none |

### `archived/` (2)

| Plan | Disposition |
|---|---|
| PLAN-001 canvas spectator | **keep-as-is, mined** — layout-persistence idea → PLAN-039; the tldraw stack stays dead |
| PLAN-007 orchestration panel | **keep-as-is, mined** — 3 ideas → PLAN-039/043 |

### Private corpus — `vorno-internal:plans/` (6)

All six carry the 2026-07-08 "VORNO program paused / retained for research
only" marker or predate it. None returns to active status.

| Plan | Status | Disposition |
|---|---|---|
| PLAN-004 i18n coverage lint | done | **shipped** — gate lives in CI |
| PLAN-007 orchestration panel (dup) | in-progress | **duplicate** — a stale copy of the public archived file; Pass 2 should delete it, not archive it twice |
| PLAN-008 orchestration richer progress | planned | **mined — highest-value private find.** The dropped-SDK-signal investigation → PLAN-039 |
| PLAN-009 orchestration phase 1.5 | done | **shipped** — the don't-fake-what-you-don't-have discipline → PLAN-039/040 |
| PLAN-010 live model enumeration | in-progress | **mined + stale status.** PR #36 was green and awaiting merge in 2026-06; the file never advanced. Pass 2 should reconcile it against `main` before archiving. |
| PLAN-016 M2 integration verification | in-progress | **shipped in substance** — a completed VOR-45 verification record, mis-filed as in-progress |

### Discussions (2)

`2026-04-28-canvas-paradigm-directions.md` (public) and
`2026-07-09-webui-just-works-over-trigger-server.md` (private) — both are
captured thinking, never authoritative, and are not deprecation candidates.

## Deprecation candidates for Pass 2

Value has been extracted from each of these; none may be archived in this
sitting.

**Archive outright (roadmap files only — no shipped surface affected):**

1. **PLAN-026** — composed surfaces (C2). Pre-DIR-05, blocked behind a blocked plan.
2. **PLAN-027** — interactive surfaces (C3). Blocked behind PLAN-026; the MCP-Apps-host ambition is a direction, not a queued plan.
3. **PLAN-023** — hosted workspace server. Phase 0 shipped; Phases 1–3 are now PLAN-041's material verbatim.
4. **PLAN-024** — review workbench. The owner already recorded the strategic verdict; its loop now lives in PLAN-043.
5. **PLAN-032** — session-sticky skills. Fold the remaining feature question into PLAN-039 W1 or drop it.
6. **`vorno-internal:plans/PLAN-007`** — delete the duplicate rather than archive it.
7. **`vorno-internal:plans/PLAN-016`** — a completed verification record filed as in-progress; move to done/archived.

**Reconcile before deciding:**

8. **`vorno-internal:plans/PLAN-010`** — check PR #36 against `main`; if merged, close as done rather than archive as abandoned.
9. **PLAN-028** — CI journey tests. Recommend **retain and re-home under DIR-05** (PLAN-043's generator needs exactly this), not archive.

**Requires a product-owner sign-off line before anything is touched — these retire *shipped surface*, not just plans:**

10. **PLAN-025 / the artifact plane.** Code, seven `vorno:artifacts:*` channels, Artifact Home, and 78 tests are on `main` behind `artifactsEnabled`. Archiving the plan is a bookkeeping act; **retiring the surface is not**, and PLAN-043 may be about to become its first real consumer. Recommend: archive the plan, keep the surface, and let PLAN-043 D2 decide its fate.
11. **PLAN-024 / the review workbench surface.** Same shape — code behind `workbenchEnabled`. Its disposition has been an open owner decision since 2026-07-24. PLAN-043 D1 forces the question.
12. **PLAN-035 / session shares.** The merged back-compat fix is shipped and load-bearing; only the cutover is unfinished. Not a candidate for archival — it is a candidate for the owner's retention and privacy-policy decisions.

## Scope item carried into Pass 2

Per the PLAN-045 brief, this pass was also asked to feed the **PLAN-023 /
PLAN-024 scope disposition** — a requirement that is *not* in the plan file's
own acceptance criteria. Pass 1's answer:

- **PLAN-023** — split, not shipped. Phase 0 (architecture doc + ADR-0013,
  accepted with conditions) is complete and remains authoritative. Phases 1–3
  are now carried by PLAN-041, with PLAN-036 holding the OAuth-relay slice.
  Recommend archiving PLAN-023 with a status-log line pointing at both.
- **PLAN-024** — superseded by owner verdict, with live code. The plan is
  archivable; the *surface* is a sign-off item (candidate 11).

Neither should be closed as "done."

## Ground rules honoured

- Mining preceded deprecation; **nothing was archived, moved, or deleted.**
- Every salvaged idea landed in a current plan with a back-pointer, rather than
  being left in place.
- Deprecations touching shipped surface are **listed for sign-off, not acted on**
  (candidates 10–12).
- Bounded event: one report, one sitting.

---

# PLAN-045 Pass 2 — deprecation record

> Appended 2026-08-22, a separate sitting from Pass 1 above, per PLAN-045's
> ground rule that no plan is archived in the same sitting it is mined.
> **Five files moved or deleted, four dispositions corrected, three plans held
> for product-owner sign-off.**

## Plans archived (4 public)

Each was `git mv`'d to `roadmap/plans/archived/`, had `status:` set to
`archived`, and carries a one-line reason in its own status log.

| Plan | From | Reason |
|---|---|---|
| **PLAN-023** hosted workspace server | `in-progress/` | Split, not shipped. Phase 0 (architecture doc + ADR-0013) is complete and **remains authoritative — archiving does not retract it**. Unbuilt Phases 1–3 are now carried verbatim by PLAN-041, with PLAN-036 holding the OAuth-relay slice. Not closed as "done". |
| **PLAN-026** composed surfaces (C2) | `planned/` | Pre-DIR-05 and blocked behind PLAN-025, which is itself blocked on owner QA — a queued plan with no live head. Its one durable idea (typed run form as an instance of the composed-surface spec) went to PLAN-039. |
| **PLAN-027** interactive surfaces (C3) | `planned/` | Third link of a three-deep blocked chain (C3 → C2 → C1) with no live head. Both ideas salvaged: adopt-don't-invent (SEP-1865) → PLAN-044; security-review-before-code on trust boundaries → PLAN-041. |
| **PLAN-032** session-sticky skills | `planned/` | Its principle — *a field accepted but not honoured is a defect* — is now load-bearing in PLAN-039, where it names the central hazard. The residual feature question belongs to PLAN-039 W1. Built nothing; no surface affected. |

## Private corpus (`vorno-internal:plans/`)

The private `plans/` directory is **flat** — it has no status subfolders — so
dispositions there are frontmatter and status-log changes, not folder moves. No
`archived/` folder was invented for a three-file outcome.

| Plan | Action | Reason |
|---|---|---|
| **PLAN-007** (dup) | **deleted** | Verified a strict stale subset of the public `archived/PLAN-007-orchestration-activity-panel-done.md`: byte-identical except an older `status:`/`updated:`, and the public file additionally carries the archive banner and one further status-log line. Nothing was unique to it, so it was deleted rather than archived twice. |
| **PLAN-010** live model enumeration | **corrected → `done`** | See below — the one disposition Pass 1 got wrong. |
| **PLAN-016** M2 integration verification | **→ `done`** | A completed VOR-45 verification record left filed as `in-progress`; every packaged smoke item passed and its findings are independently filed as LEARNING-015/018. Status drift, not open work. |

### The correction: PLAN-010 shipped

Pass 1 listed PLAN-010 as "mined + stale status" and asked Pass 2 to reconcile
PR #36 before archiving it as abandoned. **It merged.** PR #36 landed on `main`
as `4f7572d5` on **2026-06-25**, shipping the live OpenAI `/v1/models` fetcher,
`inferAnthropicContextWindow`, and the `isLiveFetchPiConnection` generalization.
Merge commit verified present on `main`.

The file said otherwise because the corpus-wide banner — *"Archived 2026-07-08 —
superseded by upstream v0.11.0…; VORNO program paused. Retained for research
only"* — was swept across every private plan **two weeks after this one merged**,
overwriting a shipped plan with an abandonment notice. Had Pass 2 acted on Pass
1's disposition without checking, a shipped feature would have been recorded as
abandoned research.

**Standing lesson: a blanket status marker applied across a corpus is evidence
about the sweep, not about the file.** Anything carrying one needs its own
check before its status is trusted.

## Held for product-owner sign-off — nothing touched

These retire *shipped surface*, not just plans. None was moved, and no code was
touched.

1. **PLAN-025 / the artifact plane.** Code, seven `vorno:artifacts:*` channels, Artifact Home, and 78 tests are on `main` behind `artifactsEnabled`. PLAN-043's D2 may be about to become its first real consumer. Recommendation unchanged: archive the plan, keep the surface, let D2 decide — but that is a sign-off, not a sweep.
2. **PLAN-024 / the review workbench.** **Pass 2 reversed Pass 1 here.** Pass 1 listed PLAN-024 under "archive outright" on the reasoning that the owner's 2026-07-21/22 strategic verdict had settled it. It had not: the plan's own `2026-07-24` status-log entry carries an explicit standing instruction — *"do not close or move this plan unilaterally"* — and a mining pass is precisely the unilateral sweep that instruction exists to stop. The store, annotation, and anchor layers are live on `main` behind `workbenchEnabled`, so moving the file would read as settling a disposition that is still open. Held, with the reversal recorded in the plan's status log.
3. **PLAN-035 / session shares.** Not an archival candidate at all. The merged back-compat fix is shipped and load-bearing; only the cutover is unfinished, and it is blocked on two owner decisions (retention period, privacy policy) rather than on engineering.

## Retained, not archived

- **PLAN-028** CI user-journey tests — considered and declined. Unblocked, and its premise is unchanged: journey bugs pass every unit suite. It now has a concrete consumer in PLAN-043's `task.yaml` generator, whose output is load-bearing. **Re-homed: `direction:` changed from `null` to `DIR-05`.**
- **PLAN-031** status invariants — two genuine end-to-end regressions still open; principles salvaged, plan stays active.
- **PLAN-036**, **PLAN-037** — implement accepted ADRs (0025, 0026); gated on owner decisions, not superseded.

## Index updates

- `ROADMAP.md` — hosted workspace server now tracked as PLAN-041, with PLAN-023's Phase 0 and ADR-0013 noted as still authoritative.
- `roadmap/directions/03-observatory.md` — PLAN-023 delisted with a pointer to PLAN-041.
- `roadmap/directions/04-dynamic-workspaces.md` — PLAN-026/027 delisted; C2/C3 marked *(archived)* in the ladder table, with the ambitions retained as direction text.
- `roadmap/directions/05-workflows-and-headroom.md` — PLAN-041's "builds on PLAN-023, in progress" corrected to reflect the relocation and archival.

## Carry for whoever merges this

This branch was cut from `main` and does **not** carry PR #171's status-audit
folder moves. PLAN-023 was archived here from `in-progress/`, while #171 moves it
to `blocked/`. **That is a rename/rename conflict on merge — resolve in favour of
`roadmap/plans/archived/`,** which is the later decision. PLAN-024/025/035 are
untouched here, so #171's moves for them apply cleanly.

PLAN-045's own folder was deliberately left alone for the same reason: #171 moves
it `planned/` → `in-progress/`, and duplicating that move would add a second
avoidable conflict. Moving it to `done/` is a follow-up once #171 lands.
