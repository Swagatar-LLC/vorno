# Storage Provider Contract

**Status:** Design contract for future backend authors. The `StorageProvider` seam is specced in ADR-0018 (PR #114 — not yet on `main`) (proposed, PR #114) and configured/surfaced by [ADR-0019](../roadmap/decisions/0019-storage-root-config-schema-and-capability-surfacing.md) (proposed, PLAN-029). **No second provider ships in this line of work** — the object-store backend and its capabilities are gated on ADR-0013 / PLAN-023. Today the only provider is `filesystem`. This document is the contract you implement when that gate opens. It mirrors into `packages/shared/src/artifacts/storage/README.md` when the seam lands on `main`.
**Read first:** [ADR-0016](../roadmap/decisions/0016-artifact-uri-scheme-and-open-type-registry.md) (URI scheme, root-binding trust boundary), ADR-0018 (PR #114 — not yet on `main`) (this seam), [ADR-0019](../roadmap/decisions/0019-storage-root-config-schema-and-capability-surfacing.md) (config schema). User-facing companion: [Storage Roots & Providers](storage-roots.md).

---

## 1. The seam

A **root binding** resolves a `rootId` to a `StorageProvider`. Before ADR-0018, every consumer called `fs.*` directly and containment logic was realpath-specific. The seam replaces that: `resolveRootBindings` returns a `Map<rootId, StorageProvider>`, and every read/list/containment check goes through the provider. This is what lets a non-filesystem backend (object storage) drop in **without** touching consumers.

```mermaid
graph LR
  Cfg["artifactRoots<br/>Record&lt;string, RootConfig&gt;"] -->|coerce string→fs<br/>kind switch| Resolve["resolveRootBindings"]
  Resolve -->|filesystem| FS["FilesystemStorageProvider"]
  Resolve -->|object-store<br/>(future)| OS["ObjectStoreStorageProvider"]
  Resolve -->|unsupported kind| Skip["skippedRoots reason"]
  FS --> Gate["isAdmissible (pure)"]
  FS --> Contain["containment (provider-owned)"]
```

The provider owns two things consumers used to do by hand:

1. **Containment** — resolving a `relPath` under the root and proving the result stays inside it. The provider owns this because the invariant is address-space-specific (§3).
2. **Capability advertisement** — a serializable descriptor saying what the backend can do, surfaced additively on `roots:list` so remote clients render affordances without reaching the backend.

## 2. Core contract — `StorageProvider`

Every provider implements the minimal core. These are the operations the artifact plane needs to index, read, and address artifacts. The shape follows the ADR-0018 design (field names are ADR-0018 non-doors and may shift before the seam merges — implement against the merged `storage/provider.ts`, this is the contract's intent):

```ts
export interface StorageProvider {
  /** Provider kind. Un-prefixed = system built-in (`filesystem`, `object-store`);
   *  contributed backends require a registered prefix `<prefix>:<name>` (ADR-0016 §3,
   *  extended to provider kinds by ADR-0019 §2). */
  readonly kind: string;

  /** Serializable capability descriptor. MUST be JSON-safe — it rides `roots:list`
   *  to remote clients (ADR-0018). No functions, no handles. */
  readonly capabilities: StorageCapabilities;

  /** Does an artifact exist at this URI, within containment? */
  exists(uri: string): Promise<boolean>;

  /** Metadata (size, mtime, content hash) without reading the body. */
  stat(uri: string): Promise<ArtifactStat>;

  /** Read the artifact bytes/text at this URI, within containment. */
  read(uri: string): Promise<ArtifactContent>;

  /** Enumerate artifact URIs contained by this root (bounded by GLOBAL_FILE_CAP). */
  list(): Promise<string[]>;
}
```

- **`capabilities` must be serializable.** This is load-bearing: `roots:list` is `REMOTE_ELIGIBLE`, so a remote client renders capability chips from this descriptor alone. If a capability needs a live handle to answer, it does not belong in the descriptor.
- **Every method takes/returns URIs or serializable data — never absolute paths on the wire.** Paths are an internal detail of the filesystem provider (ADR-0016 §2, door 2). An object-store provider deals in keys, not paths, and neither leaks past the provider.

## 3. Optional capability interfaces

Beyond the core, capabilities are **opt-in interfaces** discovered by type guard — the Go `io/fs` pattern. A consumer that wants to write checks `isWriteCapable(provider)` before calling; a read-only backend simply doesn't implement it. This keeps the core minimal and lets each backend advertise exactly what it supports.

```ts
export interface WriteCapable {
  write(uri: string, content: ArtifactContent): Promise<void>;
  remove(uri: string): Promise<void>;
}

export interface CopyCapable {
  /** Server-side copy within/across roots this provider serves. */
  copy(fromUri: string, toUri: string): Promise<void>;
}

export interface PresignCapable {
  /** A time-bounded, direct-access URL (e.g. S3 presigned GET/PUT). */
  presign(uri: string, op: 'get' | 'put', ttlSeconds: number): Promise<string>;
}

// Discovery — narrow before calling. Never assume; always guard.
export function isWriteCapable(p: StorageProvider): p is StorageProvider & WriteCapable {
  return typeof (p as Partial<WriteCapable>).write === 'function';
}
export function isCopyCapable(p: StorageProvider): p is StorageProvider & CopyCapable {
  return typeof (p as Partial<CopyCapable>).copy === 'function';
}
export function isPresignCapable(p: StorageProvider): p is StorageProvider & PresignCapable {
  return typeof (p as Partial<PresignCapable>).presign === 'function';
}
```

The `capabilities` descriptor (§2) is the **serializable mirror** of which optional interfaces a provider implements, so a remote client sees the same capability set the server computes from the type guards. Keep the two in sync: if you implement `WriteCapable`, set the corresponding flag in `capabilities`.

## 4. The containment invariant (storage-agnostic)

**Every provider must enforce that a resolved artifact stays inside its root.** The invariant is the *same predicate* expressed in two address spaces:

- **Filesystem** — realpath the root and the target, then require `realTarget === realRoot` **or** `realTarget.startsWith(realRoot + sep)`. The trailing-separator guard is what stops `/a/roots` from being treated as inside `/a/root`. Realpathing both sides catches symlink escapes and `../` dot-collapse. (This is the check `FilesystemStorageProvider` carries over from the C1 `roots.ts` `isInside` helper.)
- **Object store** — the key `prefix` **is** the containment root. Require the resolved key to equal the prefix or start with `prefix + delimiter` — the exact-prefix + trailing-delimiter form, the object-store analogue of the filesystem `startsWith(root + sep)` check.

Both reduce to: **the target's normalized address equals the root's address or begins with it followed by the boundary delimiter.** A provider that cannot enforce this invariant for its address space is not a valid artifact backend. Containment is **provider-owned** (ADR-0018 door) precisely because the delimiter and normalization differ per address space; consumers never re-implement it.

## 5. The pure `isAdmissible` precondition

Admissibility — "is this URI one the plane may serve at all?" — is a **pure predicate**, separated from I/O by ADR-0018:

```ts
// admissibility.ts — pure, no I/O, no async.
export function isAdmissible(uri: string, roots: Set<string>): boolean
```

Rules a provider (and every consumer) must respect:

- **Input is a canonical URI.** Callers canonicalize (ADR-0016 §5: RFC 3986 §6.2.2 normalization, `sha256:<lowerchex>` content-hash form) **before** the gate. `isAdmissible` does **no** normalization of its own and performs **no** I/O — same input, same answer, always.
- **The gate ≡ the scan surface by construction.** The shape constants that decide admissibility are shared with the index scanner, so a URI is readable **iff** it would be indexed. This is what closed the C1-era read-vs-export divergence (SEC-1): read and Obsidian export go through the *one* gate.
- **`GLOBAL_FILE_CAP` is a listing bound, never a read gate (SEC-2 / PERF-1).** The cap limits how many entries `list()` returns; it must **not** gate `read()`. A file beyond the cap tail is still readable if admissible — never make readability depend on scan order or on re-walking the whole root per read.

Put plainly: **decide admissibility with a pure function on a canonical URI; do I/O only after it passes; never let a volume cap become a security boundary.**

## 6. Registering a new provider

When the gate opens (ADR-0013 / PLAN-023) and you add a backend:

1. **Pick a `kind`.** System backends use un-prefixed kinds (`filesystem`, `object-store`). A third-party backend requires a registered prefix: `<prefix>:<name>`, lowercase-kebab (ADR-0016 namespace reservation, extended to provider kinds by ADR-0019 §2).
2. **Add the `RootConfig` variant** (ADR-0019 §1) — a tagged object with your `kind` and its fields. Credentials enter **only** as a `credentialRef` resolved via the vault (ADR-0019 §2); no inline secrets — the settings validator rejects them.
3. **Implement the core `StorageProvider`** + whichever optional interfaces apply, with a JSON-safe `capabilities` descriptor.
4. **Enforce the containment invariant** (§4) for your address space.
5. **Wire a `resolveRootBindings` case** for your `kind`. An unsupported/partial kind must **skip with a `skippedRoots` reason, never throw** (the tolerate-absence posture the C1 resolver already uses).
6. **Health** — if your backend can be unreachable/misconfigured, report it through the additive `roots:health` surface as `rootId + status + reason` only — **never** a path, endpoint, or secret (ADR-0016 §2).

## 7. Invariants checklist

- [ ] `kind` is namespace-correct (un-prefixed = system; contributed = `<prefix>:<name>`).
- [ ] `capabilities` is JSON-serializable and mirrors the implemented optional interfaces.
- [ ] No absolute path / key / endpoint / secret ever leaves the provider on the wire.
- [ ] Containment enforced for the address space (§4); consumers never re-implement it.
- [ ] `isAdmissible` treated as pure, canonical-URI-in, no I/O; gate ≡ scan surface.
- [ ] `GLOBAL_FILE_CAP` bounds `list()` only, never `read()`.
- [ ] Credentials by `credentialRef` only; unsupported/partial kind skips with a reason, never throws.

## See also

- [Storage Roots & Providers](storage-roots.md) — user-facing companion (creating/hosting/managing roots).
- [ADR-0016](../roadmap/decisions/0016-artifact-uri-scheme-and-open-type-registry.md) · ADR-0018 (PR #114 — not yet on `main`) · [ADR-0019](../roadmap/decisions/0019-storage-root-config-schema-and-capability-surfacing.md)
