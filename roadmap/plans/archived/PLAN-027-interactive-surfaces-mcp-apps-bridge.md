---
id: PLAN-027
title: Interactive surfaces — allow-scripts sandbox + MCP Apps ui/* bridge (C3)
status: archived
direction: DIR-04
owner: jh
created: 2026-07-21
updated: 2026-08-22
related:
  - PLAN-026-composed-surfaces-v1.md
blocked-by:
  - PLAN-026-composed-surfaces-v1.md
---

# PLAN-027 — Interactive surfaces: allow-scripts sandbox + MCP Apps `ui/*` bridge (C3)

## Goal

Agents can ship expressive, interactive HTML surfaces that run scripted in a hardened sandbox and talk back over a bridge speaking the ratified MCP Apps (SEP-1865) `ui/*` contract — positioning Vorno to become a full MCP Apps host later.

## Scope

- **New sandboxed iframe class** (distinct from display-only html-preview, which stays as-is): `allow-scripts`, metadata-derived CSP per the SEP-1865 host requirements, permission allow-list.
- **postMessage bridge**: JSON-RPC with the spec's `ui/*` method set (`ui/message`, `ui/open-link`, `ui/update-model-context`, `ui/notifications/tool-*`, sizing, teardown) mapped onto Vorno's transport; state persistence via host-side rehydration (the spec's documented caveat), not iframe-local storage.
- **Surface = artifact**: typed `surface/html-app`, versioned, related — same plane as C2.
- **Security review before code**: the `allow-scripts` trust boundary gets its own review gate (owner-visible); never simplified away (ponytail hard floor).
- **Door ADR before code**: sandbox posture + bridge contract (adopt-don't-invent alignment recorded; owner sign-off).

## Non-goals

- Full MCP Apps host compliance (rendering third-party MCP servers' `ui://` resources) — the deliberate later door this opens, not v1.
- Remote-DOM / external-URL modes (deferred in the ratified spec itself).
- Replacing composed surfaces as the default class (ADR-0015 §3: reliability-first stands).

## Approach

Lift the host-side requirements directly from the SEP-1865 spec (sandbox, CSP template, method set, pre-declared templates). Detailed sketch on advance, after security review + door ADR.

## Acceptance

- [ ] An agent-generated interactive HTML surface runs scripted, sandboxed, with working `ui/message` round-trip into a session
- [ ] Undeclared-domain connections blocked; CSP derived from surface metadata; security review sign-off recorded
- [ ] Surface persists as an artifact and re-renders after restart via host-side rehydration
- [ ] Door ADR accepted before implementation
- [ ] Tests added/updated; CI-parity gates green; behind feature flag
- [ ] Roadmap docs updated

## Status log

- `2026-07-21` — created in `planned/` (C3 of the ADR-0015 ladder)
- `2026-08-22` — **archived (PLAN-045 Pass 2)**: third link of a three-deep blocked chain (C3 → PLAN-026 → PLAN-025) with no live head. Both durable ideas were salvaged: the adopt-don't-invent precedent (SEP-1865 lifted verbatim) into `PLAN-044-cross-system-work-requests.md`, and the security-review-before-code gate on any trust boundary into `PLAN-041-server-homed-instances-with-auth.md`. The MCP-Apps-host ambition is a direction, not a queued plan. Mining record: [`2026-08-22-plan-045-mining-report.md`](../../discussions/2026-08-22-plan-045-mining-report.md).
