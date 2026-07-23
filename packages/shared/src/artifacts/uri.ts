/**
 * `vorno-artifact://<rootId>/<relPath>` URI scheme (ADR-0016 §1).
 *
 * The URI names the *living* artifact by its location within a named root. It
 * never carries an absolute host path (that lives only in workspace root
 * bindings — see roots.ts) and never encodes a version (that is a separate
 * `ArtifactVersion` field).
 *
 * Round-trip invariant: `parseArtifactUri(formatArtifactUri(x))` deep-equals
 * `x` for every valid `x`.
 */

import type { ParsedArtifactUri } from '@craft-agent/core/types';

/** URI scheme literal (Vorno-owned; no collision with file:/MCP/craftagents://). */
export const ARTIFACT_URI_SCHEME = 'vorno-artifact';

/** The reserved root id bound to the workspace root (ADR-0016 §1). */
export const RESERVED_WORKSPACE_ROOT_ID = 'workspace';

/** Root ids: lowercase kebab, 1–64 chars. */
const ROOT_ID_RE = /^[a-z0-9-]{1,64}$/;

/** True when a root id is a syntactically valid authority. */
export function isValidRootId(rootId: string): boolean {
  return ROOT_ID_RE.test(rootId);
}

const SCHEME_PREFIX = `${ARTIFACT_URI_SCHEME}://`;

/**
 * Percent-encode a single relPath segment, leaving RFC 3986 unreserved chars and
 * the sub-delims that filesystems routinely allow untouched. `encodeURIComponent`
 * already encodes `/`, so segments are encoded individually then rejoined with
 * `/`. It does NOT encode `!'()*` — harmless in a path and decode-symmetric — so
 * the round-trip holds.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Format a parsed URI back into `vorno-artifact://<rootId>/<relPath>`. Assumes a
 * valid input (caller obtained it from `parseArtifactUri` or built it from
 * validated parts); rootId is not re-validated here.
 */
export function formatArtifactUri({ rootId, relPath }: ParsedArtifactUri): string {
  const encoded = relPath
    .split('/')
    .map(encodeSegment)
    .join('/');
  return `${SCHEME_PREFIX}${rootId}/${encoded}`;
}

/**
 * Parse a `vorno-artifact://` URI. Returns null (never throws) on any deviation:
 * wrong scheme, bad rootId, backslashes, empty/`.`/`..` segments, leading-slash
 * oddities, or undecodable percent-escapes. Case is preserved in the relPath.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | null {
  if (typeof uri !== 'string') return null;
  if (!uri.startsWith(SCHEME_PREFIX)) return null;
  // Backslashes are never legal in a POSIX relPath — reject before any split.
  if (uri.includes('\\')) return null;

  const rest = uri.slice(SCHEME_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null; // no path portion at all

  const rootId = rest.slice(0, slash);
  if (!ROOT_ID_RE.test(rootId)) return null;

  const rawPath = rest.slice(slash + 1);
  if (rawPath.length === 0) return null; // empty relPath
  if (rawPath.startsWith('/')) return null; // leading-slash oddity (empty first segment)
  if (rawPath.endsWith('/')) return null; // trailing empty segment

  const segments: string[] = [];
  for (const rawSegment of rawPath.split('/')) {
    if (rawSegment.length === 0) return null; // empty segment (e.g. a//b)
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return null; // malformed percent-escape
    }
    if (decoded === '.' || decoded === '..') return null; // dot segment
    if (decoded.includes('/') || decoded.includes('\\')) return null; // separator smuggled via encoding
    // C0 controls + DEL (e.g. %00): storable-but-unresolvable identities; the
    // future object-store provider has no fs-throw backstop (audit F6).
    if (CONTROL_CHARS_RE.test(decoded)) return null;
    segments.push(decoded);
  }

  return { rootId, relPath: segments.join('/') };
}

// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Canonicalize a URI to the scheme's single comparison form: the exact output
 * of `formatArtifactUri` (uppercase-hex, minimal-set percent-encoding). Stores
 * and gates compare canonical strings only, so RFC 3986 §6.2.2-equivalent
 * spellings (lowercase hex, over/under-encoded reserved chars) collapse to one
 * identity instead of silently failing string joins (audit F2). Returns null
 * for anything `parseArtifactUri` rejects.
 */
export function canonicalizeArtifactUri(uri: string): string | null {
  const parsed = parseArtifactUri(uri);
  return parsed ? formatArtifactUri(parsed) : null;
}
