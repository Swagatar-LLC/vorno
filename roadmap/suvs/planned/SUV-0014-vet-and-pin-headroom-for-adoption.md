---
id: SUV-0014
title: Vet and pin Headroom for adoption
status: planned
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-25
related: []
blocked-by: []
---

# SUV-0014 — Vet and pin Headroom for adoption

## Goal

Land the supply-chain vetting evidence and an exact version pin that clear the
Headroom TypeScript SDK for integration.

## Scope

- License/NOTICE audit and network/telemetry behavior audit (what the SDK can
  send off-machine, and under what opt-in), written up as evidence documents in
  `roadmap/evidence/`.
- Add the Headroom TS SDK as a dependency pinned to an exact version — no
  `latest` or range dist-tags (LEARNING-062 class) — with a documented update
  cadence in the evidence report.
- Deliberately out: any runtime wiring or call sites (SUV-0015), config
  surfaces (SUV-0016), and workload benchmarks — benchmarks need compression
  wired into real sessions (I1) and are cut separately when that exists.

## Acceptance

- [ ] `roadmap/evidence/` contains a Headroom vetting report covering license/NOTICE findings and an audit of network/telemetry behavior, including what (if anything) leaves the machine and the opt-in controlling it.
- [ ] The Headroom TS SDK appears in a package manifest pinned to an exact version; `bun.lock` resolves it; no `latest` or caret/tilde range is used.
- [ ] The vetting report documents the update cadence: how and when the pin is bumped, and who reviews the diff.
- [ ] No production source file imports the SDK yet — the dependency lands unreferenced (verifiable by grep).

## Status log

- `2026-08-25` — created in `planned/`
