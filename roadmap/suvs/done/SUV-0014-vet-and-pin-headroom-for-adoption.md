---
id: SUV-0014
title: Vet and pin Headroom for adoption
status: done
plan: PLAN-040
direction: DIR-05
owner: jh
created: 2026-08-25
updated: 2026-08-27
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

- [x] `roadmap/evidence/` contains a Headroom vetting report covering license/NOTICE findings and an audit of network/telemetry behavior, including what (if anything) leaves the machine and the opt-in controlling it. → `roadmap/evidence/PLAN-040/headroom-vetting-report.md` §2 (license/NOTICE, F1), §3 (network/telemetry), §3.6 (egress table + the `baseUrl` opt-in).
- [x] The Headroom TS SDK appears in a package manifest pinned to an exact version; `bun.lock` resolves it; no `latest` or caret/tilde range is used. → `packages/shared/package.json` → `"headroom-ai": "0.36.5"`; `bun.lock` L2354; `bun install --frozen-lockfile` clean; guarded by `headroom-pin.test.ts`.
- [x] The vetting report documents the update cadence: how and when the pin is bumped, and who reviews the diff. → report §5 (trigger, procedure, reviewer `jh`).
- [x] No production source file imports the SDK yet — the dependency lands unreferenced (verifiable by grep). → `grep -rn "headroom-ai" apps packages --include="*.ts" --include="*.tsx"` returns only the guard test's own string constants.

## Status log

- `2026-08-25` — created in `planned/`
- `2026-08-26` — **implemented.** Identified the SDK as `headroom-ai` on npm
  (the plan named only the GitHub repo; the npm namespace is crowded with
  unrelated and third-party "headroom" packages) and confirmed identity against
  the repo's own `sdk/typescript/package.json`. Pinned **`headroom-ai@0.36.5`**
  exactly in `packages/shared/package.json` — chosen because that package owns
  the agent session loop SUV-0015 will instrument and already sets exact-pin
  precedent (`@earendil-works/pi-agent-core: "0.80.6"`). Vetting report landed at
  `roadmap/evidence/PLAN-040/headroom-vetting-report.md`.
  **Audit result: cleared to pin.** Zero runtime deps, no install scripts, no
  filesystem access, no background timers, no import-time side effects; the only
  hardcoded URL in the entire package is `http://localhost:8787`, and every
  endpoint is a relative path against a configurable `baseUrl` — so nothing
  leaves the machine unless someone repoints `baseUrl`/`HEADROOM_BASE_URL`. The
  `/v1/telemetry*` endpoints are **reads from the local proxy**, not vendor
  reporting. The audited tarball's sha512 matches the `bun.lock` integrity hash
  exactly, so the audit applies to the bytes we pinned.
  **Four findings, none blocking:** F1 the npm tarball ships neither LICENSE nor
  NOTICE despite `files` claiming LICENSE (Apache-2.0 §4(a)/(d) obligation lands
  on Vorno when we bundle it — close before shipping a build); F2 no npm
  provenance attestation and no `repository` field (mitigated by the lockfile
  integrity pin plus a re-audit step in the cadence); **F3 (material) the
  `chat`/`messages` helpers silently read `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`
  from the environment and forward them to `baseUrl` — SUV-0015's boundary
  module must expose only `compress`/`retrieve`/`stats` and never those
  surfaces**; **F4 (architectural) the TS SDK is a thin HTTP client for the
  Headroom proxy, not in-process compression** — it has no compression engine,
  so "adopt the SDK" and "run the proxy" are one decision, not alternatives.
  F4 contradicts PLAN-040 §I1's in-process bias and directly informs plan open
  question 1; recording it as evidence only, since the architectural decision is
  an ADR and out of this SUV's scope. SUV-0015's no-op fallback must treat
  "proxy not running" (`HeadroomConnectionError`) as the expected default state.
  Update cadence documented in §5 of the report: monthly scheduled review plus
  security-advisory and needed-fix triggers; bump procedure re-runs the network
  audit (compensating for F2) and lands as its own PR, never bundled with
  feature work; `jh` reviews every diff.
  Added `packages/shared/src/__tests__/headroom-pin.test.ts` — four guards
  enforcing the exact pin (LEARNING-062), manifest/lockfile agreement, and that
  no production source imports the SDK. Verified red-then-green: with the pin
  ranged to `^0.36.5` and a sabotage import added, 0 pass / 4 fail (the import
  guard named the offending file); reverted, 4 pass / 0 fail. **Whoever lands
  SUV-0015 should delete the import guard, not weaken it.**
  The dependency lands unreferenced — grep confirms the only `headroom-ai`
  mentions in `apps/`/`packages/` are string constants inside that guard test.

- `2026-08-27` — **advance pass. `planned/` → `done/`, `status: planned` → `status: done`.**
  Acceptance was already green and no open blocker was named; only the folder
  and frontmatter lagged. Part of a single eight-file pass over PLAN-040's SUVs
  taken alongside ADR-0029, which closed the plan's last open decision. The
  general shape being corrected: an unsatisfied *declared* edge halts
  advancement even when the edge is factually discharged, because folder status
  is the only thing the edge reads.
