/**
 * StorageProvider — the only path from a `vorno-artifact://` URI to bytes
 * (ADR-0018; design: OpenDAL / Commons VFS / Java NIO.2 / Go io/fs / OCI-CAS
 * convergence, 260722-quick-sage).
 *
 * Minimal required core + optional capability interfaces. Capability
 * negotiation is hybrid: type guards in-process, the serializable
 * `StorageCapabilities` descriptor on the REMOTE_ELIGIBLE wire (a remote
 * client cannot type-assert a server-side provider).
 *
 * Deliberately NO method returns a raw physical path — containment lives
 * inside each provider (ADR-0018 door 2; the ARCH-1 fix).
 */

import type { StorageCapabilities } from '@craft-agent/core/types';

export type { StorageCapabilities };

/** Resolved metadata — the storage-agnostic stat shape. */
export interface ArtifactMeta {
  /** Canonical `vorno-artifact://` URI. */
  uri: string;
  type: 'file' | 'dir';
  sizeBytes: number;
  mtimeMs?: number;
  /** sha256 lowercase hex of the bytes (ADR-0016 §5) — filled by `read`. */
  contentHash?: string;
  /** Object-store native validator (opaque, NOT a content hash — RFC 9110 §8.8). */
  etag?: string;
  /** Object-store versionId, when versioning is on. */
  version?: string;
  /** Best-effort git HEAD of the containing dir — filesystem-native version info. */
  gitSha?: string;
}

export type StorageErrorKind =
  | 'not-found' // includes containment-denied — callers cannot distinguish, by design
  | 'too-large'
  | 'unsupported'
  | 'io';

export interface StorageError {
  kind: StorageErrorKind;
  /** Orthogonal to kind (OpenDAL): transient errors may be retried. */
  retryable?: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: StorageError };

export const err = <T>(kind: StorageErrorKind, retryable?: boolean): Result<T> => ({
  ok: false,
  error: retryable === undefined ? { kind } : { kind, retryable },
});
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/** Thrown by `list` iterators (Result does not fit an AsyncIterable). */
export class StorageOpError extends Error {
  constructor(public readonly kind: StorageErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'StorageOpError';
  }
}

export interface ListOpts {
  /** relPath prefix (slash-joined segments, no leading/trailing slash) to walk under. */
  prefix?: string;
  /** Max directory depth below the walk start to descend into. */
  maxDepth?: number;
  /**
   * Prune predicate over a directory's relPath (from the root). Listing
   * policy (skip-dirs, shape pruning) stays with the caller — it is index
   * policy, not storage policy.
   */
  skipDir?: (relPath: string) => boolean;
}

export interface ReadOpts {
  /** Reject (kind `too-large`) instead of reading past this size. */
  maxBytes?: number;
  /** Fill provider-native version info (filesystem: `gitSha`) — costs a subprocess. */
  withVersion?: boolean;
}

/** Required core — every backend (filesystem, object-store, memory) implements exactly this. */
export interface StorageProvider {
  readonly kind: string; // 'filesystem' | 'object-store' | 'memory'
  readonly capabilities: StorageCapabilities;
  stat(uri: string): Promise<Result<ArtifactMeta>>;
  read(uri: string, opts?: ReadOpts): Promise<Result<{ bytes: Buffer; meta: ArtifactMeta }>>;
  /** Files only, recursive, lazily; throws StorageOpError on an unservable root. */
  list(opts?: ListOpts): AsyncIterable<ArtifactMeta>;
  exists(uri: string): Promise<boolean>;
}

// Optional capabilities — Go io/fs pattern: type-guarded, additive, never break
// the core. C2 ships these as interfaces only; nothing implements them until a
// plan needs writes (ADR-0018 §1).
export interface WriteCapable {
  write(uri: string, bytes: Buffer): Promise<Result<ArtifactMeta>>;
  delete(uri: string): Promise<Result<void>>;
}
export interface CopyCapable {
  copy(from: string, to: string): Promise<Result<ArtifactMeta>>;
}
export interface PresignCapable {
  presignRead(uri: string, ttlSec: number): Promise<Result<string>>;
}

export function isWriteCapable(p: StorageProvider): p is StorageProvider & WriteCapable {
  return typeof (p as Partial<WriteCapable>).write === 'function';
}
export function isCopyCapable(p: StorageProvider): p is StorageProvider & CopyCapable {
  return typeof (p as Partial<CopyCapable>).copy === 'function';
}
export function isPresignCapable(p: StorageProvider): p is StorageProvider & PresignCapable {
  return typeof (p as Partial<PresignCapable>).presignRead === 'function';
}
