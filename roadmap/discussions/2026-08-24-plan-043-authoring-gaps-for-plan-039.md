---
date: 2026-08-24
participants: product owner (directive) + agent (execution)
topic: Every gap hit authoring, publishing and running a task definition by hand during PLAN-043 — written input to PLAN-039 W1
related-decisions: [ADR-0028]
related-directions: [DIR-05]
related-plans: [PLAN-043, PLAN-039]
related-suvs: [SUV-0005, SUV-0006, SUV-0007, SUV-0008, SUV-0009, SUV-0010, SUV-0011, SUV-0012]
---

# Authoring gaps for PLAN-039 W1 — what PLAN-043 hit by hand

> **Evidence, not design.** SUV-0012's non-scope is explicit: this document
> supplies the material PLAN-039 W1 has to answer to, and proposes no definition
> model of its own. Every entry names the concrete artifact that produced it, so
> a reader can re-run the observation rather than take it on trust.

## How this was collected

PLAN-043 built the authoring path bottom-up and then used it for real:

- **SUV-0005 / SUV-0006** — headless dispatch and per-run worktree isolation.
- **SUV-0007 / SUV-0008** — the corpus validator as a termination predicate, and
  the P3 reconciliation loop built as a hand-wired DAG in Python.
- **SUV-0009 / SUV-0010 / SUV-0011** — the console's incremental `task.yaml`
  composer, validation through the repo's own `validateTaskInput`, and publish
  into a live Vorno workspace.
- **SUV-0012** — the finale, and the first honest customer of all of the above:
  the P3 loop re-expressed as a real definition
  (`roadmap/suvs/definitions/SUV-0012.task.yaml`), published, and run unattended
  end to end, twice more under deliberate sabotage.

Findings from the earlier SUVs were accumulated in a working draft; the SUV-0012
run findings are new here. Both are merged below and grouped by the layer they
belong to, because that is the grouping W1 has to act on.

## The three that would change W1's shape

**1. Verification is a prompt, not a structure.** A DAG node whose whole job is
to fail the run has no structural way to do it. `adversarial-verify` exits
`done` whether it concludes PASS or FAIL — a session node's state is process
outcome, not content. The only thing that can fail a run is the orchestrator's
verdict, which is a *session graded against a prose rubric*. So the rubric had
to contain the sentence "read `adversarial-verify`'s VERDICT line and do not
overrule it". `kind: verify` and `kind: judge` parse (`schema.ts` NODE_KINDS) and
do not execute. Artifact:
`roadmap/suvs/definitions/SUV-0012.task.yaml` §`acceptance_criteria`.

**2. The repair channel can defeat the thing it is repairing.** On a FAIL
verdict, `repairForVerdict` (`TaskRunner.ts`) resets the named frontier and
prefixes each re-dispatched prompt with *the verifier's reason*. In sabotage
run A that reason was "survey fabricated SUV-0014/SUV-0015 and counted 15
against a real 13-SUV corpus" — which is the answer. The sabotaged node, whose
prompt still ordered it to emit the fabricated list, replied *"I can't reproduce
the supplied survey: it is the exact artifact that failed verification"* and
produced the correct one. The run then passed. A repair-enabled run therefore
cannot be used to test whether a node is honest: the grader tells the cheat what
it got caught on. Artifact: run `run-1787622661840`, `nodes/survey.json`,
run-log `verdict`→`node-retry`→`verdict` sequence.

