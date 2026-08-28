# SUVs

A **Shippable Unit of Value** — the story-sized record between a plan and an
executable task. The folder an SUV lives in *is* its status.

Introduced by [ADR-0028](../decisions/0028-suv-as-the-shippable-unit-between-plan-and-task.md).

## Plan vs SUV

A **plan is a feature**. PLAN-043 spans a workstream view, a feedback loop, a
task composer, and a publisher — a body of work, not a change.

An **SUV is what one PR closes**. It has exactly one owning plan, an acceptance
list you can tick by reading a diff, and at most one task definition. If you
cannot state the goal in a sentence, it is two SUVs.

The point of the level is that a decomposing agent gets a scope boundary it
cannot invent its way around. An agent asked to advance a plan works at SUV
granularity — see the ADR's Context for the failure that motivated this.

## Folders

| Folder | Meaning |
|--------|---------|
| `planned/` | Drafted, not yet started. Anyone can pull one to start. |
| `in-progress/` | Actively being worked on. |
| `blocked/` | Waiting on external dependency or decision. Must fill `blocked-by`. |
| `done/` | Code landed, docs or release notes still pending. |
| `documented/` | Fully shipped — merged, docs updated, release-noted. |
| `archived/` | Abandoned without shipping. Kept for history. |
| `definitions/` | `SUV-NNNN.task.yaml` task definitions. **Status-independent** — flat, never moved. |

`documented/` reads oddly for a story-sized unit. It is kept anyway so that SUVs
and plans share one status set, one transition graph, and one advance skill.

## Lifecycle

```
planned ──▶ in-progress ──▶ done ──▶ documented
                │
                ├──▶ blocked ──▶ in-progress (when unblocked)
                │
                └──▶ archived (abandoned from any pre-done state)
```

Identical to the plan graph, verbatim. An SUV **must** start in `planned/`. To
advance:

```
[skill:roadmap-plan-advance] SUV-0001 in-progress
```

The skill performs `git mv` between folders and rewrites the frontmatter
`status` field so the two are always consistent.

## File naming

`SUV-NNNN-short-kebab-title.md` — **four**-digit zero-padded ID (plans use
three; the widths differ on purpose so an ID is unambiguous on sight), then a
kebab-case slug.

Find the floor — **across every ref and every reservation, never from the
working tree**:

```bash
git fetch origin --prune --quiet
{ git log --all --pretty=format: --name-only -- roadmap/suvs \
    | grep -o 'SUV-[0-9]\{4\}'
  git ls-remote origin 'refs/suv-ids/*' | grep -o 'SUV-[0-9]\{4\}'
} | sort -u | tail -1
```

A glob over `roadmap/suvs/` sees only what is committed on the branch you happen
to be standing on. On 2026-08-27 a worktree cut from `origin/main` saw a maximum
of `SUV-0022` while the real maximum was `SUV-0036` — `SUV-0034`–`0036` were
sitting on `plan/plan-039`, and `SUV-0023` had already shipped on
`plan/plan-040`. That is how two breakdowns both minted `SUV-0014`.

**An ID that has ever existed anywhere a ref can reach is claimed** — including
one that was later renumbered away, because reusing it makes git history
ambiguous exactly when someone is reading it to untangle a collision. Gaps in
the sequence are normal and expected.

There is no `--diff-filter=A` in that command on purpose: git reports a renumber
as a *rename*, so filtering on adds misses every id that entered the corpus by
being renamed into — which is exactly how SUV-0033 came to exist. See
[ADR-0030](../decisions/0030-suv-identity-is-global-per-plan-coherence-is-derived.md).

**Reading the floor is not allocating.** Two breakdowns that both read before
either writes still mint the same id — that is what produced the two
`SUV-0014`s, and a wider read does not fix it. Before writing the file, publish
the claim on the remote, which is the only serialization point concurrent
workflows share:

```bash
id=SUV-0040
tree=$(git hash-object -t tree -w /dev/null)
claim=$(printf 'reserve %s nonce=%s\n' "$id" "$(uuidgen)" | git commit-tree "$tree")
git push --atomic origin "${claim}:refs/suv-ids/${id}"
```

Creating a ref that already exists is a non-fast-forward, so the second claimant
is **rejected** rather than silently duplicated. On rejection, re-derive the
floor and claim the next id — never force. Claim commits are parentless and
carry a random nonce so two agents can never produce the same object (an
identical object would push as `Everything up-to-date`, exit `0`, and let both
believe they won). Reserving several ids at once? One `git push --atomic` with
every refspec, so the block is claimed whole or not at all.

Reservation refs are never deleted and need no cleanup — an abandoned claim is
just a gap, and gaps are already normal. Full procedure in
[`roadmap-suv-create`](../../.agents/skills/roadmap-suv-create/SKILL.md).

## Frontmatter

Every SUV starts with:

```yaml
---
id: SUV-0001
title: Put the roadmap console under version control
status: planned          # MUST match folder
plan: PLAN-043           # REQUIRED — exactly one owning plan
direction: DIR-05        # inherited from the plan
owner: jh
created: 2026-08-23
updated: 2026-08-23
related: []
blocked-by: []           # only used when status == blocked
---
```

See [`_template.md`](_template.md) for the full structure.

### The ownership edge

`plan:` is required and singular. The owning plan carries the reverse edge in
its `related-suvs:` list. Both sides are maintained — `[skill:roadmap-suv-create]`
writes them together.

SUVs are related to their plan, **not nested under it**. Plan files move between
status folders; nesting would drag every child along on every parent transition,
turning one `git mv` into a subtree rewrite.

## Body sections

- `## Goal` — the one-sentence outcome one PR delivers
- `## Scope` — what's in, and what a reader would wrongly assume in
- `## Acceptance` — checkable claims; ticking them all is what makes it `done`
- `## Status log` — append-only, one entry per transition

Keep it short. An SUV that reads like a plan is scoped like a plan.

## Task definitions

An SUV may carry at most one task definition:

```
roadmap/suvs/definitions/SUV-NNNN.task.yaml
```

Flat and status-independent — the definition never moves when the SUV advances.
It is versioned in git, reviewable in the PR that introduces it, and diffable
across revisions.

**Definitions are machine-neutral.** No cwd, no project ids, no model routes.
Those are supplied at publish time.

Publishing copies the definition to `{workspaceRoot}/tasks/<slug>/task.yaml`,
which `packages/shared/src/tasks/storage.ts` already scans. The repo file is the
authoritative **definition**; the workspace copy is a disposable **instance**.
Run state (`runs/<runId>/`) stays in the workspace and never returns to the
repo. Drift is resolved by re-publishing, never by copying back.

## When to write an SUV

- Whenever a plan is being decomposed for execution.
- Before starting work on a plan phase — the SUV is the scope contract.

Not every plan needs SUVs up front; write them when the plan reaches
`in-progress` and someone needs to know what "the next PR" means.
