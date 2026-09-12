/**
 * Copy selection for the local-publication-recovery confirmation.
 *
 * Discarding local publication state is irreversible, so the warning has to be
 * true about the specific page in front of the user. Two independent facts decide
 * that, and an earlier version of this dialog used only one of them:
 *
 *   reason         which capability is unavailable — the admin key is gone, or
 *                  the recorded origin is not one we will talk to
 *   alreadyRevoked whether public routes already 404
 *
 * Either combination occurs, so there are four states and four sentences. The two
 * ways to get this wrong are both false statements a person would act on:
 *
 *   - saying the key is being discarded when it is already missing, which invents
 *     a capability the user never had
 *   - saying the copy may still be online when revocation is confirmed, which
 *     sends someone hunting for a live page that does not exist
 *
 * This lives in its own module, returning a key rather than rendering text, so
 * the table is a pure function a test can enumerate. `main/index.ts` resolves the
 * key through i18n at call time.
 */

import type { LocalPublicationRecoveryReason } from '@craft-agent/shared/pages'

/** Every key this resolver can return, for exhaustiveness checks in tests. */
export const FORGET_PUBLICATION_DETAIL_KEYS = [
  'pages.share.forgetLocalBodyKeyMissing',
  'pages.share.forgetLocalBodyKeyMissingRevoked',
  'pages.share.forgetLocalBodyKeyHeld',
  'pages.share.forgetLocalBodyKeyHeldRevoked',
] as const

export type ForgetPublicationDetailKey = (typeof FORGET_PUBLICATION_DETAIL_KEYS)[number]

/**
 * The i18n key whose text is true for this exact recovery state.
 *
 * Named for what the copy asserts (whether the key is missing or still held)
 * rather than the internal reason string, because that is the distinction a
 * translator has to preserve.
 */
export function forgetPublicationDetailKey(
  reason: LocalPublicationRecoveryReason,
  alreadyRevoked: boolean,
): ForgetPublicationDetailKey {
  if (reason === 'token-missing') {
    return alreadyRevoked
      ? 'pages.share.forgetLocalBodyKeyMissingRevoked'
      : 'pages.share.forgetLocalBodyKeyMissing'
  }
  // origin-unusable: the key is present and this action throws it away.
  return alreadyRevoked
    ? 'pages.share.forgetLocalBodyKeyHeldRevoked'
    : 'pages.share.forgetLocalBodyKeyHeld'
}
