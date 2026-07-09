/**
 * Delivery verification — token, body size, and (Phase 2) HMAC.
 *
 * fork(PLAN-014). Kept HTTP-agnostic and pure so the receiver pipeline and its
 * unit tests can exercise each check in isolation.
 */

import type { HookConfig } from '../types.ts';
import { WEBHOOK_DEFAULT_BODY_CAP_BYTES } from '../constants.ts';
import { tokensMatch } from './tokens.ts';

/** Constant-time token check against the hook's stored hash. */
export function verifyToken(hook: HookConfig, providedToken: string): boolean {
  return tokensMatch(providedToken, hook.tokenHash);
}

/** True when the body is within the hook's cap (or the default). */
export function withinBodyCap(hook: HookConfig, byteLength: number): boolean {
  const cap = hook.bodyCapBytes ?? WEBHOOK_DEFAULT_BODY_CAP_BYTES;
  return byteLength <= cap;
}

/**
 * Phase 2 placeholder. HMAC-SHA256 verification over the raw bytes (before JSON
 * parse) with signed-timestamp tolerance lands in VOR-34. In Phase 1 a hook may
 * declare `verification` (it validates), but it is not enforced yet — documented
 * in the plan. This returns `true` unconditionally so wiring is inert until then.
 */
export function verifyHmac(
  _hook: HookConfig,
  _headers: Record<string, string>,
  _rawBody: Uint8Array,
): boolean {
  return true;
}
