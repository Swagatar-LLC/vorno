---
plan: PLAN-040
suv: SUV-0025
direction: DIR-05
kind: benchmark
status: complete
measured: 2026-08-27T06:29Z
harness: scripts/benchmark-headroom.ts
sdk: headroom-ai@0.36.5
proxy: headroom-ai[proxy]==0.36.5
---

# Headroom compression benchmark — real Vorno workloads

Companion to [`headroom-vetting-report.md`](headroom-vetting-report.md). Together
the two complete PLAN-040's **I0** acceptance item: that one vets *what we are
adopting*, this measures *what it does to our workloads* and sets the rollout
defaults.

Every number below was produced by `scripts/benchmark-headroom.ts` in a single
pass on **2026-08-27, 06:29:06Z–06:29:36Z**, replaying content from this
machine's Vorno workspace through the real boundary adapter
(`packages/shared/src/headroom/`) against a real local Headroom proxy.
**Nothing here is estimated, interpolated, or taken from Headroom's own
marketing.** Where a value could not be measured, the tables say `not measured`
rather than `0`, per the plan's *measured or absent* rule.

> **Revision note (2026-08-27).** The first publication of this report carried a
> false description of how its sample was drawn — it said the workflow run's "12
> largest" node outputs were sampled, when the harness in fact takes a prefix in
> filename order (§2.2). The numbers were also taken from a workload directory
> that is still being written to, so they could not be reproduced by re-running
> the published command. This revision re-runs the whole benchmark, republishes
> every figure from that one reproducible pass, and states the sampling rule
> exactly. `parseWorkflowRun`'s order-preservation is now pinned by a unit test,
> so the claim in §2.2 is checkable rather than a matter of belief.

---

## 1. Headline

| Question | Answer |
| --- | --- |
| Does compression reach a live Vorno **session**? | **No.** 0 of 48 tool outputs were accepted, under every profile. |
| Does compression reach a **Conductor** run? | **Yes.** 12 of 12 node outputs accepted, under every profile. |
| Is compressed content recoverable? | **No.** The pinned proxy issued **zero** retrieval handles across all 240 compression calls. |
| Best measured whole-corpus saving | **10.5%** (`balanced`), at the cost of 47,811 bytes of unrecoverable node output. |
| Steady-state latency cost | p50 **+4.4 to +13.1 ms** per call over the no-op baseline; p95 up to **+1,432 ms**. |
| **Decision** | **Headroom stays off by default at every layer.** See §6. |

The two facts that decide it: Vorno's session loop **cannot** currently accept
anything this proxy returns, and everything the Conductor path *does* accept and
actually compress is **irreversible**. Enabling by default would therefore buy no
session savings at all, and would pay for its workflow savings by silently
destroying node outputs.

---

## 2. What was measured, and how

### 2.1 Workloads — real, local, and deliberately not committed

Session transcripts are real user content and do not belong in git. The harness
reads them from the local workspace and publishes only measurements plus a
sha256 of the exact replayed payloads, so a published number stays checkable
without the content leaving the machine.

| Workload | Kind | Payloads | Bytes | sha256 (payloads, first 16) |
| --- | --- | --- | --- | --- |
| `260224-alert-swamp` | session transcript | 12 | 82,077 | `ed9a79454effc40e` |
| `260707-brave-orbit` | session transcript | 12 | 80,464 | `93961ba58adc2d89` |
| `260701-active-obsidian` | session transcript | 12 | 151,351 | `cc53a474de58afdf` |
| `260713-still-glass` | session transcript | 12 | 59,608 | `c15f9ea86a408c95` |
| `plan-040-…/runs/run-1787798690660` | Conductor workflow run | 12 | 95,208 | `2bbf398f8f244652` |

60 payloads per profile × 4 profiles = **240 compression calls**, plus 240 no-op
baseline calls. The same 60 payloads were replayed under every profile — the
sha256 column is identical across all four passes, which is what makes the
profile-to-profile comparisons in §3 and §5 like-for-like.

### 2.2 How the sample was drawn — the exact rule

The word "sampled" is load-bearing here, so it is spelled out rather than
implied. There is no random selection and no ranking by size at the payload
level:

1. **Which sessions.** `discoverSessions` stats every
   `sessions/*/session.jsonl` in the workspace and takes the **largest
   `--max-sessions` by file size** (4 here). Session *files* are the one place
   size ranking is used, and it is used deliberately: a transcript with no bulk
   in it has nothing to compress.
