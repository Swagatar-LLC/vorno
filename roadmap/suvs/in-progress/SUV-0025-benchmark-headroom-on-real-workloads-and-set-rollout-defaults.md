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
