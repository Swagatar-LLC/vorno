---
id: ADR-0019
title: Storage-root config schema and provider-kind namespace
status: accepted
date: 2026-07-24
supersedes: []
superseded-by: []
---

# ADR-0019 — Storage-root config schema and provider-kind namespace

> **Design-before-build door ADR.** Drafted 2026-07-24 (session 260724-ready-shark) as the config/management/documentation design layer atop the ADR-0018 `StorageProvider` seam (PR #114, `jh/c2-storage-provider`, proposed). Depends on ADR-0018 being sealed (its two doors) before this is accepted. Refines — does not reverse — ADR-0018 (provider seam) and extends ADR-0016 §3 (open-string namespace reservation) to a fourth string space. **No second provider implementation is decided or built here** — this ADR only fixes the *forward-compatible config shape* that admits future provider kinds, and the surfaces that declare/manage/document them.

## Context

ADR-0018 gives the artifact plane a real seam: `resolveRootBindings` returns `Map<rootId, StorageProvider>`, `FilesystemStorageProvider` owns containment, and a serializable `StorageCapabilities` descriptor rides `roots:list`. The stated payoff (ADR-0018 §1, ADR-0016 Consequences, DIR-04 tenet 7): *"a future object-store backend is one new file behind the same map."*

But the **config surface still hard-codes filesystem**. Today:

- `artifactRoots?: Record<string, string>` (workspace settings + `WorkspaceSettings` DTO mirror) maps `rootId → absolute path string`. A bare string path *is* a filesystem assumption — there is nowhere to put a `kind` discriminator or kind-specific connection metadata.
- `resolveRootBindings` unconditionally constructs `FilesystemStorageProvider` for every configured entry. Adding a second kind would mean re-typing the config value at a settled, on-disk-persisted schema field — a migration once users have configs.
- The settings UI (`ArtifactRootsEditor`) is pick-a-folder-only and shows `rootId | path | remove`. It surfaces neither the new `capabilities` descriptor nor per-root health, and has no seam for a non-filesystem "add" flow.

If we ship object storage later without settling the config shape now, we take a config migration at exactly the trust boundary (root bindings) ADR-0016 §2 protects. This ADR settles the shape *before* the second provider exists — cheap now, expensive later. Governed the same way ADR-0018 chose a new ADR over a third ADR-0016 amendment (session 260724-fit-crane): the config-shape commitment is forward-compatibility-load-bearing and deserves its own acceptance record; ADR-0018's signed door text stays untouched.

## Decision

### 1. `artifactRoots` value widens in place to a tolerant union (migration-free)

The persisted map value becomes `string | RootBindingConfig`, where a bare `string` is the **filesystem shorthand** — read as `{ kind: 'filesystem', path: <string> }`. Existing configs parse unchanged; new configs may carry a discriminated-union object.

```ts
// packages/core/src/types/artifacts.ts
export interface FilesystemRootConfig {
  kind: 'filesystem';
  path: string; // absolute
}

/**
 * A configured (non-workspace) root binding, discriminated by `kind`. Open
 * string space (§2). Forward-tolerant: an unknown kind parses and is skipped
 * at resolution, never throws (mirrors the existing invalid-entry posture).
 * Secret-bearing kinds reference a vault key, never inline secrets (§4).
 */
export type RootBindingConfig =
  | FilesystemRootConfig
  | { kind: string; [k: string]: unknown };

/** Persisted map: rootId → binding. A `string` value = filesystem shorthand. */
export type ArtifactRootsConfig = Record<string, string | RootBindingConfig>;
```

`resolveRootBindings` normalizes each value (`string → {kind:'filesystem', path}`) and dispatches through a **provider factory** — the single registration point where a future kind plugs in (`case 'object-store': new ObjectStoreProvider(...)`), so adding a backend touches the factory only, not `roots.ts` control flow. Unknown/invalid kinds are skipped-and-logged, never thrown (the current tolerant behavior extends unchanged).

**Widen-in-place over a new sibling key** (`artifactRootBindings`): `artifactRoots` is fork-owned, pre-1.0, behind a default-off flag — no external contract binds its value shape — and a value-level union is genuinely additive (the old type is a subset). A second key would create a permanent dual source of truth for one concept. This is door 1.

### 2. Provider `kind` is a reserved open-string space (extends ADR-0016 §3)

`kind` joins type-ids, origin-kinds, and relation-kinds as an ADR-0016 §3 open string space under the **same** discipline: **un-prefixed values are reserved for system built-ins** (`filesystem`, and future `object-store`, `memory`); **third-party provider kinds require a registered prefix** (`<prefix>:<name>`, lowercase-kebab). Unknown kinds are tolerated and skipped at resolution (forward-compat), never re-semanticized. This is door 2.

### 3. Config declares *intent*; the provider remains the sole authority on *capability*

Root config names **what to bind** (`kind` + connection target) — it never asserts what the binding *can do*. `StorageCapabilities` continues to come from the provider at runtime (ADR-0018), surfaced on `roots:list`. A config may not grant a capability a provider lacks. This is an invariant restatement, not a new door — but it constrains the schema: no `capabilities` field on `RootBindingConfig`, ever.

### 4. Per-root health is surfaced additively; no inline secrets in config

- **Health/status** rides `roots:list` as a new **optional** field on each root entry: `status?: 'ok' | 'missing' | 'unreadable' | 'truncated'` (reusing the `ArtifactSkippedRoot.reason` vocabulary + `ok`), derived from a bounded root-level `provider.stat`/`exists` probe. Additive, ADR-0012-clean, one compatibility.md row, **no new channel**. Because a shipped wire field's semantics freeze (ADR-0016 discipline), the field *shape* is door 3 (small, but a commitment).
- **Secrets never live in `artifactRoots`.** The filesystem kind has no secret. Any future secret-bearing kind (object-store credentials) references a vault key resolved server-side via the ADR-0013 credential path — it does not carry inline secrets, and secrets never ride the REMOTE_ELIGIBLE wire. This ADR forbids the anti-shape now; the *actual* object-store credential mechanism is **out of scope here and gated on ADR-0013 / PLAN-023** (door 4 is a forward constraint, not an implementation).

## Doors — owner sign-off required (do not self-approve)

1. **`artifactRoots` value widens in place** to `string | RootBindingConfig` (tolerant union, `string` ≡ filesystem shorthand) — vs. a new `artifactRootBindings` sibling key. Forward-compat shape of an on-disk-persisted, trust-boundary config field.
2. **Provider `kind` becomes a reserved ADR-0016 §3 string space** — un-prefixed = system built-in, third-party kinds prefixed. Binds every future backend's naming.
3. **Per-root `status` field on `roots:list`** (additive, optional) — the wire shape for health; its semantics freeze on ship.
4. **Forward constraint (design-only here): no inline secrets in root config;** secret-bearing kinds reference the ADR-0013 vault and are gated on the hosted track. Accept the constraint now so no interim schema bakes in a plaintext-secret field.

> **Accepted 2026-07-24** (Jeff, session 260724-light-delta). All four doors above signed off. The dependency doors on ADR-0018 were signed the same day — pure-predicate admissibility; provider-owns-containment (no artifact-plane code path may obtain a raw physical path); hybrid capability negotiation on the REMOTE_ELIGIBLE wire. ADR-0018 to be flipped `proposed → accepted` on PR #114 to match; this ADR's acceptance is contingent on that seal, which is now signed.

## Consequences

### Positive

- The config surface matches the ADR-0018 runtime seam: a new provider kind is *one factory case + one `RootBindingConfig` variant*, no config migration.
- Zero migration for existing users — string paths keep working verbatim.
- The management UI gains the vocabulary (kind, capabilities, health) to represent non-filesystem roots without a later rewrite.
- The secret anti-shape is closed before any backend can introduce it.

### Negative

- One normalization layer (`string → {kind}`) at the config reader — a small always-on branch.
- `RootBindingConfig`'s open `{ kind: string; ... }` arm is intentionally loose; validation strictness lives in the per-kind factory, not the type.

### Neutral

- `roots:list` grows an optional field; compatibility.md records it alongside the ADR-0018 `capabilities` row.
- Overlapping/nested roots remain the config edge case ADR-0018 already noted (per-root enumeration; longest-match no longer applies).

## Alternatives considered

- **New `artifactRootBindings` sibling key, freeze `artifactRoots`** — rejected: permanent dual source of truth for one concept; the value union is already additive.
- **Amend ADR-0018 in place** — rejected: ADR-0018 is about to be sealed on #114; a separate ADR keeps its signed door text clean and gives the config-shape commitment its own record (the fit-crane new-ADR-over-amendment precedent).
- **Store `kind` in a parallel `Record<rootId, kind>` map** — rejected: splits one binding across two fields; invites drift between id-sets.
- **Let config assert capabilities** — rejected: violates ADR-0018's provider-is-authoritative invariant; a client could claim writes a read-only backend can't honor.

## References

- ADR-0018 (provider seam, pure admissibility, `StorageCapabilities`), ADR-0016 (§2 root-binding trust boundary, §3 open-string namespace reservation, §5 canonicalization), ADR-0013 / PLAN-023 (hosted AuthZ + client-owned vault), ADR-0012 (additive `vorno:*` + tolerate-absence), DIR-04 tenet 7 (storage separation).
- Design session: 260724-ready-shark (this ADR + PLAN-029, the three-surface design).
- Prior-art lineage: 260722-quick-sage `plans/artifact-storage-provider-design.md`; 260722-amber-quasar standards audit (GO).