2. **Which run.** `discoverRuns` takes the **single most recently modified** run
   directory under `tasks/*/runs/`. There is no flag for the count — it is
   hardcoded to 1; `--run <path>` names one explicitly instead.
3. **Which payloads inside a workload.** Both parsers keep every payload whose
   content is at least `--min-bytes` (2,048 B default), **in source order** —
   transcript order for a session, filename order for a run's `nodes/*.json` —
   and the harness then takes the first `--max-payloads` of that list
   (`payloads.slice(0, 12)`). It is a **prefix, not a top-N by size**.

So the workflow-run sample is the first 12 node files in filename order that
clear 2,048 bytes. Named individually, because acceptance item 4 turns on
knowing exactly which payloads were checked:

`__verdict__`, `suv-0014-adversarial-verify`, `suv-0014-implement`,
`suv-0014-orient`, `suv-0014-verify`, `suv-0015-adversarial-verify`,
`suv-0015-implement`, `suv-0015-orient`, `suv-0015-verify`,
`suv-0016-adversarial-verify`, `suv-0016-implement`, `suv-0016-orient`.

At the time of this run that directory held **61** node files, 60 of which clear
the size floor. The prefix rule is why the sample is all `SUV-0014`–`0016`
material and none of the later SUVs': they sort after it.

> **The workload is a live directory, and that matters for reproduction.**
> `run-1787798690660` is PLAN-040's own Conductor run, and it is still being
> appended to and partly rewritten as this plan's SUVs execute — node count and
> node text both changed between the first publication of this report and this
> one. Re-running the command in §7 on a later day will therefore *not* return
> these exact figures. Compare the sha256 column first: same hash means the same
> bytes were replayed and the numbers should match; a different hash means the
> workload moved underneath you, not that the measurement was wrong. `--run`,
> `--session`, `--max-payloads` and `--min-bytes` are what pin a sample if you
> need to re-measure the same set.

### 2.3 The call sites are the shipped ones

Payloads are replayed through the code that runs in the product, not a
friendlier shape:

- **Session loop** — the real `compressToolOutput` (SUV-0023), with all four of
  its acceptance rules intact.
- **Conductor dispatch** — `TaskRunner.compressOutput`'s exact request shape
  (SUV-0024): one `assistant` message in, compressed message contents joined
  back out, accepted whenever `compressed` is true.

Each payload is measured through the one call site its kind actually reaches.

### 2.4 Baseline

Latency overhead is stated against **the no-op adapter over the identical
payloads** — Vorno's real "off" state — not against having no boundary at all.
The first call of each proxy process is discarded and reported separately: the
proxy loads its compressors lazily, and that is a start-up cost, not a per-call
one.

### 2.5 "Per engine" — what that means with this SDK

`HeadroomConfig.compressionEngines` exists in Vorno's config but **is not wired
to anything**: `session-adapter.ts` passes only `enabled` and `model` across the
seam, deliberately (SUV-0018). Vorno cannot select an engine today.

What *is* observable is the `transformsApplied` list the proxy returns, which
names the route each payload took (`router:tabular`, `router:log`,
`router:kompress`, …). That is what the per-engine tables below group by. A
payload is counted in **every** row its transform list names, so rows do not sum
to the payload count and each carries its own denominator.

Engine *selection* was varied instead through the proxy's
`HEADROOM_SAVINGS_PROFILE` (`coding`, `agent-90`, `balanced`, `general`), which
is a start-up setting — `POST /settings/apply` answers *"Restart the proxy to
apply the new settings"* — so each profile ran in its own proxy process. The
harness records the profile the proxy **reports** back from `/settings/schema`,
not the one that was requested.

---

## 3. Token savings per engine

`Accepted` counts payloads the shipped call site actually took. Note how often
it is **0** on a row with real savings: the proxy compressed, and Vorno declined
the result.

### `coding` (the proxy's own default)

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 31 / 31 | 0 | 80,689 | 80,689 | 100.0% |
| `router:mixed` | 11 / 11 | 5 | 24,723 | 21,155 | 85.6% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:log` | 4 / 4 | 4 | 5,288 | 3,401 | 64.3% |
| `router:text` | 3 / 3 | 1 | 8,169 | 5,760 | 70.5% |
| `router:code_aware` | 2 / 2 | 0 | 1,660 | 1,327 | 79.9% |
| `router:tabular` | 2 / 2 | 2 | 3,059 | 649 | 21.2% |
| `router:smart_crusher` | 1 / 1 | 0 | 971 | 890 | 91.7% |

Whole corpus: **132,175 → 121,487 tokens (8.1% saved)**.

### `agent-90`

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 51 / 51 | 12 | 118,513 | 118,513 | 100.0% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:kompress` | 2 / 2 | 0 | 5,465 | 3,839 | 70.2% |
| `router:protected:recent_code` | 1 / 1 | 0 | 581 | 581 | 100.0% |

