---
id: ADR-0018
title: Artifact storage-provider seam and pure admissibility predicate
status: proposed
date: 2026-07-24
supersedes: []
superseded-by: []
---

# ADR-0018 — Artifact storage-provider seam and pure admissibility predicate

> **Door ADR (C2 gate).** Drafted 2026-07-24 (session 260724-fit-crane) from the quick-sage design doc (260722-quick-sage `plans/artifact-storage-provider-design.md`) and the amber-quasar standards audit (GO, 260722-amber-quasar `plans/standards-validation-report.md`). Refines — does not reverse — ADR-0016 door 4 and reconciles ADR-0017 §6 sequencing. The owner dispatched the C2 build against this ADR on 2026-07-24 (session 260724-mild-torrent); formal sign-off of the two doors below is recorded at PR review, ADR-0013-style (proposed-in-PR, acceptance sealed on merge).

## Context

The C1 artifact plane merged to main in PR #106 (`e8b2fa41`, 2026-07-24). The owner-requested pattern review (session 260722-quick-sage, at PR head `2090a5c5`) found the identity layer sound but the access layer not ready for the storage separation ADR-0016/0017 committed to:

- **ARCH-1** — `RootBinding` is a type tag, not a provider seam: `resolveArtifactPath` returns a raw absolute path and every consumer (`read.ts`, `scan.ts`, `projection-obsidian.ts`, `content.ts`) calls `fs.*` directly; containment is realpath-specific and re-implemented per call site.
- **SEC-1** — the admissibility gate is duplicated and diverged: `read` gates on index membership, `exportObsidianVault` gates on extension only — a latent read-gate bypass (export is currently unwired to any channel/UI, so latent, not live).
- **SEC-2** — admissibility is scan-order-dependent under `GLOBAL_FILE_CAP`: whether a file is readable depends on how many siblings sorted ahead of it in a capped walk.
- **PERF-1** — every read re-walks the whole workspace to establish membership.

The design doc's remedy — a minimal-core `StorageProvider` interface with optional capability interfaces and a serializable capability descriptor, a storage-agnostic containment contract, and a pure `isAdmissible` predicate — follows the convergent prior art (Apache OpenDAL, Commons VFS, Java NIO.2 `FileSystemProvider`, Go `io/fs`, OCI/CAS) and passed a standards-conformance audit (RFC 3986/7595/6838/9110/9530, OCI digests, WHATWG URL, JSON Canvas 1.0) with **GO** and nothing reopening ADR-0016's doors. The two code-level audit fixes (URI canonicalization at ingest; C0/DEL rejection) already landed pre-merge (`336b4412`) and are recorded in ADR-0016 §5.

Why a new ADR rather than a third ADR-0016 amendment: the change (a) alters runtime behavior at the signed door-4 security boundary, which deserves its own acceptance record; and (b) revises ADR-0017 §6's sequencing (provider design was slated for the hosted-workspace track; the SEC-1/ARCH-1 findings pull the *interface* forward into C2), which an in-place 0016 amendment cannot carry. ADR-0016 §4 and ADR-0017 §6 are refined by reference from here; their signed text is not edited.

## Decision

### 1. `StorageProvider` is the only path from a URI to bytes

A provider interface (minimal required core + optional capability interfaces, per Go `io/fs`) replaces direct `fs.*` access in the artifact plane:

- **Core** (every backend): `stat(uri)`, `read(uri, opts)`, `list(opts)` (lazy, files-only), `exists(uri)` — plus `kind` and a **serializable** `StorageCapabilities` descriptor.
- **Optional capabilities**: `WriteCapable`, `CopyCapable`, `PresignCapable` — type-guarded in-process (`isWriteCapable(p)`), declared on the wire via the descriptor. C2 ships these as **interfaces only, no implementations** (the plane stays read-only until a plan needs writes).
- **No method returns a raw filesystem path.** The realpath + segment-guard logic in `roots.ts` moves *inside* `FilesystemStorageProvider`; `resolveArtifactPath` and `absPathToUri` stop being public. This is the ARCH-1 fix — the seam can no longer leak.
- `resolveRootBindings` returns `Map<rootId, StorageProvider>`. C2 registers only `FilesystemStorageProvider`. A future object-store backend is one new file behind the same map; `read`/`scan`/`export` do not change.
- **Capability negotiation is hybrid**: type guards in-process, the serializable descriptor on the wire — required because `vorno:artifacts:*` is REMOTE_ELIGIBLE and a remote client cannot type-assert a server-side provider. `roots:list` gains `capabilities` in its payload (additive, ADR-0012-clean).

### 2. The containment contract is storage-agnostic

Stated once, normatively: a provider MUST NOT produce a physical location, read, or capability grant without (1) pure-string canonicalization that **rejects** `.`/`..`/absolute/scheme-or-drive segments (already enforced by `parseArtifactUri`, the sole admission gate per ADR-0016 §5); (2) composing against a root boundary that **ends in the separator**; (3) verifying the composed location is inside the canonical root. Filesystem: `realpath(target).startsWith(realpath(root) + '/')` (defeats symlink escape). Object store (future): exact-prefix-plus-trailing-delimiter over keys (`P/` never matches `P-evil/`). Same predicate, two address spaces.

### 3. Admissibility becomes a pure predicate (refines ADR-0016 door 4)

`isAdmissible(uri, providers, pinned)` — readable iff **bound root ∧ (indexed location-shape ∧ registered extension, ∨ pinned)** — a pure function of the canonical URI; containment and the size cap are enforced by the provider at read time. "**Indexed**" is redefined from *surfaced-by-a-capped-scan* to the **scan's shape predicate**: for the `workspace` root, `sessions/<id>/(plans|data)/**` within the session depth cap; for a configured root, anywhere within the corpus depth cap; skipped dir names (`node_modules`, `.git`, dot-dirs) exclude at any level. The shape constants are shared between the gate and the scanner, so gate ≡ scan surface by construction.

