---
id: ADR-0019
title: Additive storage-root config schema and capability surfacing
status: proposed
date: 2026-07-24
supersedes: []
superseded-by: []
---

# ADR-0019 — Additive storage-root config schema and capability surfacing

> **Door ADR (design-before-build; PLAN-029).** Drafted 2026-07-24 (session 260724-brave-falcon) as the *config / management / documentation* layer over the ADR-0018 `StorageProvider` seam. **This ADR does NOT reopen or re-decide ADR-0018's two doors** (admissibility predicate; provider-owns-containment) — it presumes them and governs only how a user *declares* roots/providers and how the plane *surfaces* provider capability + health. Two new doors below need owner sign-off before build. **No second provider implementation is in scope** (that stays gated on ADR-0013 / PLAN-023 per ADR-0017 §6). Status stays `proposed` until the owner signs at PR review, ADR-0013/0018-style.
>
> **Dependency note:** ADR-0018 is `proposed` on PR #114 (unmerged as of 2026-07-24). This ADR is written *against* that seam; its build lands after #114 merges. If #114's non-door details (e.g. the `StorageCapabilities` field list) shift before merge, §3 here follows them — those are ADR-0018 non-doors, not ADR-0019 doors.

## Context

ADR-0016 §2 made root bindings (`rootId → absolute path`) the artifact-plane trust boundary and kept them in **workspace config, never on the wire**. ADR-0018 replaces the per-consumer `fs.*` access with a `StorageProvider` seam (`resolveRootBindings → Map<rootId, StorageProvider>`) and adds a serializable `StorageCapabilities` descriptor surfaced additively on `roots:list`. ADR-0017 §6 / DIR-04 tenet 7 commit to **storage separation** — object storage with identity-federated AuthZ behind that seam — as a stated goal.

But the *config shape that feeds the seam is still flat and filesystem-only*, verified in code at both C1 (main) and on the ADR-0018 branch:

- `WorkspaceSettings.artifactRoots?: Record<string, string>` (`packages/shared/src/protocol/dto.ts`, `packages/shared/src/workspaces/types.ts`) — a bare `rootId → absolute path` map. It rides `workspaceSettings:get` / `workspaceSettings:update` (a persisted DTO on an existing wire channel).
- `resolveRootBindings(workspaceRootPath, configuredRoots?: Record<string, string>)` (ADR-0018 branch `roots.ts`) constructs a `FilesystemStorageProvider` per entry — it swaps the *provider* but **leaves the config schema unchanged**: every value is an absolute path, every root is filesystem.
- The settings handler (`packages/server-core/src/handlers/rpc/settings.ts`) validates `artifactRoots` as `object map of rootId → absolute path` and rejects anything else.
- The settings UI (`WorkspaceSettingsPage.tsx` → `ArtifactRootsEditor`) is a pick-a-directory-first editor with no concept of provider kind, capability, or health.

So the moment a second backend exists (object-store), `Record<string, string>` cannot express it: an object-store root needs a `kind`, a bucket/endpoint/region, and a **credential reference** — none of which fit "absolute path string." Reshaping the persisted `artifactRoots` DTO later is a migration event and a wire-compatibility risk. The additive shape, the namespace for provider kinds, and how credentials are referenced (never inlined) are **one-way decisions about persisted user config** — they belong in an ADR, decided before the schema is first widened, not retrofitted.

Constraints inherited (not re-decided here): additive-only DTO evolution and tolerated-absent (ADR-0012 / ADR-0013 §4a); root bindings never carry absolute paths on the `vorno:artifacts:*` wire (ADR-0016 §2); the frozen `vorno:workbench:review:*` family and upstream contracts (compatibility.md); ADR-0016's namespace reservation over open string spaces (un-prefixed = system, contributed = `<prefix>:<name>`); ADR-0018's provider-owns-containment and pure-admissibility doors.

## Decision

### 1. `artifactRoots` evolves to a tagged form; the string form stays valid forever

The persisted `artifactRoots` value widens from `Record<string, string>` to `Record<string, RootConfig>` where `RootConfig` is **either** the legacy string **or** a tagged object:

```ts
// packages/core/src/types/artifacts.ts (new)
export type RootConfig =
  | string                              // legacy: absolute path, coerced to { kind: 'filesystem', path }
  | FilesystemRootConfig
  | ObjectStoreRootConfig               // reserved shape; NO provider impl in PLAN-029

export interface FilesystemRootConfig {
  kind: 'filesystem'
  path: string                          // absolute
  label?: string                        // optional human label for the management UI
}

export interface ObjectStoreRootConfig {   // shape reserved now so adding the backend later is additive
  kind: 'object-store'
  bucket: string
  endpoint?: string
  region?: string
  prefix?: string                       // key prefix = the containment root (ADR-0018 §2, object-store address space)
  credentialRef?: string                // opaque handle resolved via the vault/identity layer — NEVER an inline secret
  label?: string
}
```

- **Read-side coercion is the migration.** A bare string value is read as `{ kind: 'filesystem', path: <string> }`. No file rewrite, no data loss; every config written before PLAN-029 stays valid indefinitely. New writes from the updated UI use the tagged object form; the string form remains a legal input forever.
- The DTO change is **additive and tolerated-absent** exactly like `workbenchEnabled` / `artifactsEnabled` before it — an old renderer or an upstream-compatible peer that only understands `Record<string,string>` still round-trips filesystem roots unchanged, and simply ignores object-store entries it cannot render (feature detection, ADR-0012 §3).
- `resolveRootBindings` gains a `kind` switch: `filesystem` → `FilesystemStorageProvider` (as ADR-0018 built); unknown/unsupported `kind` → **skipped with a structured `skippedRoots` reason** (never thrown), same tolerate-absence posture the C1 resolver already uses for invalid entries.

### 2. Provider `kind` and credentials: namespace-reserved kinds, credential *references* only (never inline secrets)

- **Provider `kind` follows ADR-0016's namespace reservation.** Un-prefixed kinds are **reserved for system backends** (`filesystem`, and `object-store` when it ships). A third-party/contributed backend kind requires a registered prefix (`<prefix>:<name>`, lowercase-kebab). This extends the ADR-0016 reservation to a new open string space (provider kinds) — stated here so the first non-system backend does not need another schema decision.
- **Config never holds an inline secret.** Any backend needing credentials declares a `credentialRef` — an opaque handle the server resolves through the vault / identity-federation layer (ADR-0013). Workspace config (`config.json`) is plaintext and may be committed, synced, or exported; a secret in it is a leak. Reserving `credentialRef` (not `accessKey`/`secret`) in the schema **now** is what keeps adding the object-store backend additive instead of a reshape — even though PLAN-029 implements no resolver. The vault resolution mechanism itself is **out of scope** and lands with ADR-0013 / PLAN-023; PLAN-029 only fixes that credentials enter config *by reference*.

### 3. Management surface consumes ADR-0018's descriptor; health/containment is additive wire, not a new door

- The settings UI reads `StorageCapabilities` from the **existing ADR-0018 `roots:list.capabilities`** payload and renders per-root capability affordances (read-only vs write-capable, presign, etc.). This is pure consumption of an ADR-0018 door output — **not a new door.**
- **Health / containment status** (is the bound root reachable? does containment hold? is the provider mis-configured?) is surfaced as an **additive** `vorno:artifacts:roots:health` channel (or an additive `health` field on `roots:list` — a two-way, non-door choice for PLAN-029). Additive `vorno:*` wire surface is already licensed by ADR-0012 and needs no ADR of its own; it is recorded in compatibility.md's vorno-surface section at build time. Health payloads obey ADR-0016 §2: **rootId + status + reason only, never an absolute path or endpoint secret.**
- Remote-eligibility is inherited unchanged: config lives where the workspace lives; management RPCs are REMOTE_ELIGIBLE like the rest of `vorno:artifacts:*`. A remote client renders capability/health from the serializable descriptor — the exact reason ADR-0018 made capabilities serializable.

### Non-doors (two-way, changeable inside PLAN-029)

The exact `RootConfig` field names beyond `kind`, whether health rides `roots:list` vs its own channel, the health status enum, the management-UI component layout, the `label` field's presence, and the coercion helper's location. `StorageCapabilities`'s field list is an **ADR-0018 non-door** (followed, not fixed here).

