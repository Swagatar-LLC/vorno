/**
 * fork(PLAN-015): secret redaction for production log lines.
 *
 * Every line written by the packaged-build file logger passes through
 * `redactSecrets` before hitting disk. Patterns target key *shapes* (vendor
 * prefixes, bearer tokens, key=value assignments) rather than known values —
 * the logger can't know which secrets exist, so it scrubs anything that looks
 * like one. False positives are acceptable; leaked key material is not.
 */

const REDACTED = '[REDACTED]';

/** Vendor-prefixed token shapes that are unambiguous secrets. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,           // Anthropic API keys
  /\bsk-[A-Za-z0-9_-]{20,}/g,              // OpenAI-style secret keys
  /\bcraft_sk_[A-Za-z0-9_-]{8,}/g,         // fork trigger-server API keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,       // GitHub fine-grained PATs
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,       // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                 // AWS access key IDs
];

/** `Bearer <token>` in headers or stringified requests. */
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `apiKey=..., "token": "...", ANTHROPIC_API_KEY=..., secret: ...` style
 * assignments. The key may carry a prefix (`ANTHROPIC_API_KEY`) — a plain \b
 * would miss it since `_` is a word character. Keeps the key name and
 * separator, redacts the value. Value charset stops at whitespace, quotes,
 * and JSON/urlencoded delimiters.
 */
const ASSIGNMENT_PATTERN =
  /([A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|authorization|credential))(["']?\s*[:=]\s*["']?)(?!\s*\[REDACTED\])(?!bearer\b)[^\s"'&,;}\]]{4,}/gi;

/** Scrub anything that looks like key material from a log line. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // Bearer first so `Authorization: Bearer <token>` keeps its header shape —
  // the assignment pass then skips the literal "Bearer" word as a value.
  out = out.replace(BEARER_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(
    ASSIGNMENT_PATTERN,
    (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  );
  return out;
}