- ADR-0016 door 4's formula — containment ∧ (indexed ∨ pinned) ∧ registered types — is **unchanged**. What changes is that "indexed" no longer inherits accidental *volume-bound* dependence: `GLOBAL_FILE_CAP` becomes a **listing bound only** and never gates readability (kills SEC-2), a valid file is never unreadable because 2000 siblings sorted ahead of it, and no read re-walks the workspace (kills PERF-1). Deterministic shape bounds (depth caps, skipped dir names) remain part of "indexed" — the widening relative to shipped behavior is exactly the volume-cap tail, nothing else.
- Both `read` and `exportObsidianVault` (and any future consumer) call this one predicate — the gate cannot diverge again (kills SEC-1).
- Precondition: URIs are canonical (`canonicalizeArtifactUri` at every ingest, per ADR-0016 §5); `isAdmissible` itself never normalizes.

### 4. Sequencing reconciliation with ADR-0017 §6

ADR-0017 §6 sequenced storage-provider *design* with the hosted-workspace track. This ADR pulls the **interface and the filesystem implementation** into C2, security-driven (SEC-1/SEC-2 + ARCH-1 consolidation of logic that already exists). The **object-store backend, presign implementation, and identity-federated AuthZ** remain gated on ADR-0013 / PLAN-023 exactly as ADR-0017 sequenced. Nothing about the hosted design is decided here.

### Non-doors (two-way, changeable inside C2)

Exact interface member names and the `Result<T>`/`StorageError` error-shape, the capability-descriptor field list, `ArtifactMeta` field set (beyond `contentHash` semantics fixed in ADR-0016 §5), the review-workbench's own scan/containment consolidation (frozen wire; separate two-way refactor), and OpenDAL-style layer decorators (deferred).

## Doors — owner sign-off at PR review

1. **Admissibility-predicate redefinition** — "indexed" = pure shape predicate (location shape ∧ registered extension); `GLOBAL_FILE_CAP` demoted to a listing bound that never gates reads. This is a behavior change at the signed read-gate boundary: files inside indexed locations that a *full* capped scan previously missed become readable (correct per door 4's intent, but a real widening relative to shipped behavior).
2. **Provider-owns-containment contract** — no artifact-plane code path may obtain a raw physical path; all I/O and containment live behind `StorageProvider`, with the serializable-capability hybrid on the REMOTE_ELIGIBLE wire. This constrains every future backend and C2/C3 consumer.

## Consequences

### Positive

- SEC-1, SEC-2, PERF-1, ARCH-1 closed by construction; one gate, one containment implementation, no per-read workspace walk.
- The storage-separation goal (ADR-0016 Consequences, ADR-0017 §6, DIR-04 tenet 7) gets its real seam: an object-store backend becomes one file, not a six-module edit.
- Net LOC roughly flat — this is deletion-and-consolidation (the duplicated gate and full-scan membership go away).

### Negative

- One indirection layer over what is today direct `fs.*` — debuggers must know reads route through a provider.
- The read-widening in door 1 (volume cap no longer hides admissible files) must be called out in the C2 PR for review as a deliberate change, not a regression.

### Neutral

- `WriteCapable`/`CopyCapable`/`PresignCapable` exist as unimplemented interfaces — watch that nothing implements them without a plan.
- The capability descriptor rides `roots:list` additively; compatibility.md's vorno-surface section records it.
- With per-root enumeration, a configured root nested inside the workspace scan surface yields its own URIs (previously the longest-matching root won via `absPathToUri`); overlapping roots are a config edge case, noted here for the record.
- Pre-existing residual (not changed here): a `LIFECYCLE_SET` pin admits any contained URI regardless of shape/extension — ADR-0016 door 4's deliberate escape hatch. SEC-1's closure is specifically the read-vs-export divergence; the pin surface remains gated by containment only.

## Alternatives considered

- **Amend ADR-0016 in place (quick-sage's lean)** — rejected: a third amendment band inside a signed 13.8K door ADR, editing around door-4 language at a security boundary, and unable to carry the ADR-0017 sequencing revision; pointers from 0016/0017 to a focused 0018 read cleaner and keep signed text untouched.
- **Status quo (type-tag `RootBinding`, per-consumer `fs.*`)** — rejected: leaves SEC-1's latent bypass and SEC-2's scan-order gate live, and makes every future backend a multi-module edit — the opposite of what 0016/0017 promised.
- **Pure-descriptor capability model (no type guards)** — rejected: in-process callers lose type narrowing for no wire benefit; the hybrid costs one guard function per capability.
- **jclouds-style throw-if-unsupported** — rejected: the anti-pattern the prior art warns against; callers must be able to ask before calling.

## References

- Design: 260722-quick-sage `plans/artifact-storage-provider-design.md` (findings ARCH-1/SEC-1/SEC-2/PERF-1; prior-art survey).
- Standards audit (GO): 260722-amber-quasar `plans/standards-validation-report.md`; landed fixes `336b4412`; ADR-0016 §5.
- ADR-0016 (doors, §4 read policy, §5 canonicalization), ADR-0017 (§6 storage separation), ADR-0013/PLAN-023 (hosted track), ADR-0012 (additive wire), DIR-04.
- Prior art: Apache OpenDAL, Apache Commons VFS, Java NIO.2 `FileSystemProvider`, Go `io/fs`, OCI/CAS, S3 prefix+delimiter containment.
