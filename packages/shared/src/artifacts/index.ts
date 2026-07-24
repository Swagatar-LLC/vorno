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

// Root registry + containment
export {
  resolveRootBindings,
  resolveArtifactPath,
  absPathToUri,
} from './roots.ts';
export type { RootBinding } from './roots.ts';

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
export { computeContentHash, hashString, getGitSha } from './content.ts';

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