**3. There are three scopes and only two exist.** ADR-0028 splits
machine-neutral *definition* from machine-local *instance*, and that split is
right. But SUV-0012 needed a **run-local** value — a disposable git worktree as
`cwd`, so read-only nodes could not touch the live checkout. There is nowhere to
put it: `cwd` is one task-level field, publish takes no per-publish parameters,
and republishing (the ADR's own drift resolver) overwrites it. See
[Publish and the instance split](#publish-and-the-instance-split).

---

## Schema and validation

**S1 — Unknown fields are accepted silently.** `validateTaskInput` on a node
carrying `bogus_field: nope` returns `{"valid": true, "errors": [], "warnings":
[]}`; Zod non-strict objects strip unknown keys. A hand author who types
`depends-on:` instead of `depends_on:` gets a green validation and a silently
wrong DAG. Strictness should be a property of the schema, not something each
consumer re-derives. Artifact: `/tmp/probe-task.yaml` vs `/tmp/suv0010-probe.ts`
(SUV-0010 orchestrator probe, bun 1.3.8).

**S2 — Unknown-key detection cannot come from Zod at all**, so SUV-0010's
console bridge introspects the live `TaskSpecSchema.shape` at runtime to name
them. That is a consumer working around a schema property. Artifact:
`~/.craft-agent/serve/apps/vorno-roadmap/validate_bridge.ts`.

**S3 — Two spellings of "where" in one error list.** Zod issue paths use the
array index (`nodes.1.prompt`); `validateTaskSpec`'s graph pass uses the node id
(`nodes.ship.depends_on`). Mapping index→id needs the raw document, so it has to
live beside the validator rather than in each consumer. Artifact:
`packages/shared/src/tasks/validate.ts`.

**S4 — The two validation layers are strictly sequential.** One Zod shape error
hides every graph error (dangling deps, cycles, unresolved refs) until it is
fixed. Hand authors get error *waves*, not an error list.

**S5 — `ValidationIssue.file` is hardcoded to `'task.yaml'`** regardless of the
real filename, so it cannot be used as a path. Artifact:
`packages/shared/src/tasks/storage.ts` (`TASK_FILE` constant threaded into every
issue).

**S6 — A model warning fires on four node paths for a field no node has.**
`tasks:get` on the published SUV-0012 instance returned four warnings at
`nodes.survey.model`, `nodes.validate.model`, `nodes.reconcile-report.model`,
`nodes.adversarial-verify.model` — *"Model \"claude-opus-5\" is not a known
built-in model"* — for a spec where the model is declared exactly once, at
`defaults.model`. The warning names a field the author cannot find in their
document, four times. Artifact: run 1 driver log, `tasks:get validation`.

**S8 — S1, hit for real.** During the run-4 sabotage a hand-edit of the published
instance dropped `depends_on` from `reconcile-report`. `parseTaskYaml` accepted
it, `tasks:run` accepted it, and the runner dispatched the node in parallel with
the two nodes it exists to consume — producing a different DAG with no signal at
any layer. Predicted by S1 from a synthetic probe in SUV-0010; observed on a live
instance the same day. Artifact: run `run-1787623257391` run-log, three
`node-scheduled` entries at `t+0`.

**S7 — Model validity is checked against the static registry, not the resolved
connection.** `claude-opus-5` is genuinely served by this machine's `claude-max`
connection (it is in `llmConnections[].models`), and every node routed through it
successfully in all three runs. The fork's `models.ts` registry does not list it,
so publish emitted `publishNotes: ["Model \"claude-opus-5\" is not a known
built-in model"]` and validation warned four more times per run. A definition
that pins a model needs a resolution story at bind time — which PLAN-039 already
carries as an open question — but the *warning* is currently unactionable noise
on a working route.

## Dispatch and environment

**D1 — Headless runs share the live `config.json` unless you build a profile.**
`vorno-cli run --workspace-dir` calls `workspaces:create`, which writes
`CRAFT_CONFIG_DIR/config.json` — by default the same file the running desktop app
writes. A fresh config dir has no `llmConnections`, and `resolveApiKey` then
demands an env API key even though the machine has a working OAuth connection.
There is no first-class headless-runner profile. Artifact: SUV-0005; the
workaround is `~/.craft-agent-roadmap-runner/` — mirrored `config.json` plus a
symlinked `credentials.enc`.

**D2 — Two vaults, one OAuth grant, is a real hazard.** `performTokenRefresh`
(`auth/state.ts:111-133`) writes rotated tokens only into the refreshing vault;
the stale one can hit `invalid_grant` and trigger the destructive
clear-and-re-login branch (`state.ts:142-175`). The symlink dodges it here; the
product has no answer. `~/.claude/` (the SDK's native-resume store) is global and
unaffected (`config-dir-migration.ts:143-151`).

**D3 — The run environment is load-bearing and undeclared.** Three env facts had
to be supplied by the launcher, none of them expressible in a definition:

- `PATH` must contain `/usr/sbin`. Without it `ioreg` is unfindable, the vault
  key derives from a fallback, and the product **deletes the vault as corrupt** —
  data-destroying and quiet. (LEARNING-065; this was originally misdiagnosed as
  an expired OAuth entry.)
- `CRAFT_APP_ROOT` must be the product checkout, because that is where the SDK's
  native binary is found (`runtime/platform-headless.ts:49`).
- `CLAUDECODE` must be stripped, or the SDK's nesting guard rejects the child.

Artifact: `apps/cli/src/server-spawner.ts` strips `CLAUDECODE` for exactly this
reason; the other two are hand-set in the console's dispatch env and in
SUV-0012's run driver. A definition should be able to state an environment
contract.

**D4 — "Working directory" is three different things and the model has one
field.** SUV-0012 needed the *nodes* to run in a disposable worktree
(`~/.craft-agent-roadmap-runner/worktrees/suv-0012-run`) and the *SDK* to resolve
its binary out of the product checkout (`~/dev/craft-agents-oss`). Only the first
is expressible (`cwd:`); the second had to be an env var on the server process.
SUV-0006 hit the same shape from the CLI side: `--workspace-dir` is the workspace
root, app root is inferred from cwd, and the agent working directory has no flag
at all — reachable only by patching `defaults.workingDirectory` into a
pre-existing workspace config.

**D5 — Concurrency is gated by config dir, sharing is gated by workspace root,
and they are not the same unit.** `.server.lock` is scoped to
`CRAFT_CONFIG_DIR`, so N parallel nodes need N config dirs with mirrored config
and symlinked vaults (SUV-0006). But SUV-0012's runner and the running desktop
app were both pointed at `~/.craft-agent/workspaces/my-workspace` and wrote it
concurrently — sessions, `events.jsonl`, `tasks/<slug>/runs/` — with nothing
detecting it. Isolation and sharing are orthogonal today and neither is
task-shaped.

**D6 — `sessions:delete` on CLI exit destroys the only record of where the agent
worked.** A run result should carry its effective working directory. (SUV-0006.)

**D7 — A runner's sessions are unreachable by construction, and the runner
deleted them anyway** *(added 2026-08-25, SUV-0021 — extends D6)*. The desktop
app's discovery is one unbranched chain from a config dir frozen at module eval
to a session list: `CRAFT_CONFIG_DIR` (`packages/shared/src/config/paths.ts:27`)
→ `config.json`'s workspace list (`config/storage.ts:106,276,733`) →
`readdir(<rootPath>/sessions)` at boot
(`server-core/src/sessions/SessionManager.ts:2021-2029`). No product code
enumerates a second config root, and the watcher path *drops* session ids it
did not hydrate at boot (`SessionManager.ts:1737-1739`) — so even a workspace
the app already watches only lists an externally written session after a
restart. On top of that, `vorno-cli run` deletes its own session on exit unless
`--no-cleanup` (`apps/cli/src/index.ts:643`), which the console did not pass:
both completed live runs left `runs/<id>/workspace/sessions/` empty — D6,
observed in practice. The console-side repair (SUV-0021) is deliberate
inspection, not live visibility: dispatch passes `--no-cleanup`, and a finished
run's session is copied into one stable archive workspace the owner registers
in the app once, listed on the app's next launch. **The residual is a product
question for W1/W3**: a run view that click-throughs to its sessions (W3)
presumes a session written by another process is reachable — the smallest
honest change is adopting unknown session ids in watched workspaces plus a
`sessions:rescan` RPC; the general form (inspecting sessions homed on another
instance) is PLAN-041's `RemoteServerConfig` shape, and multi-config-dir
awareness should be ruled out there (it re-imports D2 and fights the frozen
config-dir contract).

## Composer and authoring

**C1 — The composer wrote a definition it then refused to rewrite.** This killed
the first compose attempt of SUV-0012 outright. `taskdef.rewritable()` marks a
file hand-annotated if any line after the leading comment block starts with `#`
— and a `prompt: |` block scalar containing markdown headings does exactly that.
The composer's own writer (`_emit_kv`) will happily emit such a block. Result:
`POST /api/task/def/node` succeeded for three nodes, then returned

```
HTTP 409 — SUV-0012.task.yaml carries comments the composer would drop on a
rewrite. It is read-only here; edit it by hand.
```

with the file half-built on disk. Reproduced deterministically: the offending
lines were `## Survey`, `## Validator`, `## Cross-check`, `## Verdict` at file
lines 90/93/97/102. The fix was to delete the file and re-author every prompt to
avoid `#` at the start of any line — the shipped definition says *"a markdown
heading marker must NOT be used"* inside two of its prompts for this reason
alone. **A prompt is prose; prose contains `#`.** Any authoring surface that
round-trips YAML will hit this. Artifacts:
`~/.craft-agent/serve/apps/vorno-roadmap/taskdef.py` (`rewritable`,
`leading_comments`), `roadmap/suvs/definitions/SUV-0012.task.yaml` nodes
`reconcile-report` / `adversarial-verify`.

**C2 — Machine-neutrality is enforced on five keys and nowhere else.**
`_reject_machine_local` refuses `cwd`, `project`, `model`, `llmConnection`,
`permissionMode`, `defaults` at the door — a genuinely good property. But prompts
are unchecked free text, and SUV-0012's definition embeds the absolute path
`/Users/jeffhampton/.craft-agent/serve/apps/vorno-roadmap/validator.py` **twice**,
in `validate` and in `adversarial-verify`. The definition is machine-local and
nothing in the system says so. Structural neutrality on the fields, none on the
content the fields carry.

**C3 — The composer's task-level vocabulary is four fields.** `id`, `title`,
`goal`, `acceptance_criteria`. Not expressible at all: `params`, `outputs`,
`sources`, `skills`, `token_budget`, `max_parallel`, `runner`, and
**`max_iterations`**. The last one is not machine-local and it is not cosmetic —
it decides whether a FAIL verdict is terminal or triggers a repair loop, which is
the difference between the two sabotage runs below. Node-level, the composer
offers `id`/`title`/`prompt`/`depends_on`/`inputs`; `kind`, `model`, `timeout`,
`retry`, `when`, `loop`, `replicas`, `labels` are unreachable. The authored
corpus is once again the editor's expressive ceiling — the same finding PLAN-039's
own evidence section makes about the Vorno task editor, now reproduced in a
second authoring tool built from scratch.

**C4 — There is no way to declare a node read-only.** All four SUV-0012 nodes
open with the same hand-copied paragraph — *"READ-ONLY NODE. Do not create, edit,
move or delete any file…"* — while actually running under
`permissionMode: allow-all` inherited from the workspace default. The only real
protection was the disposable worktree. This restates SUV-0008's finding with a
fresh artifact: every guarantee that held in the P3 loop (worktree isolation,
no-commit, manifest excluded from the diff) held because Python enforced it, not
because a prompt asked. Definitions should be able to declare
`workspace: git-worktree(...)` and artifact paths and get isolation for free.

**C5 — Every operation writes the file, and there is no way to unwrite one.**
The composer's no-draft-state rule is right, but its consequence is that a failed
multi-step compose leaves a half-built definition on disk. The API has
`node/delete` but no definition-delete; recovering from C1 meant `rm` outside the
API entirely.

**C6 — What the P3 loop needed and `task.yaml` still cannot say** (SUV-0008,
built by hand as five nodes with a loop-until edge:
`dispatch(n) → commit → validate → evaluate → [reconciled → gate | escalated →
gate | incomplete ∧ n<bound → carry → dispatch(n+1)]`):

1. **Loop-until with a predicate over a sibling node's output** — not
   retry-on-failure. The agent node exits 0 every time; the condition is a
   conjunction over the validator's `ok` and a JSON artifact the agent wrote.
2. **Per-iteration context carry** — iteration N+1's prompt is a function of
   iteration N's output and the iteration index, not of the definition.
3. **A declared side-effect boundary the runtime enforces** (see C4).
4. **Structured-output contracts cross-checked against observable reality** — a
   manifest the node must emit, checked against the actual git diff, is what
   makes "did the model do what it claims" decidable. This is the concrete form
   of the adversarial-verification requirement.
5. **Terminal states beyond pass/fail, and human gates as nodes** —
   reconciled / unreconciled / escalated are three different nexts; two of them
   stop at a person. `escalate` needs to be a first-class terminal edge carrying
   reasoning.

Smaller, from the same build: bounds must be runtime-overridable (`bound=0`,
"one run, no verdict", is what kept 90 pre-existing tests honest — a definition
hard-coding 3 is untestable), and an N-process iteration transcript must be one
logical stream the runtime owns (offset arithmetic bit us live).

## Publish and the instance split

**P1 — Publish takes no per-publish parameters.** `api_task_def_publish` reads
exactly one field from the request body: `suv`. Every machine-local value —
`cwd`, project slug, model, connection, permission mode — comes from the console
*process's* environment, read at call time, and the console is a launchd
service. Probed directly: `POST /api/task/def/publish` with
`{"suv":"SUV-0012","cwd":"…/worktrees/suv-0012-run"}` returned
`publishTarget.cwd = /Users/jeffhampton/dev/craft-agents-oss` — the override was
neither honoured nor rejected. This is the concrete cost of scope #3 above; the
workaround was to hand-edit `cwd:` in the published instance, which immediately
put the instance out of sync with its own publish record
(`publishedFileChanged: true`).

**P2 — Republish restores the definition and destroys the run-local knob.**
Re-publishing is ADR-0028's drift resolver and it works exactly as specified.
After five runs and two sabotages of the instance, one `POST
/api/task/def/publish` restored it to a file differing from the first publish by
**two lines**: the publish timestamp in the header, and `cwd:`. Every sabotaged
prompt was gone and `publishedFileChanged` was back to `false`. The catch is in
that second line — the rewrite is from the definition plus process env, so the
hand-patched `cwd` and the hand-patched `max_iterations` (C3) went with it. The
operation that repairs drift is the operation that discards the only place
run-local values can live.

**P3 — Publishing produces a file and nothing else; the verification gate needs
a session.** `TaskRunner.maybeFinish` enters `verifying` only when
`opts.orchestratorSessionId` is set — with no orchestrator it calls
`finish('completed')` directly. A task published as a bare `task.yaml` has no
session, so `tasks:run` on it *would complete without ever being graded*. The
obvious repair, `tasks:create`, calls `saveTaskSpec` → `serializeTaskYaml`, which
re-emits the file from the parsed spec and drops the console's provenance header
("Published from SUV-0012 … Source of truth: …"), flipping the publish record to
changed. SUV-0012 sidestepped both by calling `sessions:create` with
`taskSlug`/`workingDirectory` directly. **The published artifact is not
self-sufficient: something has to mint its orchestrator, and the product's own
path for that mutates the artifact.**

**P4 — A published task cannot be addressed.** No `vorno://` route on `main`
focuses a task: the main-process parser (`apps/electron/src/main/deep-link.ts`)
accepts `allSessions | flagged | state | sources | settings | skills`, plus
`workspace/…` and `action/…`, and no action takes a task slug; the renderer's
route grammar (`apps/electron/src/shared/route-parser.ts`) has no `task` prefix
at all. And a freshly published task has no session and no `TASK-<slug>-N` label
until it is run, so there is nothing for the session-shaped routes to point at
even in principle. SUV-0011 renders a filesystem path instead of a link.

**P5 — Ownership has to be a record, not an inference.** A `task.yaml` the
console wrote and one a human wrote can be byte-identical, so "may I overwrite
this?" is answered from `publish-state.json`, which is machine-local and
git-ignored by construction — "published on 2026-08-24 to /Users/jeffhampton/…"
is true of one laptop, not of the SUV. Any definition/instance model needs the
same answer and the same reason.

## Run and verification

**R1 — A verification node cannot fail a run; only the rubric can.** See finding
1 above. The consequence for authoring is that the *rubric* becomes the load-
bearing artifact and it is prose. SUV-0012's `acceptance_criteria` is a numbered
three-clause grading procedure whose first clause exists only to stop the
orchestrator re-litigating the adversarial node's conclusion.

**R2 — The repair channel leaks the answer** (finding 2). Quantified below.

**R3 — Per-node output is keyed by node id, not by attempt.**
`writeNodeOutput(workspaceRoot, slug, runId, nodeId, output)` writes
`runs/<runId>/nodes/<id>.json`; a repair pass overwrites it. After sabotage run
A repaired itself, `nodes/survey.json` and `nodes/adversarial-verify.json`
contained the *second* attempt's text — the rejected output that the FAIL verdict
was about is unrecoverable from the durable store. The run-log records
`node-retry` with the verdict reason but not the superseded text. A run that
repairs itself therefore cannot be audited for *what it repaired*.

**R4 — `verdict` is the only structured run outcome, and it is parsed out of
prose.** `parseVerdict` regexes the orchestrator's last
`VERDICT: PASS|FAIL [— [nodes=a,b — ]reason]`, with a bounded re-ask
(`MAX_UNPARSED_REASKS`) when it cannot find one. It works — all three SUV-0012
runs produced parseable verdicts on the first ask — but the run's entire binary
outcome rides on a model emitting a line in the right shape, and the reason is a
free-text string that then becomes the repair instruction (R2).

**R5 — The adversarial node worked, and worked hard.** On the clean run it
re-ran the validator itself, re-derived the SUV set by a different route than the
report described (`find … | wc -l` plus per-file frontmatter extraction rather
than the survey's grep), and caught the trap the naive method sets:
`grep -rl "plan: PLAN-043" roadmap/suvs/` returns **14** paths because
`roadmap/suvs/README.md` matches as prose, while the true population is 13
records. It reported PASS only after failing to find fault. On a sabotaged run it
enumerated ten separate fabrications by hand and refused the report outright.
This is the one part of the stack that behaved better than its scaffolding: the
*capability* is there, the *structure* to hold it (finding 1, R3) is not.

**R6 — A verification node's scope is its input, not the run's premise.** This
cost an extra sabotage run to discover. When `survey` was sabotaged (run 3),
`reconcile-report` did the honest thing — it re-read the corpus, named the
fabricated ids, and scoped its consistency claim to the corpus rather than to the
survey. `adversarial-verify`, whose prompt points it at
`${nodes.reconcile-report.output}`, therefore audited a *faithful* report and
correctly returned **`VERDICT: PASS`** on a run whose premise was poisoned. The
run failed anyway — but on a clause of the prose rubric ("the run also FAILS if
`survey` lists an SUV id that does not exist"), not on the verification node.
Only when the sabotage was moved to the node's *direct upstream* (run 5) did
`adversarial-verify` itself fail the run. **A verifier wired to one node's output
verifies that node's honesty, not the chain's.** Any model where verification is
a node needs to say what a verify node is scoped to — and probably needs it to be
the run, not an edge.

## The runs

Five unattended runs of the published `suv-0012-reconcile-corpus-probe` against a
detached git worktree of the roadmap repo at `d44bc3ad`. No intervention mid-run
in any of them; the driver only reads `runs/<runId>/run-log.jsonl`. Every
sabotage was applied to the **published instance**, never to the repo definition.

| Run | What was broken | runId | Verdicts | Terminal |
|-----|-----------------|-------|----------|----------|
| 1 — clean | nothing | `run-1787622446237` | `pass` | `run-completed` |
| 2 — sabotage `survey`, repair enabled | fabricated 15-SUV list | `run-1787622661840` | `fail` (nodes=`survey`,`reconcile-report`) → `pass` | `run-completed` |
| 3 — sabotage `survey`, `max_iterations: 0` | same | `run-1787622990291` | `fail` (nodes=`survey`) | **`run-failed`** |
| 4 — sabotage `reconcile-report` | fabricated report; `depends_on` also lost | `run-1787623257391` | `fail` (nodes=`reconcile-report`,`adversarial-verify`) | **`run-failed`** |
| 5 — sabotage `reconcile-report`, edges intact | fabricated report only | `run-1787623406869` | `fail` (nodes=`reconcile-report`,`adversarial-verify`) | **`run-failed`** |

**Run 1 — the clean unattended run.** 2 min 30 s wall clock, 4/4 nodes `done`,
one `pass` verdict, `run-completed`. The survey found 13 SUVs; the validator
reported `ok: true`, 0 violations over 86 records / 110 files; the reconciliation
report concluded consistent; the adversarial node could not find fault.
`git status --porcelain` in the worktree was empty afterwards — the read-only
convention held, though nothing enforced it (C4).

**Run 2 — sabotage absorbed by the repair loop.** The sabotage: replace
`survey`'s prompt with one supplying a pre-written "authoritative" list
containing two SUVs that do not exist (`SUV-0014`, `SUV-0015`), the wrong status
folder for `SUV-0012` (`planned` instead of `in-progress`), and `COUNT: 15`. The
gate caught all of it —

> `VERDICT: FAIL — nodes=survey,reconcile-report — survey fabricated
> SUV-0014/SUV-0015 and counted 15 against a real 13-SUV corpus, and
> reconcile-report concluded "the corpus is NOT internally consistent" against a
> validator run reporting ok:true / 0 violations, which adversarial-verify
> independently refuted.`

— and then repaired it away. The reason string became the retried node's prompt
prefix; the sabotaged node refused its own instructions (*"I can't reproduce the
supplied survey: it is the exact artifact that failed verification"*) and
produced the true 13-SUV list; the second verification passed and the run
completed. **Detection worked; the demonstration did not, because the product's
repair loop is stronger than the sabotage** (finding 2 / R2). This run is also
the R3 artifact: attempt 1's `survey` and `adversarial-verify` outputs were
overwritten by attempt 2's, so the text the FAIL verdict was actually about no
longer exists on disk.

**Run 3 — the same sabotage, terminal.** `max_iterations: 0` hand-added to the
instance — the field C3 says the composer cannot express. The gate returned
`VERDICT: FAIL — nodes=survey — listed non-existent SUV-0014/SUV-0015 (COUNT 15
vs 13 on disk) and wrong status for SUV-0012`, immediately followed by
`budget-breach {metric: iterations, value: 0, limit: 0}` and `run-failed`.
**Deliberately breaking an upstream node failed the run.** Note that
`adversarial-verify` returned PASS here — see R6.

**Runs 4 and 5 — making the verification node itself fail the run.** The
sabotage moved to `reconcile-report`, whose output the adversarial node consumes:
a fabricated report claiming 15 SUVs, `ok: false`, 3 violations, 118 files, 91
records, with three real check names lifted from the validator's `checks` map to
look authentic. `adversarial-verify` re-ran the validator, re-enumerated the
corpus, listed **ten** discrepancies, observed that *"the internal coherence of
Sections 1–4 with each other is exactly what makes them worthless as evidence"*,
and returned `VERDICT: FAIL`. The gate honoured it (rubric clause 1) and the run
failed.

Run 4 and run 5 differ only in a mistake worth recording: run 4's hand-edit of
the instance replaced the whole `reconcile-report` node block and **dropped its
`depends_on`**. The task still validated, `tasks:run` still accepted it, and the
runner dispatched `reconcile-report` in parallel with the two nodes it was
supposed to consume. Nothing warned, at any layer. That is S1's silent-edge-drop
predicted from a probe, then hit for real on a live instance five hours later.
Run 5 restored the edges and is the clean result.


## What PLAN-039 W1 inherits

Not a design — the shortlist of questions this evidence forces W1 to answer:

- Can a node's *content* determine run outcome, or is grading always a session
  reading prose? (finding 1, R1, C3's `max_iterations`)
- What is a verify node scoped to — an edge, or the run? (R6)
- Is a repair pass allowed to see why it was rejected? If yes, verification and
  repair cannot share a channel. (finding 2, R2, R3)
- Where do run-local values live, given definition and instance are both too
  coarse? (finding 3, P1, P2)
- What mints an instance's orchestrator, and can it do so without rewriting the
  artifact? (P3)
- Can a definition declare its environment contract and its side-effect
  boundary? (D3, D4, C4, C6.3)
- Is the schema strict? (S1, S2)
- Does the authoring surface's expressive ceiling get to be lower than the
  schema's? Two independently built authoring tools have now landed on the same
  eight fields. (C3)
