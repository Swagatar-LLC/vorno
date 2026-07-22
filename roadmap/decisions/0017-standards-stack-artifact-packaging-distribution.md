---
id: ADR-0017
title: Standards stack for artifact packaging, distribution, and provenance — Agent Skills + OCI/ORAS + Sigstore
status: accepted
date: 2026-07-22
supersedes: []
superseded-by: []
---

# ADR-0017 — Standards stack for artifact packaging, distribution, and provenance: Agent Skills + OCI/ORAS + Sigstore

## Context

The R1 bundle-standards survey (session 260721-frosty-coast, judged by the EM in session 260721-fleet-spring `plans/bundle-standards-judgment.md`) established: **no standard exists for the governed bundle Vorno envisions** (artifacts + the skills and guardrails that govern them, portable across harnesses and instances, signed) — the MCP Skills-Over-MCP WG charter (2026-04-14) explicitly parked exactly this as out-of-scope, ownerless work. The capabilities are split across mature layers: Agent Skills / SKILL.md owns human+agent authoring and portability (~40 clients, Linux Foundation stewardship reported); OCI artifacts + ORAS own content-addressed versioning and registry distribution (spec 1.1, universal registry support); Sigstore/cosign owns signing/provenance. A spec packaging Agent Skills as OCI artifacts already exists with working tooling (ThomasVitale, April 2026); Docker ships MCP catalogs/profiles as signed OCI artifacts today.

On PR #106 (2026-07-22) the owner directed: *"We need to incorporate this into our Architectural decisions and standards-focus,"* and added a stated goal (recorded in ADR-0016 Consequences): integrate **object storage with identity federation** for artifacts, with workspace storage ideally behind a **plugin architecture** for richer storage/AuthZ stories.

## Decision

Vorno commits to a layered standards stack for artifact packaging, distribution, and provenance — **adopt at the layer where a standard exists; participate where one is forming; invent only the empty cell.**

1. **Authoring layer — Agent Skills (agentskills.io), adopted now.** Already in use (`.agents/skills/`); Vorno stays conformant. Its deliberate omissions (versioning, distribution, signing) are layers Vorno adds on top, never forks against.
2. **Packaging/distribution/versioning layer — OCI artifacts + ORAS, committed as the transport when bundling/distribution ships (C4 of DIR-04).** Content-addressed digests (`@sha256:`) align with the artifact plane's `ArtifactVersion.contentHash` identity by design (constraint already recorded in ADR-0016). All interim artifact-plane design must remain OCI-packaging-compatible: content-hash version identity, plain portable files, no live-server-resolved identities.
3. **Signing/provenance layer — Sigstore (cosign), committed alongside layer 2.** Attestations/SBOM-style referrers ride the OCI Referrers API; W3C VC/C2PA remain watch-items for content-level provenance.
4. **Standards participation.** Watch SEP-2640 (Skills Extension) and the Skills-Over-MCP WG now; **Vorno holds the option to propose the missing bundle SEP once C2 ships** (a shipped artifact+surface plane is the credibility and the concrete design input). This continues the posture set by ADR-0015 (MCP Apps `ui/*` alignment as a standards-commitment signal).
5. **Non-goals (duplication guard).** Vorno does not rebuild what harnesses own: marketplace/registry indexes, plugin.json analogs, git/npm install flows, `allowed-tools` clones. The genuinely empty cell — artifacts fused with governing skills and enforcing portable guardrails, cross-harness, signed — is the only invention candidate, sequenced at C4.
6. **Storage separation (owner's stated goal, 2026-07-22).** Artifact/document storage aims at pluggable backends — object storage with identity-federated AuthZ at minimum — behind the root-binding seam ADR-0016 §2 established (`RootBinding` discriminated union; filesystem is the single C1 variant). Design work lands with the hosted-workspace track (ADR-0013 / PLAN-023); no provider implementation before then.

## Consequences

### Positive

- Bundling, when built, is registry-infrastructure-free: any OCI registry (GHCR, Harbor, …) distributes Vorno bundles; signing is off-the-shelf cosign.
- The artifact plane needs no rework later — its identity model is already OCI-shaped (verified in ADR-0016).
- A public, dated standards posture strengthens the portability/interoperability signal Jeff wants Vorno to carry.

### Negative

- Committing to OCI as transport before C4 means carrying a compatibility constraint through C2/C3 design reviews (cheap, but real — reviewers must check it).
- The propose-a-SEP option, if exercised, is a sustained attention cost; deliberately deferred until post-C2.

### Neutral

- **Preconditions before the C4 bundling ADR commits to a specific bundle spec** (carried from R1): re-verify SEP-2640's live review state, the ThomasVitale skills-OCI spec's adoption beyond its authors, and Agent Skills' Linux Foundation/AAIF stewardship (currently secondary-sourced).
- Docker's MCP catalog/profile OCI shipping is the closest production precedent to watch for convention drift.

## Alternatives considered

- **Invent a Vorno-native bundle format now** — rejected: duplicates harness ecosystems (HIGH overlap with Claude Code/Codex/Pi plugins), and no shipped artifact plane yet exists to bundle.
- **Wait for the MCP "broader packaging effort"** — rejected as sole posture: it is explicitly ownerless; watching without a committed stack would leave C1–C3 design unconstrained and risk incompatible shapes.
- **npm/git as the bundle transport** (the harness pattern) — rejected as the *committed* layer: no content-addressing guarantee, weak signing story, and per-harness silo precedent; remains fine as an *additional* distribution channel later.

## References

- R1 survey: session 260721-frosty-coast `plans/R1-artifact-bundle-standards-survey.md`; EM judgment: session 260721-fleet-spring `plans/bundle-standards-judgment.md`.
- ADR-0015 (two-plane architecture, standards posture), ADR-0016 (artifact URI/type model; OCI-compatibility + storage-separation records), ADR-0013 / PLAN-023 (identity federation, hosted workspace).
- agentskills.io · opencontainers.org (image/distribution 1.1) · oras.land · sigstore.dev · github.com/ThomasVitale/agents-skills-oci-artifacts-spec · modelcontextprotocol.io/community/working-groups/skills-over-mcp (SEP-2640 context).