Whole corpus: **132,175 → 130,549 tokens (1.2% saved)**.

The name promises 90%; on Vorno's workloads it routed 51 of 60 payloads to
`noop`. All 12 of its Conductor acceptances were `router:noop` — it accepted
node outputs it had not changed, which is why it is the one profile with no
fidelity deviations in §5. Recorded here because it is the clearest instance of
why this SUV measures rather than reads a README.

### `balanced`

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 31 / 31 | 3 | 78,864 | 78,864 | 100.0% |
| `router:mixed` | 11 / 11 | 5 | 24,723 | 17,360 | 70.2% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:protected:recent_code` | 5 / 5 | 0 | 6,341 | 6,341 | 100.0% |
| `router:text` | 3 / 3 | 1 | 8,169 | 5,206 | 63.7% |
| `router:tabular` | 2 / 2 | 2 | 3,059 | 649 | 21.2% |
| `router:log` | 1 / 1 | 1 | 2,432 | 1,361 | 56.0% |
| `router:smart_crusher` | 1 / 1 | 0 | 971 | 866 | 89.2% |

Whole corpus: **132,175 → 118,263 tokens (10.5% saved)** — the best measured.

### `general`

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 34 / 34 | 3 | 83,545 | 83,545 | 100.0% |
| `router:mixed` | 11 / 11 | 5 | 24,723 | 21,155 | 85.6% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:text` | 3 / 3 | 1 | 8,169 | 5,891 | 72.1% |
| `router:code_aware` | 2 / 2 | 0 | 1,660 | 1,539 | 92.7% |
| `router:tabular` | 2 / 2 | 2 | 3,059 | 649 | 21.2% |
| `router:log` | 1 / 1 | 1 | 2,432 | 1,361 | 56.0% |
| `router:smart_crusher` | 1 / 1 | 0 | 971 | 890 | 91.7% |

Whole corpus: **132,175 → 122,646 tokens (7.2% saved)**.

**Not measured:** no engine appears here that the proxy did not route to. In
particular `Kompress-v2-base` (the HuggingFace text model) sits behind the
`[ml]` extra, which was not installed, so any behaviour behind it is **absent,
not zero**. `router:kompress` above is the router *stage* the proxy names, not
that model.

---

## 4. Latency

60 samples per profile. Baseline is the no-op adapter over the identical
payloads.

| Profile | p50 | p95 | max | Overhead p50 | Overhead p95 | Warm-up (discarded) |
| --- | --- | --- | --- | --- | --- | --- |
| `coding` | 13.1 ms | 1,431.6 ms | 2,130.1 ms | +13.1 ms | +1,431.6 ms | 551 ms |
| `agent-90` | 4.4 ms | 12.7 ms | 398.8 ms | +4.4 ms | +12.7 ms | 112 ms |
| `balanced` | 11.4 ms | 1,370.6 ms | 2,086.0 ms | +11.4 ms | +1,370.6 ms | 144 ms |
| `general` | 11.7 ms | 1,401.4 ms | 2,105.1 ms | +11.7 ms | +1,401.4 ms | 131 ms |

The no-op baseline measured 0.0 ms at p50 and p95 in every profile — the no-op
adapter does no I/O, which is the point of it. Overhead therefore equals the
measured latency to the reported precision.

**The p95 is the number to look at.** Median cost is negligible, but roughly one
call in twenty takes **1.4–2.1 seconds**. Those are the large Conductor node
outputs: a multi-node run pays this per edge, serially, before dispatching the
downstream node. `agent-90` is fast precisely because it compressed almost
nothing.

---

## 5. Retrieval fidelity

**Acceptance item 4 requires byte-identical round-trips or a full list of
deviations. There were no byte-identical round-trips, because there were no
round-trips at all: the pinned proxy issued zero retrieval handles across all
240 compression calls.** `ccr_hashes` came back `[]` every time.

Fidelity was classified for **every one of the 240 measured calls**, not for a
subset of them — there is no second sampling step inside the fidelity check. The
60 payloads named in §2.1/§2.2 are the whole population that was checked, per
profile.

Consequences, per call site:

