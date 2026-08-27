---
id: SUV-0025
title: Benchmark Headroom on real workloads and set rollout defaults
status: in-progress
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-27
related:
  - SUV-0014-vet-and-pin-headroom-for-adoption.md (the vetting half of I0; benchmarks were deferred to this SUV)
blocked-by:
  - SUV-0023-compress-tool-outputs-in-the-agent-session-loop.md (benchmarks need compression active in real sessions)
---

# SUV-0025 — Benchmark Headroom on real workloads and set rollout defaults

## Goal

Run compression benchmarks on real Vorno workloads, commit the results as
evidence, and use them to set the instance-level rollout defaults.

## Scope

- A repeatable benchmark harness (script in the repo) that replays
  representative Vorno workloads — real session transcripts and a PLAN-039
  workflow run — measuring token savings, latency overhead, and retrieval
  fidelity per compression engine.
- Results written up in `roadmap/evidence/`, completing the plan's I0
  acceptance item alongside the SUV-0014 vetting report.
- Instance base config defaults (SUV-0016) updated to what the numbers
  support — or an explicit documented decision to stay off by default.
- Deliberately out: changing any compression call sites or config schema.

## Acceptance

- [x] A benchmark harness exists in the repo and is runnable by command, replaying at least one real session transcript and one workflow run through the real adapter.
- [x] A benchmark report in `roadmap/evidence/` records token savings, latency overhead, and retrieval fidelity per engine — measured values only, never interpolated (plan's "measured or absent" rule).
- [x] Instance default config reflects the benchmark outcome, and the report states the chosen defaults and why.
- [x] Retrieval fidelity in the benchmark is byte-identical for every sampled payload, or every deviation is listed in the report.

## Status log

- `2026-08-26` — created in `planned/`
- `2026-08-27` — **implemented.** Harness `scripts/benchmark-headroom.ts` (impure
  half: proxy lifecycle, filesystem, clock, adapter calls) over
  `packages/shared/src/headroom/benchmark.ts` (pure half: workload parsing,
  engine attribution, fidelity classification, aggregation, rendering), 22 unit
  tests under the CI-gated `test:shared`. Report:
  `roadmap/evidence/PLAN-040/headroom-benchmark-report.md`.

  **Measured:** 240 compression calls against a real `headroom-ai[proxy]==0.36.5`
  proxy, over 4 real session transcripts + PLAN-040's own Conductor run
  (`run-1787798690660`), across all 4 savings profiles. Best whole-corpus saving
  **12.5%** (`balanced`); latency overhead p50 **+4.5–11.3 ms**, p95 up to
  **+1,352 ms**.

  **The two findings that set the default.** (1) The pinned proxy issued **zero**
  CCR retrieval handles across every call, and `compressToolOutput`'s rule 3
  requires exactly one — so the session loop accepted **0 of 48** tool outputs
  under every profile. Session compression is currently inert. (2) Conductor
  dispatch does not require a handle, so it accepted **12 of 12** node outputs,
  all irreversibly — 35 deviations across the four profiles, up to **58,373
  bytes** of unrecoverable node output in one 12-node sample. An out-of-band
  probe bounds the failure mode: a 100,011-token log became the 23-token string
  `[3001 lines omitted: 3000 INFO]` with no handle.

  **Defaults: off, everywhere** — the SUV's explicitly permitted outcome. No
  config *value* changed; what changed is that the values are now evidence-backed
  rather than provisional. `HEADROOM_CONFIG_DEFAULTS` documents the measurement,
  and two tests in `headroom-config.test.ts` pin the four fields and verify the
  cited report exists and records the decision (verified red by pointing the
  citation at a non-existent file).

  **Also fixed:** the harness's first parser read a transcript's display
  `content` instead of `toolResult`, which measured 40-byte UI labels as if they
  were tool outputs and silently dropped three of four transcripts. Caught before
  publication; pinned by its own test.

  **Left for other SUVs (call sites are out of scope here):** reconciling the
  session-loop/Conductor handle asymmetry, and measuring `HEADROOM_LOSSLESS`.
  Both are recorded in the report's "what would change this decision".

  Not run: any `[ml]`-extra engine (`Kompress-v2-base` — not installed). Absent
  from the tables rather than estimated.

- `2026-08-27` — **re-verified after rejection; report republished from a
  reproducible run.** Adversarial verification rejected the entry above for a
  false sampling claim, and it was right. Two defects, both in the report rather
  than the harness:

  1. **The sampling rule was described wrongly.** The report said the workflow
     run's "**12 largest**" node outputs were sampled. The harness does no such
     thing: `payloads.slice(0, --max-payloads)` takes a **prefix in source
     order** — filename order for a run's `nodes/*.json`. That is why the sample
     is exactly the `SUV-0014`–`0016` nodes; they sort first, they are not the
     biggest. The 12 genuinely largest nodes are a different set entirely
     (`suv-0026-adversarial-verify`, `suv-0029-orient`, … — checked). The
     related "36 node outputs" population figure was also wrong at re-check
     time: 61 files, 60 above the 2,048 B floor.
  2. **The numbers were not reproducible from the published command.** The
     workload is `run-1787798690660` — PLAN-040's own Conductor run, which is
     still being appended to and rewritten as this plan's SUVs execute. Node
     count and node text both moved between publication and re-check, so
     re-running the documented command returned different figures with no way to
     tell measurement error from workload drift.

  **What was done.** The full benchmark was re-run in one pass
  (2026-08-27T06:29:06Z–06:29:36Z, `headroom-ai@0.36.5` + proxy 0.36.5, 4
  profiles × 60 payloads = 240 real compression calls, exit 0), and **every
  figure in the report was republished from that single run**. New §2.2 states
  the selection rule at all three levels, names the 12 sampled nodes
  individually, and flags the live-directory hazard with the sha256 column as
  the check. §5 now also states that fidelity was classified for **all 240**
  calls — there is no second sampling step — which is what acceptance item 4
  actually turns on.

  **Re-measured (supersedes the figures above):** best whole-corpus saving
  **10.5%** (`balanced`, 132,175 → 118,263 tokens); overhead p50 **+4.4–13.1 ms**,
  p95 up to **+1,432 ms**. **Both findings reproduced exactly:** zero CCR
  handles across all 240 calls, session loop **0 of 48** accepted under every
  profile, Conductor **12 of 12** accepted. Deviations are now **30**
  (coding 12 / balanced 9 / general 9 / agent-90 0), each enumerated in the
  report's table; worst case **47,811 bytes** unrecoverable (`balanced`).
  `agent-90`'s zero is explained rather than left to look like safety: all 12 of
  its acceptances were `router:noop`, i.e. text it had not changed.

  The §5 single-loss probe was replaced too — the published one (100,011 tokens
  → `[3001 lines omitted: 3000 INFO]`) could not be re-derived because its
  payload was never recorded. The new one is re-run and its exact payload is
  published in §7: 74,999 B / 18,006 tokens → 22 tokens, `router:log:0.00`, no
  handle.

  **New test, red-then-green verified:** `parseWorkflowRun > preserves the
  caller's node order rather than ranking by size` pins the rule §2.2 now
  states. Red by inserting a `.sort((a, b) => b.text.length - a.text.length)`
  into `parseWorkflowRun` (1 fail / 22 pass), green on revert (23 pass). The
  SUV-0025 citation test was re-verified red the same way, by repointing the
  report's `suv:` frontmatter at `SUV-9999`.

  **Decision unchanged: off in all four fields.** Re-measurement moved the
  magnitudes, not the conclusion. `HEADROOM_CONFIG_DEFAULTS`'s doc comment was
  corrected from "up to 58 KB" to the re-measured 47,811 bytes.

  **Not mine, left alone:** `apps/electron/src/renderer/components/chat/context-usage.ts`
  appeared modified in this checkout mid-session (a comment-only edit belonging
  to SUV-0028's token surface). It is out of this SUV's scope, so it was neither
  committed nor reverted — reported instead.
