# Storage Roots & Providers

**Status:** Filesystem roots ship today (behind the `artifactsEnabled` workspace flag). Provider **kinds** beyond filesystem, capability/health surfacing, and the tagged config schema described below are **designed, not yet built** — see [ADR-0019](../roadmap/decisions/0019-storage-root-config-schema-and-capability-surfacing.md) (proposed) and [PLAN-029](../roadmap/plans/planned/PLAN-029-storage-provider-config-management-surfaces.md). This page documents the shipped behavior and the specced target so they agree; sections marked **_(planned)_** are not in a released build.
**Companion ADRs:** [ADR-0016](../roadmap/decisions/0016-artifact-uri-scheme-and-open-type-registry.md) (root-binding trust boundary), ADR-0018 (PR #114 — not yet on `main`) (StorageProvider seam — PR #114), [ADR-0019](../roadmap/decisions/0019-storage-root-config-schema-and-capability-surfacing.md) (config schema + capability surfacing).

This guide is for **using** storage roots — creating them, understanding what they mean, and managing them from Workspace Settings. If you are writing a new storage backend, read [Storage Provider Contract](storage-provider-contract.md) instead.

---

## 1. What a storage root is

A **storage root** is a named location the artifact plane is allowed to read. Every artifact in Vorno is addressed by a stable URI of the form:

```
vorno-artifact://<rootId>/<relPath>
```

- `rootId` — the name of a bound root (e.g. `workspace`, `corpus`, `notes`).
- `relPath` — the path of the artifact **inside** that root.

The root **is the trust boundary.** Vorno resolves a URI by joining `relPath` under the root's bound location and proving (via realpath + a segment guard) that the result still sits inside the root. Symlink escapes, `../` traversal, and sibling-prefix tricks (`/a/roots` masquerading as inside `/a/root`) are rejected by construction. Nothing outside a bound root is addressable as an artifact.

Two properties follow from ADR-0016 that matter to you as a user:

1. **Root locations never leave your machine.** The `rootId → location` map lives in workspace config. Absolute paths and backend endpoints are **never** put on the wire — a remote client sees `rootId`s, capabilities, and health, never a path or a secret.
2. **Identity is the URI; version is a content hash.** Renaming a root's on-disk folder is fine as long as the `rootId` binding is updated; the URIs are keyed by `rootId`, not by absolute path.

## 2. The `workspace` root (zero-config)

Every workspace always has one root, `workspace`, bound to the workspace directory. It exists with no configuration and cannot be removed or shadowed — a configured root that tries to reuse the id `workspace` is ignored. For most users this is the only root you need: plans, data, and corpus files under your workspace are already addressable.

Additional roots are an **advanced override** for pointing the plane at content that lives outside the workspace directory (a shared corpus folder, a synced notes vault, etc.).

## 3. Creating and managing roots (Workspace Settings)

Roots are managed in **Workspace Settings → Artifact Roots**, behind the `artifactsEnabled` flag.

### Filesystem root (available today)

1. Open **Workspace Settings → Artifact Roots**.
2. **Add root** → pick a directory. The picked absolute path becomes the root's binding.
3. Give the root an **id** (`rootId`): lowercase-kebab, e.g. `corpus`, `design-notes`. The id is what appears in every `vorno-artifact://<rootId>/…` URI, so choose a stable, meaningful name — it is not the folder name and does not change when the folder moves.

Rules enforced on save:

- `rootId` must match the id format and must not be the reserved `workspace`.
- A filesystem root's location must be an **absolute path**.
- Invalid entries are **skipped** (logged), never fatal — one bad root never breaks the others.

### Provider kinds beyond filesystem _(planned — ADR-0019)_

The config schema is being widened so a root can name a **provider kind**, not just a path. The shipped schema is a flat `rootId → absolute path` map; the planned schema is `rootId → RootConfig`, where `RootConfig` is **either** the legacy path string **or** a tagged object:

```jsonc
// Workspace config — artifactRoots (planned tagged form; string form stays legal forever)
{
  "artifactRoots": {
    "corpus": "/Users/you/corpus",                       // legacy string — read as { kind: "filesystem", path }
    "notes":  { "kind": "filesystem", "path": "/Users/you/notes", "label": "Design notes" },
    "archive": {                                          // RESERVED shape — no backend ships in PLAN-029
      "kind": "object-store",
      "bucket": "my-artifacts",
      "region": "us-east-1",
      "prefix": "vorno/",
      "credentialRef": "vault://archive-store",           // a reference, NEVER an inline secret
      "label": "Cold archive"
    }
  }
}
```

Key guarantees from ADR-0019 you can rely on:

- **Your existing config never breaks.** A bare-string value is always read as `{ kind: "filesystem", path }`. Configs written before this change stay valid **forever**; nothing is rewritten on disk.
- **Old clients still work.** The field is additive and tolerated-absent — a client that only understands the string form round-trips filesystem roots unchanged and simply ignores provider kinds it can't render.
- **Object-store (and other non-filesystem) kinds are _reserved shape only_ in PLAN-029.** The schema slot exists so the backend can land additively later, but there is **no resolver** for it yet — the plane **skips** an unsupported kind with a structured reason rather than failing. Object-store, presigned URLs, and credential resolution are gated on the hosted-workspace / vault work (ADR-0013 / PLAN-023).

## 4. Credentials: by reference, never inline _(planned — ADR-0019)_

Workspace config is plaintext — it may be committed, synced, or exported. Because of that, **a backend that needs credentials never stores them in config.** It stores a `credentialRef`: an opaque handle the server resolves through the vault / identity layer at runtime. There is no `accessKey`/`secret` field in the schema, and the settings validator **rejects** any inline-secret field. If you are configuring a credentialed backend, you point at a reference; the secret itself lives in the vault, not in `config.json`.

The vault resolution mechanism itself ships with ADR-0013 / PLAN-023; PLAN-029 only fixes the rule that credentials enter config **by reference**.

## 5. Capabilities & health readout _(planned — ADR-0019)_

Once the provider seam lands, each root in the editor shows two read-outs sourced from the provider, not from your config:

- **Capabilities** — what the backend can do (read-only vs write-capable, copy, presign). Read from the serializable `capabilities` descriptor on `roots:list` (ADR-0018). A remote client renders the same chips from the same descriptor.
- **Health / containment status** — `ok`, `unreachable`, or `misconfigured`, with a short reason. For a filesystem root this is a cheap `stat` of the bound location. The health payload carries **`rootId` + status + reason only** — **never** an absolute path or an endpoint secret (ADR-0016 §2). If a root's folder is deleted or a synced mount is offline, you see `unreachable` here instead of silent empty results.

## 6. Hosting roots for remote / multi-device access

Storage roots follow the workspace. When you reach a workspace remotely (WebUI, a thin desktop client attached to a hosted app-server), the artifact-management RPCs are remote-eligible, but the **root locations stay on the host** — the remote surface renders `rootId`, capabilities, and health from serializable descriptors, exactly so paths and secrets never cross the wire. There is nothing extra to configure for remote access beyond the workspace hosting itself; see [Hosted Workspace Architecture](hosted-workspace-architecture.md) and [WebUI Remote Access](webui-remote-access.md).

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A configured root doesn't appear | Invalid `rootId`, non-absolute path, or it reused the reserved id `workspace` | Check the id format (lowercase-kebab), use an absolute path, pick a different id |
| Root shows `unreachable` _(planned)_ | The bound folder was moved/deleted, or a synced mount is offline | Re-point the root at the current location, or bring the mount back |
| Root shows `misconfigured` _(planned)_ | A tagged config with a kind that has no resolver in this build | Expected for `object-store` today — that backend is not shipped yet |
| An artifact URI won't resolve | `relPath` escaped the root (symlink/`../`) or the root is unbound | Containment is enforced by design; the target must sit inside the bound root |

## See also

- [Storage Provider Contract](storage-provider-contract.md) — for authors writing a new backend.
- [ADR-0016](../roadmap/decisions/0016-artifact-uri-scheme-and-open-type-registry.md), ADR-0018 (PR #114 — not yet on `main`), [ADR-0019](../roadmap/decisions/0019-storage-root-config-schema-and-capability-surfacing.md) — the governing decisions.
