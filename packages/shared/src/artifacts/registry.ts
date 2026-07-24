/**
 * Open artifact-type registry (ADR-0016 §3).
 *
 * Types are open lowercase-kebab strings resolved from registered descriptors.
 * Matching is by file extension in C1; frontmatter contributes metadata, not
 * type. Unknown types degrade to the `file` fallback.
 *
 * // ponytail: registration API is module-internal built-ins only in C1;
 * // workspace/skill registration lands with DIR-02 (C4). We expose the id
 * // validators now so C4 has a stable seam, but no runtime register() yet.
 */

import { extname } from 'path';
import type { ArtifactTypeDescriptor } from '@craft-agent/core/types';

/** C1 built-in type descriptors (registered in code). */
const BUILT_IN_DESCRIPTORS: ArtifactTypeDescriptor[] = [
  {
    id: 'markdown',
    displayName: 'Markdown',
    extensions: ['.md', '.markdown'],
    mimeType: 'text/markdown',
  },
  {
    id: 'json-canvas',
    displayName: 'JSON Canvas',
    extensions: ['.canvas'],
    mimeType: 'application/json',
  },
  {
    id: 'json',
    displayName: 'JSON',
    extensions: ['.json'],
    mimeType: 'application/json',
  },
  // Fallback: matches nothing by extension; assigned when no descriptor matches.
  {
    id: 'file',
    displayName: 'File',
    extensions: [],
  },
];

/** The fallback type id for anything not matched by a descriptor extension. */
export const FALLBACK_TYPE_ID = 'file';

/** All registered descriptors (built-ins only in C1). */
export function listArtifactTypes(): ArtifactTypeDescriptor[] {
  return BUILT_IN_DESCRIPTORS.map((d) => ({ ...d, extensions: [...d.extensions] }));
}

/**
 * Resolve the registered type id for a path by lowercase-extension match. Falls
 * back to `file` when no descriptor claims the extension.
 */
export function getArtifactTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (!ext) return FALLBACK_TYPE_ID;
  for (const descriptor of BUILT_IN_DESCRIPTORS) {
    if (descriptor.extensions.includes(ext)) return descriptor.id;
  }
  return FALLBACK_TYPE_ID;
}

/**
 * The set of extensions any registered descriptor claims (lowercase, with dot).
 * This is the index/read membership filter — it replaces the old `.md`-only
 * scan filter.
 */
export function getRegisteredExtensions(): Set<string> {
  const set = new Set<string>();
  for (const descriptor of BUILT_IN_DESCRIPTORS) {
    for (const ext of descriptor.extensions) set.add(ext);
  }
  return set;
}

/** Prefixed (user/third-party) id form: `<prefix>:<name>` (ADR-0016 §3). */
const PREFIXED_ID_RE = /^[a-z0-9-]+:[a-z0-9-]+$/;
/** System built-in id form: no prefix, lowercase-kebab. */
const SYSTEM_ID_RE = /^[a-z0-9-]+$/;

/** True when `id` is an un-prefixed (system-reserved) id. */
export function isSystemTypeId(id: string): boolean {
  return !id.includes(':');
}

/**
 * Validate an open type/origin/relation id against the namespace-reservation
 * discipline: either a system built-in (`markdown`) or a registered prefix form
 * (`acme:dataset`). Used by future registration (C4); exported now as the seam.
 */
export function isValidTypeId(id: string): boolean {
  return isSystemTypeId(id) ? SYSTEM_ID_RE.test(id) : PREFIXED_ID_RE.test(id);
}
