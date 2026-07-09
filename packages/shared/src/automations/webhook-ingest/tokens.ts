/**
 * Hook endpoint tokens — capability-URL credentials, hashed at rest.
 *
 * fork(PLAN-014). Mirrors the `craft_sk_` generator/hasher in
 * `apps/server/src/config.ts` (sha256, `sha256:<hex>` shape) so the two token
 * families share verification ergonomics. These tokens authorize exactly one
 * hook's configured actions — never the management API surface.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_TOKEN_PREFIX } from '../constants.ts';

export interface MintedHookToken {
  /** Full plaintext token — shown once, never stored. */
  token: string;
  /** `sha256:<hex64>` hash to persist in automations.json. */
  tokenHash: string;
  /** Display-only prefix (e.g. `craft_whk_...a3f`). */
  tokenPrefix: string;
}

/** Generate a fresh `craft_whk_` token with its hash and display prefix. */
export function generateHookToken(): MintedHookToken {
  const raw = randomBytes(32).toString('base64url');
  const token = `${WEBHOOK_TOKEN_PREFIX}${raw}`;
  return {
    token,
    tokenHash: hashHookToken(token),
    tokenPrefix: `${WEBHOOK_TOKEN_PREFIX}...${raw.slice(-3)}`,
  };
}

/** SHA-256 hash of a token, as `sha256:<hex64>`. */
export function hashHookToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * Constant-time comparison of a provided token against a stored hash.
 * Hashes are compared (not the raw token), so both operands are fixed-length
 * for a given algorithm; length mismatch short-circuits to false.
 */
export function tokensMatch(providedToken: string, storedHash: string): boolean {
  const providedHash = hashHookToken(providedToken);
  const a = Buffer.from(providedHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