### Migration / compatibility

- `artifactRoots` string→tagged widening is additive and read-coerced; no existing config is rewritten (PLAN-029 acceptance). The `workspaceSettings:*` DTO gains a union member on an already-optional field — an upstream-compatible peer tolerating absence tolerates the widening.
- The new `vorno:artifacts:roots:health` channel (if taken) is additive under ADR-0012; recorded in compatibility.md. No upstream contract touched; the frozen `vorno:workbench:review:*` family untouched.

## Doors — owner sign-off requested

1. **`artifactRoots` widens from `Record<string,string>` to `Record<string,RootConfig>` (string ∪ tagged object), string form coerced to `filesystem` and legal forever.** This is a permanent shape of persisted user config and a widening of a wire DTO field; once users write tagged configs, the union is load-bearing indefinitely.
2. **Credentials enter root config only by `credentialRef` (resolved via the ADR-0013 vault/identity layer), never inline; provider `kind` follows the ADR-0016 namespace reservation (un-prefixed = system, contributed = `<prefix>:<name>`).** This fixes the security boundary and the extensibility contract for every future backend, and reserves the schema slots now so the object-store backend is additive.

## Consequences

### Positive

- The object-store backend (and any future provider) becomes a `resolveRootBindings` case + a config variant — no DTO reshape, no migration event, no settings-UI rewrite.
- Secrets are structurally kept out of committable/exportable config by the schema, before any backend can tempt an inline key.
- The management surface gets real capability/health affordances from data ADR-0018 already puts on the wire — no new plane state.

### Negative

- Two config spellings for filesystem roots coexist forever (bare string vs `{ kind: 'filesystem', path }`); the read-coercion helper carries that indefinitely (cheap, one function).
- Reserving `object-store` / `credentialRef` shape before implementing them risks the shape being slightly wrong when the backend lands — mitigated by keeping the object-store variant a *reserved, unresolved* shape (skipped by the resolver) until PLAN-023.

### Neutral

- A health channel is new observable surface; watch that health probes for object-store roots (future) don't become a rate/cost problem — filesystem health is cheap (stat the root).
- The `label` field is optional UI sugar; it never affects identity (URIs are `rootId`-keyed, ADR-0016 §1).

## Alternatives considered

- **Keep `Record<string,string>`, encode kind in a sentinel path (e.g. `s3://…`)** — rejected: overloads "absolute path" semantics the containment invariant (ADR-0018 §2) and the settings validator both depend on; a URL-shaped string is not an absolute path and would need special-casing at every call site.
- **A parallel `artifactProviders` setting beside `artifactRoots`** — rejected: splits one concept (a root *is* a bound provider) across two settings, and forces every consumer to join them; the tagged-union widening keeps root identity and provider config co-located.
- **Amend ADR-0018 in place** — rejected: ADR-0018 governs the *provider interface / access layer*; the *persisted config schema + credential-reference security boundary* is a distinct one-way decision on a different surface (the settings DTO, the vault seam). Same reasoning ADR-0018 used to be a new ADR rather than an ADR-0016 amendment. A separate 0019 keeps ADR-0018's proposed text unedited and gives this door its own acceptance record.
- **Inline credentials with at-rest encryption of `config.json`** — rejected: config is meant to be human-readable, diffable, and exportable (Obsidian projection, future bundles per ADR-0017); encrypting it fights that, and credential-by-reference is the ADR-0013 direction regardless.

## References

- ADR-0018 (StorageProvider seam, admissibility predicate — the layer this configures/surfaces), ADR-0016 (root-binding trust boundary §2, namespace reservation §3, no-paths-on-wire), ADR-0017 §6 (storage-separation sequencing), ADR-0013 / PLAN-023 (vault / identity federation — where `credentialRef` resolves), ADR-0012 (additive `vorno:*` wire), DIR-04 tenet 7.
- Design session: 260724-brave-falcon (this ADR + PLAN-029, three-surface design).
- Prior design input: 260722-quick-sage `plans/artifact-storage-provider-design.md` (§6 open questions on provider seam), 260722-amber-quasar standards audit (GO).
