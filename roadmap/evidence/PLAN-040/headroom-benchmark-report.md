---
plan: PLAN-040
suv: SUV-0025
direction: DIR-05
kind: benchmark
status: complete
measured: 2026-08-27
harness: scripts/benchmark-headroom.ts
sdk: headroom-ai@0.36.5
proxy: headroom-ai[proxy]==0.36.5
---

# Headroom compression benchmark — real Vorno workloads

Companion to [`headroom-vetting-report.md`](headroom-vetting-report.md). Together
the two complete PLAN-040's **I0** acceptance item: that one vets *what we are
adopting*, this measures *what it does to our workloads* and sets the rollout
defaults.

Every number below was produced by `scripts/benchmark-headroom.ts` on
2026-08-27, replaying content from this machine's Vorno workspace through the
real boundary adapter (`packages/shared/src/headroom/`) against a real local
Headroom proxy. **Nothing here is estimated, interpolated, or taken from
Headroom's own marketing.** Where a value could not be measured, the tables say
`not measured` rather than `0`, per the plan's *measured or absent* rule.

---

## 1. Headline

| Question | Answer |
| --- | --- |
| Does compression reach a live Vorno **session**? | **No.** 0 of 48 tool outputs were accepted, under every profile. |
| Does compression reach a **Conductor** run? | **Yes.** 12 of 12 node outputs accepted, under every profile. |
| Is compressed content recoverable? | **No.** The pinned proxy issued **zero** retrieval handles across all 240 compression calls. |
| Best measured whole-corpus saving | **12.5%** (`balanced`), at the cost of 58,373 bytes of unrecoverable node output. |
| Steady-state latency cost | p50 **+4.5 to +11.3 ms** per call over the no-op baseline; p95 up to **+1,352 ms**. |
| **Decision** | **Headroom stays off by default at every layer.** See §6. |

The two facts that decide it: Vorno's session loop **cannot** currently accept
anything this proxy returns, and everything the Conductor path *does* accept is
**irreversible**. Enabling by default would therefore buy no session savings at
all, and would pay for its workflow savings by silently destroying node outputs.

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
| `plan-040-…/runs/run-1787798690660` | Conductor workflow run | 12 | 100,372 | `97c83b73bef35bc1` |

60 payloads per profile × 4 profiles = **240 compression calls**, plus 240 no-op
baseline calls.

The workflow run is PLAN-040's own breakdown run — 36 real node outputs from
SUV-0014 through SUV-0016, of which the 12 largest were sampled.

> **On "a PLAN-039 workflow run".** SUV-0025's scope names one, but PLAN-039 is a
> sibling milestone and is not this SUV's dependency (`blocked-by:` lists only
> SUV-0023). Reusable workflow *definitions* do not exist yet. The acceptance
> text asks for "one workflow run", which is read here as an existing Conductor
> multi-node run through SUV-0024's dispatch path — which is what was measured.

### 2.2 The call sites are the shipped ones

Payloads are replayed through the code that runs in the product, not a
friendlier shape:

- **Session loop** — the real `compressToolOutput` (SUV-0023), with all four of
  its acceptance rules intact.
- **Conductor dispatch** — `TaskRunner.compressOutput`'s exact request shape
  (SUV-0024): one `assistant` message in, compressed message contents joined
  back out, accepted whenever `compressed` is true.

Each payload is measured through the one call site its kind actually reaches.

### 2.3 Baseline

Latency overhead is stated against **the no-op adapter over the identical
payloads** — Vorno's real "off" state — not against having no boundary at all.
The first call of each proxy process is discarded and reported separately: the
proxy loads its compressors lazily, and that is a start-up cost, not a per-call
one.

### 2.4 "Per engine" — what that means with this SDK

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
apply the new settings"* — so each profile ran in its own proxy process.

---

## 3. Token savings per engine

`Accepted` counts payloads the shipped call site actually took. Note how often
it is **0** on a row with real savings: the proxy compressed, and Vorno declined
the result.

### `coding` (the proxy's own default)

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 31 / 31 | 0 | 80,689 | 80,689 | 100.0% |
| `router:mixed` | 12 / 12 | 6 | 25,144 | 21,515 | 85.6% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:log` | 3 / 3 | 3 | 6,465 | 2,358 | 36.5% |
| `router:tabular` | 3 / 3 | 3 | 4,776 | 1,031 | 21.6% |
| `router:text` | 2 / 2 | 0 | 6,028 | 4,093 | 67.9% |
| `router:code_aware` | 2 / 2 | 0 | 1,660 | 1,327 | 79.9% |
| `router:smart_crusher` | 1 / 1 | 0 | 971 | 890 | 91.7% |

Whole corpus: **133,349 → 119,519 tokens (10.4% saved)**.

### `agent-90`

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 50 / 50 | 11 | 116,816 | 116,816 | 100.0% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:kompress` | 3 / 3 | 1 | 8,336 | 6,700 | 80.4% |
| `router:protected:recent_code` | 1 / 1 | 0 | 581 | 581 | 100.0% |