- **Session loop** — safe, and inert. `compressToolOutput`'s rule 3 requires
  *exactly one* retrieval handle before accepting a compressed result. With zero
  handles the rule can never be met, so **every** tool output passed through
  untouched (0 of 48 accepted, all four profiles). The boundary's caution is
  working exactly as designed; the effect is that session compression currently
  does nothing at all.
- **Conductor dispatch** — accepts without requiring a handle, so every
  compression it took is unrecoverable through the adapter. Where the proxy
  returned the text *unchanged*, acceptance costs nothing — that is the whole of
  `agent-90`'s 12 acceptances, and it is why its deviation count is 0.

### Full deviation list

Every payload whose original is not byte-recoverable, enumerated individually.
All 30 are Conductor node outputs from `run-1787798690660`; all are
`compressed with no retrieval handle`. Not one session-transcript payload
appears, under any profile — because not one was ever accepted.

"Bytes in" is the node's original output. Each profile cell is the number of
bytes that node lost under that profile — the difference between the original
and the compressed text Conductor would have put into downstream context. A `—`
means that node was **not** a deviation under that profile: the compressed text
came back identical to the original, so nothing was lost.

| Node | Bytes in | `coding` | `balanced` | `general` | `agent-90` |
| --- | --- | --- | --- | --- | --- |
| `__verdict__` | 3,848 | 388 | — | — | — |
| `suv-0014-adversarial-verify` | 11,957 | 1,681 | 6,298 | 1,681 | — |
| `suv-0014-implement` | 4,441 | 1,091 | — | — | — |
| `suv-0014-orient` | 6,119 | 4,632 | 4,632 | 4,632 | — |
| `suv-0014-verify` | 10,372 | 2,434 | 5,511 | 2,434 | — |
| `suv-0015-adversarial-verify` | 11,260 | 2,339 | 5,980 | 2,339 | — |
| `suv-0015-implement` | 2,839 | 460 | — | — | — |
| `suv-0015-orient` | 8,974 | 2,063 | 5,375 | 2,063 | — |
| `suv-0015-verify` | 9,314 | 5,630 | 4,120 | 4,120 | — |
| `suv-0016-adversarial-verify` | 14,743 | 3,996 | 7,763 | 3,996 | — |
| `suv-0016-implement` | 4,267 | 857 | 2,309 | 857 | — |
| `suv-0016-orient` | 7,074 | 5,823 | 5,823 | 5,823 | — |
| **Deviations** | | **12** | **9** | **9** | **0** |
| **Bytes unrecoverable** | | **31,394** | **47,811** | **27,945** | **0** |

12 + 9 + 9 + 0 = **30 deviations** in total across the four profiles, which is
every non-`—` cell in the table above. The complete payload-by-payload record,
including the untouched payloads, is in the harness's JSON output
(`--out-json`).

> **How large a single loss gets.** The real-workload numbers above sample the
> failure mode; this bounds it. Against the same proxy at the same version under
> the `coding` profile, a synthetic 3,000-line log — 74,999 bytes, 18,006 tokens
> — compressed to the 50-byte string
> `INFO  request handled ok\n... (repeated 3000 times)`, **22 tokens, no
> handle**: a 99.88% "saving" and near-total unrecoverable content destruction,
> reported as `router:log:0.00`. It is kept out of the tables above because it
> is synthetic and this report publishes measured results on real workloads
> only. The exact payload is published in §7 so the figure can be re-derived
> rather than taken on trust.

---

## 6. Chosen defaults, and why

**Instance base config (`HEADROOM_CONFIG_DEFAULTS`) stays fully off.**

| Field | Value | Why |
| --- | --- | --- |
| `enabled` | `false` | §5. Every compression the product would accept *and that actually changed the text* is irreversible, and the path that *is* safe accepts nothing. |
| `compressionEngines` | `[]` | §2.5. The field reaches no SDK surface; a non-empty default would imply a selection that does not happen. |
| `verbosity` | `'balanced'` | Steers no call today. Unchanged. |
| `exposeStats` | `false` | Stats are per-call and patchy; token surfaces are SUV-0028's problem, and exposing them before a display can carry the denominator would violate the plan's own rule. |

This is the SUV's explicitly permitted outcome: *"or an explicit documented
decision to stay off by default."* No config value changed — the values were
already correct, and this report is what makes them **evidence-backed** rather
than provisional. The doc comment on `HEADROOM_CONFIG_DEFAULTS` and its test
(`headroom-config.test.ts`) now cite this report, so a future change to any of
the four has to argue with a measurement.

