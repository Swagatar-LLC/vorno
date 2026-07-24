/**
 * Artifact plane types — the generalized workspace artifact plane (ADR-0016,
 * ADR-0015 / DIR-04, PLAN-025 C1).
 *
 * Distinct from the frozen workbench wire types in `./workbench.ts`
 * (`ArtifactRef` / `WorkbenchArtifactKind`), which stay valid unchanged. This
 * module carries the open URI scheme (`vorno-artifact://`), the open type
 * registry, the provenance/type split, and relation edges.
 *
 * Open-string discipline (ADR-0016 §3): type ids, origin kinds, and relation
 * kinds are open lowercase-kebab strings. Un-prefixed values are reserved for
 * system built-ins; user/third-party values require a registered prefix
 * (`<prefix>:<name>`). Unknown values are tolerated and round-tripped
 * unmodified. Schema evolves additively.
 */

// A snapshot's identity/version — reused from the workbench module, not
// redefined (ADR-0016 §1: identity is location, version is hash).
export type { ArtifactVersion } from './workbench.ts';

/** Parsed form of `vorno-artifact://<rootId>/<relPath>` (ADR-0016 §1). */
export interface ParsedArtifactUri {
  rootId: string;
  relPath: string;
}

// ---------------------------------------------------------------------------
// Root binding config schema + storage descriptors (ADR-0019, PLAN-029)
//
// The persisted `artifactRoots` map value widens in place from a bare path
// string to `string | RootBindingConfig` (ADR-0019 door 1). A bare string is
// the filesystem shorthand — `{ kind: 'filesystem', path }`. `kind` is a
// reserved ADR-0016 §3 open-string space (door 2): un-prefixed = system
// built-in; third-party kinds require a registered prefix. The shape is
// forward-compatible so a future object-store backend plugs into the provider
// factory with no config migration; no second backend is implemented here.
// ---------------------------------------------------------------------------

/** Filesystem root binding config — the only built-in kind in C2. */
export interface FilesystemRootConfig {
  kind: 'filesystem';
  /** Absolute path (validated server-side on save and skipped at resolution if not). */
  path: string;
}

/**
 * A configured (non-workspace) root binding, discriminated by `kind` (ADR-0019
 * §1–2). The open `{ kind: string; ... }` arm keeps the type forward-tolerant:
 * an unknown/prefixed kind parses and is skipped at resolution, never thrown.
 * Secret-bearing kinds reference a vault key server-side (ADR-0013) — inline
 * secrets are forbidden by ADR-0019 §4 and none exist for filesystem.
 */
export type RootBindingConfig =
  | FilesystemRootConfig
  | { kind: string; [k: string]: unknown };

/**
 * Persisted `artifactRoots` map: `rootId → binding`. A `string` value is the
 * filesystem shorthand (`{ kind: 'filesystem', path: <string> }`). Existing
 * `Record<string, string>` configs are a subset — zero migration.
 */
export type ArtifactRootsConfig = Record<string, string | RootBindingConfig>;

/**
 * Per-root health surfaced additively on `roots:list` (ADR-0019 door 3). Reuses
 * the `ArtifactSkippedRoot.reason` vocabulary plus `ok`. Semantics freeze on
 * ship (ADR-0016 wire discipline).
 */
export type RootHealth = 'ok' | 'missing' | 'unreadable' | 'truncated';

/**
 * Provider-declared capabilities for a root (ADR-0018 seam, surfaced by
 * ADR-0019 §3). Config never asserts these — the provider is authoritative.
 * C2 roots are read-only: `write`/`presign` are always false until a write path
 * lands. Serializable so it can ride the REMOTE_ELIGIBLE `roots:list` wire.
 */
export interface StorageCapabilities {
  /** Can read artifact bytes by URI. */
  read: boolean;
  /** Can enumerate/index artifacts under the root. */
  list: boolean;
  /** Can write artifact bytes (unimplemented in C2 — always false). */
  write: boolean;
  /** Can mint presigned URLs (object-store future — always false in C2). */
  presign: boolean;
}

/**
 * A root binding as seen on the wire (`roots:list`). Ids + kind + capabilities
 * + optional health only — absolute paths NEVER leave the server (ADR-0016 §2).
 */
export interface ArtifactRootDescriptor {
  id: string;
  /** Provider kind (ADR-0019 §2 open-string space); `'filesystem'` in C2. */
  kind: string;
  capabilities: StorageCapabilities;
  /** Bounded root-level health probe; absent when not probed. */
  status?: RootHealth;
}

/**
 * A root the index scan could not (fully) serve. Identified by rootId only —
 * absolute paths never ride the wire (ADR-0016 §2 door 2).
 */
export interface ArtifactSkippedRoot {
  rootId: string;
  reason: 'missing' | 'unreadable' | 'truncated';
}

/**
 * Open provenance kinds. Un-prefixed values reserved for system built-ins
 * (ADR-0016 namespace reservation); prefixed (`<prefix>:<name>`) values carry
 * user/third-party provenance.
 */
export type ArtifactOriginKind = 'session-plan' | 'session-data' | 'corpus' | (string & {});

/** Where an artifact came from — provenance, no longer masquerading as type. */
export interface ArtifactOrigin {
  kind: ArtifactOriginKind;
  sessionId?: string;
  /** Joined from SessionHeader when sessionId is present. */
  projectId?: string;
  labels?: string[];
  sessionStatus?: string;
}

/**
 * Generalized index entry for the artifact plane. Distinct from the frozen
 * workbench `ArtifactRef`: `uri` is a `vorno-artifact://` URI (not an absolute
 * path), and provenance/type are separate fields.
 */
export interface ArtifactEntry {
  /** `vorno-artifact://<rootId>/<relPath>` form. */
  uri: string;
  /** Registered type id; open lowercase-kebab string. */
  type: string;
  origin: ArtifactOrigin;
  title: string;
  /** JSON-safe frontmatter subset (title/tags/id + other scalars/arrays), absent when none. */
  metadata?: Record<string, unknown>;
  tags?: string[];
  mtimeMs: number;
  sizeBytes: number;
  pinned?: boolean;
  archived?: boolean;
}

/** Type descriptor in the open registry (ADR-0016 §3). */
export interface ArtifactTypeDescriptor {
  /** Open lowercase-kebab id; un-prefixed = system built-in. */
  id: string;
  displayName: string;
  /** Lowercase, with leading dot, e.g. ['.md']. */
  extensions: string[];
  /** Optional MIME for MCP-resource/Apps alignment (ADR-0015 §4). */
  mimeType?: string;
}

/**
 * Open relation-edge kinds (ADR-0016 §3): same open-string + additive +
 * namespace-reservation discipline as type/origin.
 */
export type ArtifactRelationKind =
  | 'derived-from'
  | 'references'
  | 'renders'
  | 'discussed-in'
  | (string & {});

/** A directed relation edge between two artifacts (by URI). */
export interface ArtifactRelation {
  id: string;
  /** Artifact URI (edge tail). */
  from: string;
  /** Artifact URI (edge head). */
  to: string;
  kind: ArtifactRelationKind;
  note?: string;
  createdAt: number;
}
