---
id: SUV-0025
title: Benchmark Headroom on real workloads and set rollout defaults
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-26
updated: 2026-08-26
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

- [ ] A benchmark harness exists in the repo and is runnable by command, replaying at least one real session transcript and one workflow run through the real adapter.
- [ ] A benchmark report in `roadmap/evidence/` records token savings, latency overhead, and retrieval fidelity per engine — measured values only, never interpolated (plan's "measured or absent" rule).
- [ ] Instance default config reflects the benchmark outcome, and the report states the chosen defaults and why.
- [ ] Retrieval fidelity in the benchmark is byte-identical for every sampled payload, or every deviation is listed in the report.

## Status log

- `2026-08-26` — created in `planned/`
