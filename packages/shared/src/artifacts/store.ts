/**
 * Artifact-plane relations + lifecycle store (ADR-0016; PLAN-025 C1).
 *
 * Plain agent-minable JSON beside the workspace, mirroring workbench/storage.ts:
 *
 *   {workspaceRoot}/artifacts/relations.json   relation edges
 *   {workspaceRoot}/artifacts/state.json       pinned/archived lifecycle flags
 *
 * `schemaVersion: 1` pinned, atomic writes, pretty JSON. A corrupt file is
 * warned about and treated as empty — one bad file never sinks a read. Dirs are
 * created lazily on first write.
 *
 * Forward compatibility (read-side half of the ADR-0013 additive discipline):
 * a file whose `schemaVersion` is newer than this code reads as empty and is
 * NEVER written — no silent downgrade, no partial destruction of future fields.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import type { ArtifactRelation } from '@craft-agent/core/types';

// ============================================================
// Path helpers
// ============================================================

/** {workspaceRoot}/artifacts */
export function getArtifactsStorePath(workspaceRoot: string): string {
  return join(workspaceRoot, 'artifacts');
}

/** {workspaceRoot}/artifacts/relations.json */
export function getRelationsPath(workspaceRoot: string): string {
  return join(getArtifactsStorePath(workspaceRoot), 'relations.json');
}

/** {workspaceRoot}/artifacts/state.json */
export function getStatePath(workspaceRoot: string): string {
  return join(getArtifactsStorePath(workspaceRoot), 'state.json');
}

