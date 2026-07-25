/**
 * Artifact plane module (ADR-0016, ADR-0015 / DIR-04, PLAN-025 C1).
 *
 * The generalized workspace artifact plane: `vorno-artifact://` addressing, an
 * open type registry, a zero-config context-aware index, relation edges +
 * lifecycle state, a gated read, JSON Canvas parse/emit, and an Obsidian-vault
 * projection. Wire/handlers (Leg 2) build on top of this.
 */

// URI scheme
export {
  ARTIFACT_URI_SCHEME,
  RESERVED_WORKSPACE_ROOT_ID,
  isValidRootId,
  formatArtifactUri,
  parseArtifactUri,
  canonicalizeArtifactUri,
} from './uri.ts';

// Root registry (rootId → StorageProvider, ADR-0018; config schema ADR-0019)
export {
  resolveRootBindings,
  normalizeRootConfig,
  createProvider,
  probeRootHealth,
} from './roots.ts';

// Storage-provider seam (ADR-0018): the only path from a URI to bytes.
export {
  StorageOpError,
  isWriteCapable,
  isCopyCapable,
  isPresignCapable,
} from './storage/provider.ts';
export type {
  ArtifactMeta,
  ListOpts,
  ReadOpts,
  Result,
  StorageCapabilities,
  StorageError,
  StorageErrorKind,
  StorageProvider,
  WriteCapable,
  CopyCapable,
  PresignCapable,
} from './storage/provider.ts';
export { FilesystemStorageProvider } from './storage/filesystem.ts';

// The one admissibility gate (ADR-0018 door 1)
export { isAdmissible, isIndexedLocation } from './admissibility.ts';

// Type registry
export {
  FALLBACK_TYPE_ID,
  listArtifactTypes,
  getArtifactTypeForPath,
  getRegisteredExtensions,
  isSystemTypeId,
  isValidTypeId,
} from './registry.ts';

// Index / scan
export { indexArtifacts, indexArtifactUris } from './scan.ts';
export type { IndexArtifactsOptions } from './scan.ts';

// Relation-edge display resolution (browser-safe; also deep-importable via
// `@craft-agent/shared/artifacts/relations-view`)
export { describeRelationEdges } from './relations-view.ts';
export type { RelationEdgeView } from './relations-view.ts';

// Relations + lifecycle store
export {
  getArtifactsStorePath,
  getRelationsPath,
  getStatePath,
  listRelations,
  addRelation,
  removeRelation,
  getArtifactState,
  setArtifactState,
} from './store.ts';
export type {
  AddRelationInput,
  AddRelationResult,
  ArtifactStateEntry,
} from './store.ts';

// Read gate
export { readArtifactByUri, MAX_ARTIFACT_BYTES } from './read.ts';
export type { ReadArtifactOptions, ReadArtifactByUriResult } from './read.ts';

// Content hashing / versioning
export { hashString, getGitSha } from './content.ts';

// JSON Canvas
export { parseJsonCanvas, emitJsonCanvas } from './canvas.ts';
export type {
  JsonCanvas,
  JsonCanvasNode,
  JsonCanvasEdge,
  JsonCanvasNodeType,
} from './canvas.ts';

// Obsidian-vault projection
export { exportObsidianVault } from './projection-obsidian.ts';
export type {
  ExportObsidianVaultOptions,
  ExportObsidianVaultResult,
} from './projection-obsidian.ts';
