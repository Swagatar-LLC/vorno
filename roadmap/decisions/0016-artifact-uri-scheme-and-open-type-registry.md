---
id: ADR-0016
title: Artifact plane addressing — vorno-artifact:// URI scheme and open artifact-type registry
status: proposed
date: 2026-07-21
supersedes: []
superseded-by: []
---

# ADR-0016 — Artifact plane addressing: `vorno-artifact://` URI scheme and open artifact-type registry

> **Door ADR (PLAN-025 / C1 gate G2a).** Owner sign-off required before implementation. The four one-way doors are listed explicitly in §Doors below.

## Context

PLAN-025 generalizes the merged PLAN-024 workbench kernel (main @ `595a3bda`) into the workspace artifact plane (ADR-0015 / DIR-04). Two decisions in that generalization are one-way: **how artifacts are addressed** — URIs enter relation edges, thread files, wire payloads (`vorno:artifacts:*`), and exported Obsidian vaults, effectively forever — and **how artifact types are modeled** — a closed enum is a wire/schema change per new type; an open registry is a permanent contract about what a type id means.

Current state, verified in code at `595a3bda`:

- `ArtifactRef.uri` is an **absolute file path** (`packages/core/src/types/workbench.ts:31` — "doubles as the stable artifact URI in v0.1"). Host-specific, leaks filesystem layout onto the wire, and unusable as a durable relation endpoint across machines or in the hosted future (ADR-0013).
- `WorkbenchArtifactKind = 'corpus' | 'session-plan' | 'session-data'` (`workbench.ts:28`) — a closed enum that conflates **provenance** (where the scan found it) with **type** (what the content is). Everything is `.md`; the scan hard-filters other extensions (`artifacts.ts` `scanMarkdown`).
- Containment (`resolveContainedArtifact`, `artifacts.ts:241`) is sound for local single-user (verified in the PR #104 G1 review), but trusts **arbitrary absolute `corpusRoots`** from instance config — advisory **A1**: in the hosted multi-user model, whoever writes instance config chooses the trust boundary.
- `readArtifact` has **no extension policy** (advisory **A5**): the index surfaces only `.md`, but read serves any contained file. C1 deliberately opens types beyond `.md`, so "what may be read" must become an explicit decision, not an accident of the scan filter.

Constraints: additive-only schema evolution (ADR-0013 §4a discipline), `vorno:*` additive namespace (ADR-0012), the frozen `vorno:workbench:review:*` family and upstream wire contracts (compatibility.md), and ADR-0013's workspace-as-AuthZ-unit grain, which this ADR must not foreclose.

## Decision

### 1. Artifact URIs: `vorno-artifact://<rootId>/<relPath>`

An artifact's identity is its **location within a named root**, written as a URI:

```
vorno-artifact://workspace/sessions/260721-fresh-flint/plans/design.md
vorno-artifact://roadmap/decisions/0015-two-plane-artifact-surface-architecture.md
```

- **Scheme:** `vorno-artifact` (Vorno-owned; no collision with `file:`, MCP resource schemes, or the `craftagents://` deep-link scheme).
- **Authority = root id:** lowercase kebab `[a-z0-9-]{1,64}`. **`workspace` is reserved**, bound to the workspace root (covers `sessions/**` and any future workspace-level stores). All other roots are registered (see §2).
- **Path:** POSIX separators, percent-encoded per RFC 3986 where required, no `.`/`..` segments (parse-rejected), case-preserved. Relative to the root's bound directory.
- **Identity vs. version:** the URI names the *living* artifact. A snapshot is `ArtifactVersion { contentHash, gitSha? }`, carried as a **separate field** wherever versioning matters (threads, relations, stale badges) — never encoded in the URI. (A query/fragment version form, if ever wanted, is an additive extension.)
- Session provenance (`sessionId`, and via `SessionHeader` join: `projectId`, labels, status) is **derived index metadata**, not URI structure.

### 2. Root registry is the trust boundary (resolves A1)

Root bindings (`rootId → absolute path`) live in **workspace config**, never on the wire. The `vorno:artifacts:*` channel family carries only `vorno-artifact://` URIs — arbitrary absolute paths disappear from the artifact-plane wire surface. Zero-config default: the `workspace` root exists with no configuration (satisfying ADR-0015 §2 zero-config acquisition); additional roots (e.g. a repo's `roadmap/`) are the "advanced override" — registered once at workspace level, not per-instance. Resolution keeps the existing realpath + segment-guard containment against the *bound* root. In the hosted model, root registration inherits workspace-settings AuthZ at exactly the choke point ADR-0013 fixed — the grain is preserved, not foreclosed.

### 3. Open artifact-type registry

`WorkbenchArtifactKind` is replaced by two orthogonal fields on the generalized `ArtifactRef`:

- **`type: string`** — open lowercase-kebab id resolved by registered **type descriptors**: `{ id, displayName, extensions: string[], mimeType?, capabilities? }` (`mimeType` for MCP-resource/Apps alignment per ADR-0015 §4). C1 built-ins, registered in code: `markdown`, `json-canvas` (JSON Canvas v1.0), `json`, and `file` (fallback). Matching is by extension in C1; frontmatter contributes *metadata* (title, tags, ids), not type (a frontmatter type override is a possible additive later, not now).
- **`origin`** — provenance metadata (`session-plan` / `session-data` / `corpus` semantics survive here, joined with session context), no longer masquerading as type.

Registry contract (the permanent part):

- Type ids are **never repurposed or re-semanticized**; descriptors evolve additively.
- **Unknown ids are tolerated**: consumers render unknown types via the `file` fallback and must round-trip the id unmodified. This keeps the door open for workspace-level and DIR-02 skill-contributed types (C4) without another schema change.
- Relation-edge kinds (`derived-from`, `references`, `renders`, `discussed-in`, …) follow the **same open-string + additive discipline**.

### 4. Read policy (resolves A5)

`artifacts:read` serves a file only when **all** hold: (a) realpath containment in a registered root (as today), (b) the URI is **indexed or explicitly pinned** — index membership derives from registered type matchers, pinning is a deliberate user/agent act, and (c) a byte-size cap. Opening types beyond `.md` therefore widens reads only to what the registry declares plus explicit pins — never to "anything within a root."

### Non-doors (implementation, changeable later)

Store directory naming (parameterizing the `reviews/` literal), index caching strategy, relation storage layout (per-artifact file vs. store-side index), and the Artifact Home UI are two-way decisions inside PLAN-025 and are deliberately not fixed here.

### Migration / compatibility

- The frozen `vorno:workbench:review:*` family and `ReviewThreadV1` files (absolute-path `artifactUri`) stay valid: the plane resolves legacy absolute paths read-side by mapping through root bindings. No rewrite of existing thread files; no data loss (PLAN-025 acceptance).
- `vorno:artifacts:*` is a new additive family per ADR-0012, recorded in compatibility.md's vorno-surface section. No upstream contract touched.

## Doors — owner sign-off requested

1. **URI scheme string** `vorno-artifact://<rootId>/<relPath>` — permanent once written into stores, relations, and exports.
2. **Reserved root id `workspace` + root-binding indirection as the trust boundary** — the A1 resolution; wire payloads never carry absolute paths in the new family.
3. **Type ids as open kebab strings with never-repurpose + unknown-tolerated semantics; provenance demoted to metadata** — the contract future contributed types build on.
4. **Read gate = containment ∧ (indexed ∨ pinned) ∧ registered types** — the A5 resolution; deliberate policy for a plane that opens beyond `.md`.

## Consequences

### Positive

- URIs are host-independent: relations, exports (Obsidian vault keeps `relPath` structure), and the hosted future all work without path rewriting; A1's arbitrary-path trust hole is closed by construction in the new family.
- New artifact types (C2 surface specs, datasets, contributed types) are registry entries, not schema changes.
- Provenance/type split makes the zero-config index joinable with session context (project, labels, status) without fake "kinds."

### Negative

- Two URI vocabularies coexist during transition (legacy absolute paths in v1 review threads vs. new URIs); read-side mapping code carries that forever unless threads are ever migrated.
- Root registration adds one indirection users never see but debuggers must know (a URI is meaningless without the workspace's root bindings).

### Neutral

- `file` fallback rendering for unknown types means a contributed type degrades gracefully rather than erroring — watch that this doesn't hide misregistration.
- The shape is deliberately **OCI-artifact-packaging-compatible**: content-hash version identity + portable plain files, no live-server-resolved URIs (root bindings are workspace-local config) — keeps the door open for portable artifact/skill bundle packaging (fleet-spring `plans/bundle-standards-judgment.md`, R1 research).
- The registry API shape must anticipate DIR-02 contribution without building it (C4).

## Alternatives considered

- **Keep absolute-path URIs** — rejected: host-specific, forecloses hosted (A1), breaks export portability.
- **`file://` URIs** — rejected: same absolute-path problems with extra ceremony.
- **Content-addressed identity (hash-as-URI)** — rejected: artifacts are living files; identity is location, version is hash. CAS breaks "the plan I'm watching evolve" and makes relations churn on every edit.
- **UUID-per-artifact registry** — rejected: requires a registration write per artifact (violates zero-config acquisition) and makes a mapping DB load-bearing state; path identity is derivable from scan alone.
- **Extend the closed enum** — rejected: every new type is a wire/schema change; forecloses DIR-02 contributions.
- **MIME types as registry ids** — rejected as primary key (verbose in frontmatter/config, poor fit for role-flavored types like `json-canvas`); kept as an optional descriptor field for standards alignment.

## References

- ADR-0015 (two-plane architecture; owner rulings this executes), DIR-04, PLAN-025 (C1 scope), ADR-0014 (kernel being generalized), ADR-0013 (AuthZ grain + additive discipline), ADR-0012 (`vorno:*` namespace).
- PR #104 G1 review verdict (advisories A1–A6): session 260721-ivory-aspen `plans/pr104-review-workbench-verdict.md`.
- JSON Canvas v1.0 (jsoncanvas.org); MCP Apps SEP-1865 (mimeType alignment rationale).