function ensureStoreDir(workspaceRoot: string): void {
  const dir = getArtifactsStorePath(workspaceRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ============================================================
// Relations
// ============================================================

interface RelationsFile {
  schemaVersion: 1;
  relations: ArtifactRelation[];
}

const KNOWN_SCHEMA_VERSION = 1;

/** True when a parsed store file declares a schemaVersion newer than this code. */
function isNewerSchema(parsed: { schemaVersion?: unknown }): boolean {
  return typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > KNOWN_SCHEMA_VERSION;
}

function readRelationsFile(workspaceRoot: string): { file: RelationsFile; incompatible: boolean } {
  const path = getRelationsPath(workspaceRoot);
  const empty: RelationsFile = { schemaVersion: 1, relations: [] };
  if (!existsSync(path)) return { file: empty, incompatible: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RelationsFile>;
    if (isNewerSchema(parsed)) {
      debug('[artifacts] relations.json has a newer schemaVersion — reading as empty, writes refused:', parsed.schemaVersion);
      return { file: empty, incompatible: true };
    }
    const relations = Array.isArray(parsed.relations) ? parsed.relations : [];
    return { file: { schemaVersion: 1, relations }, incompatible: false };
  } catch (error) {
    debug('[artifacts] Corrupt relations.json — treating as empty:', path, error);
    return { file: empty, incompatible: false };
  }
}

function writeRelationsFile(workspaceRoot: string, file: RelationsFile): boolean {
  try {
    ensureStoreDir(workspaceRoot);
    atomicWriteFileSync(getRelationsPath(workspaceRoot), JSON.stringify(file, null, 2));
    return true;
  } catch (error) {
    debug('[artifacts] Failed to write relations.json:', error);
    return false;
  }
}

/**
 * List relations, optionally filtered to those touching `uri` (either endpoint).
 */
export function listRelations(workspaceRoot: string, uri?: string): ArtifactRelation[] {
  const { file } = readRelationsFile(workspaceRoot);
  if (!uri) return file.relations;
  return file.relations.filter((r) => r.from === uri || r.to === uri);
}

export interface AddRelationInput {
  from: string;
  to: string;
  kind: string;
  note?: string;
}

export type AddRelationResult =
  | { ok: true; relation: ArtifactRelation }
  | { ok: false; reason: 'invalid-payload' | 'duplicate' | 'write-failed' };

/**
 * Add a relation edge. Duplicate = same (from, to, kind) already present.
 * Payload is invalid when from/to/kind are not non-empty strings.
 */
export function addRelation(workspaceRoot: string, input: AddRelationInput): AddRelationResult {
  if (
    typeof input.from !== 'string' || input.from.length === 0 ||
    typeof input.to !== 'string' || input.to.length === 0 ||
    typeof input.kind !== 'string' || input.kind.length === 0
  ) {
    return { ok: false, reason: 'invalid-payload' };
  }

  const { file, incompatible } = readRelationsFile(workspaceRoot);
  // ponytail: 'write-failed' stands in for a distinct incompatible-schema
  // reason until a caller needs to tell them apart.
  if (incompatible) return { ok: false, reason: 'write-failed' };
  const duplicate = file.relations.some(
    (r) => r.from === input.from && r.to === input.to && r.kind === input.kind,
  );
  if (duplicate) return { ok: false, reason: 'duplicate' };

  const relation: ArtifactRelation = {
    id: randomUUID(),
    from: input.from,
    to: input.to,
    kind: input.kind,
    note: input.note,
    createdAt: Date.now(),
  };
  file.relations.push(relation);
  if (!writeRelationsFile(workspaceRoot, file)) return { ok: false, reason: 'write-failed' };
  return { ok: true, relation };
}

/**
 * Remove a relation by id. Returns false when the id was not present (which
 * includes a newer-schema file — read as empty, never rewritten).
 */
export function removeRelation(workspaceRoot: string, id: string): boolean {
  const { file, incompatible } = readRelationsFile(workspaceRoot);
  if (incompatible) return false;
  const next = file.relations.filter((r) => r.id !== id);
  if (next.length === file.relations.length) return false;
  file.relations = next;
  return writeRelationsFile(workspaceRoot, file);
}

// ============================================================
// Lifecycle state (pinned / archived)
// ============================================================

export interface ArtifactStateEntry {
  pinned?: boolean;
  archived?: boolean;
  updatedAt: number;
}

interface StateFile {
  schemaVersion: 1;
  entries: Record<string, ArtifactStateEntry>;
}

function readStateFile(workspaceRoot: string): { file: StateFile; incompatible: boolean } {
  const path = getStatePath(workspaceRoot);
  const empty: StateFile = { schemaVersion: 1, entries: {} };
  if (!existsSync(path)) return { file: empty, incompatible: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StateFile>;
    if (isNewerSchema(parsed)) {
      debug('[artifacts] state.json has a newer schemaVersion — reading as empty, writes refused:', parsed.schemaVersion);
      return { file: empty, incompatible: true };
    }
    const entries =
      parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    return {
      file: { schemaVersion: 1, entries: entries as Record<string, ArtifactStateEntry> },
      incompatible: false,
    };
  } catch (error) {
    debug('[artifacts] Corrupt state.json — treating as empty:', path, error);
    return { file: empty, incompatible: false };
  }
}

function writeStateFile(workspaceRoot: string, file: StateFile): boolean {
  try {
    ensureStoreDir(workspaceRoot);
    atomicWriteFileSync(getStatePath(workspaceRoot), JSON.stringify(file, null, 2));
    return true;
  } catch (error) {
    debug('[artifacts] Failed to write state.json:', error);
    return false;
  }
}

/** Read the full lifecycle-state map (uri → entry). */
export function getArtifactState(workspaceRoot: string): Record<string, ArtifactStateEntry> {
  return readStateFile(workspaceRoot).file.entries;
}

/**
 * Merge a pinned/archived patch onto an artifact's lifecycle state. When both
 * flags end up falsy the entry is pruned (state.json only holds set flags).
 * Returns the resulting entry (undefined when it was pruned).
 */
export function setArtifactState(
  workspaceRoot: string,
  uri: string,
  patch: { pinned?: boolean; archived?: boolean },
): ArtifactStateEntry | undefined {
  const { file, incompatible } = readStateFile(workspaceRoot);
  if (incompatible) {
    // Refuse to touch a newer-schema file. Throw so RPC callers surface
    // 'write-failed' via their existing catch path.
    throw new Error('artifacts state.json has a newer schemaVersion — refusing to write');
  }
  const existing = file.entries[uri];

  const pinned = patch.pinned ?? existing?.pinned;
  const archived = patch.archived ?? existing?.archived;

  if (!pinned && !archived) {
    delete file.entries[uri];
    writeStateFile(workspaceRoot, file);
    return undefined;
  }

  const entry: ArtifactStateEntry = {
    ...(pinned ? { pinned: true } : {}),
    ...(archived ? { archived: true } : {}),
    updatedAt: Date.now(),
  };
  file.entries[uri] = entry;
  writeStateFile(workspaceRoot, file);
  return entry;
}