Whole corpus: **133,349 → 131,713 tokens (1.2% saved)**.

The name promises 90%; on Vorno's workloads it routed 50 of 60 payloads to
`noop`. Recorded here because it is the clearest instance of why this SUV
measures rather than reads a README.

### `balanced`

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 30 / 30 | 1 | 78,771 | 78,771 | 100.0% |
| `router:mixed` | 12 / 12 | 6 | 25,144 | 17,446 | 69.4% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:protected:recent_code` | 5 / 5 | 0 | 6,341 | 6,341 | 100.0% |
| `router:tabular` | 3 / 3 | 3 | 4,776 | 1,031 | 21.6% |
| `router:log` | 2 / 2 | 2 | 5,344 | 1,879 | 35.2% |
| `router:text` | 1 / 1 | 0 | 4,386 | 2,793 | 63.7% |
| `router:smart_crusher` | 1 / 1 | 0 | 971 | 866 | 89.2% |

Whole corpus: **133,349 → 116,743 tokens (12.5% saved)** — the best measured.

### `general`

| Engine | Payloads measured | Accepted | Tokens before | Tokens after | Keep ratio |
| --- | --- | --- | --- | --- | --- |
| `router:noop` | 32 / 32 | 1 | 81,810 | 81,810 | 100.0% |
| `router:mixed` | 12 / 12 | 6 | 25,144 | 21,517 | 85.6% |
| `router:protected:error_output` | 6 / 6 | 0 | 7,616 | 7,616 | 100.0% |
| `router:tabular` | 3 / 3 | 3 | 4,776 | 1,031 | 21.6% |
| `router:log` | 2 / 2 | 2 | 5,344 | 1,879 | 35.2% |
| `router:text` | 2 / 2 | 0 | 6,028 | 4,224 | 70.1% |
| `router:code_aware` | 2 / 2 | 0 | 1,660 | 1,539 | 92.7% |
| `router:smart_crusher` | 1 / 1 | 0 | 971 | 890 | 91.7% |

Whole corpus: **133,349 → 120,506 tokens (9.6% saved)**.

**Not measured:** no engine appears here that the proxy did not route to. In
particular `Kompress-v2-base` (the HuggingFace text model) was only reached
under `agent-90`; the `[ml]` extra was not installed, so any behaviour behind it
is **absent, not zero**.

---

## 4. Latency

60 samples per profile. Baseline is the no-op adapter over the identical
payloads.

| Profile | p50 | p95 | max | Overhead p50 | Overhead p95 | Warm-up (discarded) |
| --- | --- | --- | --- | --- | --- | --- |
| `coding` | 11.1 ms | 1,351.8 ms | 1,687.0 ms | +11.1 ms | +1,351.8 ms | 391 ms |
| `agent-90` | 4.5 ms | 9.9 ms | 264.8 ms | +4.5 ms | +9.9 ms | 109 ms |
| `balanced` | 10.8 ms | 1,336.6 ms | 1,814.8 ms | +10.8 ms | +1,336.6 ms | 131 ms |
| `general` | 11.3 ms | 1,349.9 ms | 1,712.7 ms | +11.3 ms | +1,349.9 ms | 141 ms |

The no-op baseline measured 0.0 ms at p50 and p95 in every profile — the no-op
adapter does no I/O, which is the point of it.

**The p95 is the number to look at.** Median cost is negligible, but roughly one
call in twenty takes **1.3–1.8 seconds**. Those are the large Conductor node
outputs: a multi-node run pays this per edge, serially, before dispatching the
downstream node. `agent-90` is fast precisely because it compressed almost
nothing.

---

## 5. Retrieval fidelity

**Acceptance item 4 requires byte-identical round-trips or a full list of
deviations. There were no byte-identical round-trips, because there were no
round-trips at all: the pinned proxy issued zero retrieval handles across all
240 compression calls.** `ccr_hashes` came back `[]` every time.

Consequences, per call site:

- **Session loop** — safe, and inert. `compressToolOutput`'s rule 3 requires
  *exactly one* retrieval handle before accepting a compressed result. With zero
  handles the rule can never be met, so **every** tool output passed through
  untouched (0 of 48 accepted, all four profiles). The boundary's caution is
  working exactly as designed; the effect is that session compression currently
  does nothing at all.
- **Conductor dispatch** — accepts without requiring a handle, so **every**
  compression it took is unrecoverable through the adapter.

### Full deviation list

Every payload whose original is not byte-recoverable. All 35 are Conductor node
outputs from `run-1787798690660`; all are `compressed with no retrieval handle`.

Bytes are the node's original output; "unrecoverable" is the difference between
it and the compressed text Conductor would have put into downstream context.

| Node | Bytes in | `coding` | `balanced` | `general` | `agent-90` |
| --- | --- | --- | --- | --- | --- |
| `suv-0014-orient` | 6,119 | 4,632 | 4,632 | 4,632 | — |
| `suv-0014-implement` | 4,441 | 1,091 | — | — | — |
| `suv-0014-verify` | 10,372 | 2,434 | 5,511 | 2,434 | — |
| `suv-0014-adversarial-verify` | 11,820 | 2,802 | 6,483 | 2,802 | — |
| `suv-0015-orient` | 7,386 | 5,747 | 5,747 | 5,747 | — |
| `suv-0015-implement` | 5,132 | 748 | 2,621 | 748 | — |
| `suv-0015-verify` | 11,031 | 2,250 | 5,792 | 2,244 | 44 |
| `suv-0015-adversarial-verify` | 12,632 | 2,636 | 6,755 | 2,636 | — |
| `suv-0016-orient` | 7,074 | 5,823 | 5,823 | 5,823 | — |
| `suv-0016-implement` | 4,267 | 857 | 2,309 | 857 | — |
| `suv-0016-verify` | 8,540 | 6,947 | 6,581 | 6,581 | — |
| `suv-0016-adversarial-verify` | 11,558 | 7,324 | 6,119 | 6,119 | — |
| **Deviations** | | **12** | **11** | **11** | **1** |
| **Bytes unrecoverable** | | **43,291** | **58,373** | **40,623** | **44** |

A `—` means that node was not a deviation under that profile: the compressed
text came back identical to the original, so nothing was lost. 35 deviations in
total across the four profiles. The complete payload-by-payload record is in the
harness's JSON output (`--out-json`).

Not one session-transcript payload appears in this table, under any profile —
because not one was ever accepted.

> **How large a single loss gets.** In an out-of-band probe against the same
> proxy under the `coding` profile, a 3,000-line log tool output —
> 100,011 tokens — compressed to the literal string
> `[3001 lines omitted: 3000 INFO]`, **23 tokens, no handle**. That is a 99.98%
> "saving" and total, unrecoverable content destruction. It is not in the tables
> above because it is a synthetic payload, and this report publishes measured
> results on real workloads only. It is recorded here because it bounds the
> failure mode the real numbers only sample.

---

## 6. Chosen defaults, and why

**Instance base config (`HEADROOM_CONFIG_DEFAULTS`) stays fully off.**

| Field | Value | Why |
| --- | --- | --- |
| `enabled` | `false` | §5. Every compression the product would accept is irreversible, and the path that *is* safe accepts nothing. |
| `compressionEngines` | `[]` | §2.4. The field reaches no SDK surface; a non-empty default would imply a selection that does not happen. |
| `verbosity` | `'balanced'` | Steers no call today. Unchanged. |
| `exposeStats` | `false` | Stats are per-call and patchy; token surfaces are SUV-0028's problem, and exposing them before a display can carry the denominator would violate the plan's own rule. |

This is the SUV's explicitly permitted outcome: *"or an explicit documented
decision to stay off by default."* No config value changed — the values were
already correct, and this report is what makes them **evidence-backed** rather
than provisional. The doc comment on `HEADROOM_CONFIG_DEFAULTS` and its test
(`headroom-config.test.ts`) now cite this report, so a future change to any of
the four has to argue with a measurement.

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
4. **A p95 budget for Conductor.** +1.35 s per compressed edge, serially, is a
   real cost on a 36-node run even if fidelity is solved.

---

## 7. Reproduction

```bash
# 1 — the proxy (the npm SDK is an HTTP client only; the CLI ships via PyPI)
uv tool install --python 3.13 "headroom-ai[proxy]==0.36.5"

# 2 — the benchmark, spawning one proxy per profile
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

The harness **exits non-zero and publishes nothing** if the boundary hands back
the no-op adapter, so a run that silently measured the fallback path cannot
produce a report.

Pure logic — parsing, engine attribution, fidelity classification, aggregation —
lives in `packages/shared/src/headroom/benchmark.ts` and is unit-tested under
`bun run test:shared`.

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
