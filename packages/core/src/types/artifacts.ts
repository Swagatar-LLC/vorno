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

/**
 * Serializable storage-capability descriptor (ADR-0018). Wire-safe — the
 * artifacts channels are REMOTE_ELIGIBLE, so a remote client learns what a
 * root's provider can do from this descriptor (it cannot type-assert a
 * server-side provider). Rides `vorno:artifacts:roots:list` additively.
 */
export interface StorageCapabilities {
  read: boolean;
  stat: boolean;
  list: boolean;
  contentHash: boolean;
  write: boolean;
  delete: boolean;
  copy: boolean;
  presign: boolean;
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