The honest form of the trade the numbers describe: the best profile buys
**10.5%** of the corpus's tokens and pays **47,811 bytes** of node output that
no longer exists anywhere the product can reach.

### What would change this decision

Concrete, in rough order of leverage:

1. **CCR issues handles.** The single blocker. Until `ccr_hashes` is non-empty
   for real workloads, session compression is inert and Conductor compression is
   lossy. Worth an upstream question before any further Vorno work — the plan's
   posture is "thin glue or upstream PR", and this is upstream's to answer.
2. **Conductor requires a handle, like the session loop does.** SUV-0024 accepts
   handle-free compression; SUV-0023 refuses it. That asymmetry is why one call
   site is inert and the other is destructive. Reconciling it is out of this
   SUV's scope (call sites are explicitly excluded) and should be its own SUV.
3. **`HEADROOM_LOSSLESS=1`.** The proxy exposes a lossless mode this benchmark
   did not measure. If it compresses at all without dropping content, it changes
   the safety calculus entirely. Unmeasured, therefore absent from §3.
4. **A p95 budget for Conductor.** +1.4 s per compressed edge, serially, is a
   real cost on a 60-node run even if fidelity is solved.

---

## 7. Reproduction

```bash
# 1 — the proxy (the npm SDK is an HTTP client only; the CLI ships via PyPI)
uv tool install --python 3.13 "headroom-ai[proxy]==0.36.5"

# 2 — the benchmark, spawning one proxy per profile. This is the exact
#     invocation that produced every number in this report.
bun run scripts/benchmark-headroom.ts \
  --spawn-proxy \
  --profiles coding,agent-90,balanced,general \
  --max-sessions 4 --max-payloads 12 \
  --out-json /tmp/benchmark.json --out-md /tmp/benchmark.md

# against a proxy you already have running:
headroom proxy --port 8788
bun run scripts/benchmark-headroom.ts --base-url http://127.0.0.1:8788

bun run scripts/benchmark-headroom.ts --help
```

Check the sha256 column of the run's workload table against §2.1 before
comparing figures — see the live-directory note in §2.2.

The harness **exits non-zero and publishes nothing** if the boundary hands back
the no-op adapter, so a run that silently measured the fallback path cannot
produce a report.

Pure logic — parsing, engine attribution, fidelity classification, aggregation —
lives in `packages/shared/src/headroom/benchmark.ts` and is unit-tested under
`bun run test:shared`. That suite includes the test that pins the sampling rule
stated in §2.2 (`parseWorkflowRun > preserves the caller's node order rather
than ranking by size`).

### The single-loss probe from §5

```bash
headroom proxy --port 8799 &   # no HEADROOM_SAVINGS_PROFILE — defaults to `coding`

cat > /tmp/probe.ts <<'EOF'
import { createHeadroomAdapter } from './packages/shared/src/headroom/index.ts';
const adapter = await createHeadroomAdapter({
  enabled: true, baseUrl: 'http://127.0.0.1:8799', model: 'claude-sonnet-4-5',
});
const log = Array.from({ length: 3000 }, () => 'INFO  request handled ok').join('\n');
const r: any = await adapter.compress({
  messages: [{ role: 'assistant', content: log }], model: 'claude-sonnet-4-5',
});
const out = r.messages?.map((m: any) => m.content).join('\n') ?? '';
console.log('in', log.length, 'out', out.length, JSON.stringify(r.stats?.value), JSON.stringify(out));
EOF
bun run /tmp/probe.ts
```

Observed: `in 74999 out 50`, `tokensBefore 18006`, `tokensAfter 22`,
`transformsApplied ["router:log:0.00"]`, output
`"INFO  request handled ok\n... (repeated 3000 times)"`.

### A trap worth knowing about

`pip install headroom` installs **someone else's package** — an unrelated MIT
CLI assistant by a different author (`SUNKENDREAMS/headroom`, PyPI `headroom`
0.2.7). The Headroom this plan adopts is `headroom-ai` on **both** PyPI and npm.
The name collision sits directly on the install path this report tells you to
run, which is why it is called out here as well as in the vetting report.

### Numbers this report does not carry

- Any `[ml]`-extra engine, including `Kompress-v2-base`. Not installed.
- `HEADROOM_LOSSLESS` mode. Not measured.
- Anything about answer quality after compression. The harness measures tokens,
  latency and bytes; whether a model still answers correctly from compressed
  context is a different experiment.
