/**
 * The one admissibility gate (ADR-0018 door 1; refines ADR-0016 §4 door 4).
 *
 * `isAdmissible` is a PURE predicate of the canonical URI — no enumeration, no
 * I/O, order-independent. It replaces the C1 per-read index re-scan (PERF-1)
 * and the scan-order-dependent membership under the volume cap (SEC-2). Both
 * `read` and `exportObsidianVault` call exactly this predicate (SEC-1: the
 * gate cannot diverge again).
 *
 * "Indexed" means the SHAPE the scanner surfaces, minus volume bounds: the
 * shape constants here (depth caps, skipped dir names) are imported by the
 * scanner, so gate ≡ scan surface by construction. `GLOBAL_FILE_CAP` lives in
 * scan.ts only — it is a listing bound and never gates readability.
 *
 * PRECONDITION: `uri` is canonical (`canonicalizeArtifactUri`, ADR-0016 §5) —
 * the pinned lookup and shape predicate assume one spelling per identity.
 * This module never normalizes (reject-don't-normalize posture).
 */

import { RESERVED_WORKSPACE_ROOT_ID, parseArtifactUri } from './uri.ts';
import { getRegisteredExtensions } from './registry.ts';
import type { StorageProvider } from './storage/provider.ts';

// Shape bounds — shared with scan.ts (single definition).
export const SESSION_DATA_DEPTH_CAP = 3;
export const CORPUS_DEPTH_CAP = 6;
export const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Dir names the scan never descends into: SKIP_DIRS + dot-dirs. */
export function isSkippedDirName(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

/** Lowercase `.ext` of the final segment, or '' when none. */
function extOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Pure path-shape test: is this relPath a location the index scan surfaces
 * (ignoring volume bounds)? Workspace root: `sessions/<id>/(plans|data)/**`
 * within the session depth cap; configured root: anywhere within the corpus
 * depth cap. Skipped dir names anywhere on the dir path exclude it. Session
 * ids are not name-filtered (matches the scanner).
 */
export function isIndexedLocation(rootId: string, relPath: string): boolean {
  const segments = relPath.split('/');
  const dirs = segments.slice(0, -1);

  if (rootId === RESERVED_WORKSPACE_ROOT_ID) {
    if (dirs.length < 3) return false;
    if (dirs[0] !== 'sessions') return false;
    const sub = dirs[2];
    if (sub !== 'plans' && sub !== 'data') return false;
    const rest = dirs.slice(3);
    if (rest.length > SESSION_DATA_DEPTH_CAP) return false;
    return !rest.some(isSkippedDirName);
  }

  if (dirs.length > CORPUS_DEPTH_CAP) return false;
  return !dirs.some(isSkippedDirName);
}

/**
 * Readable iff: bound root ∧ (indexed location ∧ registered extension, OR
 * pinned) — ADR-0016 door 4's formula with "indexed" as the pure shape
 * predicate (ADR-0018 door 1). Containment and the size cap are enforced by
 * the provider at read time; this predicate is policy only.
 */
export function isAdmissible(
  uri: string,
  providers: Map<string, StorageProvider>,
  pinned: (uri: string) => boolean,
): boolean {
  const parsed = parseArtifactUri(uri);
  if (!parsed) return false;
  if (!providers.has(parsed.rootId)) return false;
  if (pinned(uri)) return true;
  if (!isIndexedLocation(parsed.rootId, parsed.relPath)) return false;
  return getRegisteredExtensions().has(extOf(parsed.relPath));
}
