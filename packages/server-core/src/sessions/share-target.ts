/**
 * Which backend a given share lives on (ADR-0024).
 *
 * Vorno hosts its own shared sessions, but shares created before that cutover
 * live on upstream's infrastructure and are not ours to break. The share id
 * alone does not say where the object is — the stored `sharedUrl` does.
 *
 * So: `VIEWER_URL` is used only to CREATE. Update and revoke resolve their
 * origin from the share's own URL.
 *
 * Getting this wrong is not a cosmetic bug. If update/revoke followed the
 * constant, every pre-cutover share would 404 against the new backend, the UI
 * would report "Failed to revoke share", and the user's transcript would stay
 * public on someone else's storage with no way to take it down from inside the
 * app. A link migration would have become a privacy incident.
 */

/**
 * Base URL for operating on an existing share.
 *
 * @param sharedUrl  The share's own URL, as persisted when it was created.
 * @param fallbackBase  Used when there is no usable `sharedUrl` — pass VIEWER_URL.
 */
export function shareApiBase(sharedUrl: string | undefined, fallbackBase: string): string {
  if (sharedUrl) {
    try {
      return new URL(sharedUrl).origin
    } catch {
      // Unparseable persisted URL: fall through rather than throw. A malformed
      // value should degrade to "try the current backend", not break revoke.
    }
  }
  return fallbackBase
}
