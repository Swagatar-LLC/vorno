/**
 * JSONPath-lite — a deliberately tiny path resolver for webhook payloads.
 *
 * fork(PLAN-014). Supports exactly what the webhook feature needs:
 *   - `$`                 → the root value
 *   - `$.a.b.c`           → nested object access
 *   - `$.items[0].id`     → array index access
 *   - `$["odd.key"]`      → bracketed string keys (dots-in-keys safe)
 *
 * No wildcards, filters, recursion, or slices — those are a security and
 * complexity liability we don't want on an unauthenticated ingest path. Returns
 * `undefined` for any miss or malformed expression (never throws).
 */

/** True when the string is a syntactically valid JSONPath-lite expression. */
export function isValidJsonPathLite(expr: string): boolean {
  if (typeof expr !== 'string' || expr.length === 0) return false;
  if (expr === '$') return true;
  if (!expr.startsWith('$')) return false;
  // Tokenize the remainder; any leftover means malformed.
  return tokenize(expr.slice(1)) !== null;
}

/**
 * Resolve a JSONPath-lite expression against a value. Returns `undefined` on
 * any miss. Never throws.
 */
export function resolveJsonPathLite(root: unknown, expr: string): unknown {
  if (expr === '$') return root;
  if (typeof expr !== 'string' || !expr.startsWith('$')) return undefined;

  const tokens = tokenize(expr.slice(1));
  if (tokens === null) return undefined;

  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof token === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
    } else {
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

/**
 * Convert a path into a string for matching/env use: strings pass through,
 * other JSON values are JSON-stringified, undefined → ''.
 */
export function resolveJsonPathLiteString(root: unknown, expr: string): string {
  const value = resolveJsonPathLite(root, expr);
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

type Token = string | number;

/**
 * Split the part after the leading `$` into tokens. Returns `null` when the
 * expression is malformed.
 */
function tokenize(rest: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;

  while (i < rest.length) {
    const ch = rest[i];

    if (ch === '.') {
      // Dot access — read an identifier up to the next `.` or `[`.
      i++;
      let name = '';
      while (i < rest.length && rest[i] !== '.' && rest[i] !== '[') {
        name += rest[i];
        i++;
      }
      if (name.length === 0) return null;
      tokens.push(name);
    } else if (ch === '[') {
      // Bracket access — either [n] or ["key"] / ['key'].
      const close = rest.indexOf(']', i);
      if (close === -1) return null;
      const inner = rest.slice(i + 1, close);
      i = close + 1;

      if (inner.length === 0) return null;

      const first = inner[0];
      if (first === '"' || first === "'") {
        if (inner.length < 2 || inner[inner.length - 1] !== first) return null;
        tokens.push(inner.slice(1, -1));
      } else {
        if (!/^\d+$/.test(inner)) return null;
        tokens.push(Number(inner));
      }
    } else {
      return null;
    }
  }

  return tokens;
}
