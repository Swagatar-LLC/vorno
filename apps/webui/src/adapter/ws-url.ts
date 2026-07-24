/**
 * Resolves the WebSocket URL scheme to match the page's scheme.
 *
 * Root cause: the server derives `wsUrl` (returned from `/api/config`) from the
 * `x-forwarded-proto` request header. Reverse proxies (e.g. `tailscale serve`)
 * don't reliably forward that header, so the server can return `ws://…/ws` for
 * a page loaded over `https:` — the browser then blocks the connection as
 * mixed content.
 *
 * This is a proxy-agnostic client-side fix: if the page is served over HTTPS
 * and the server-provided URL is `ws://`, upgrade it to `wss://`. Never
 * downgrades `wss://` to `ws://`.
 */
export function resolvePageWsUrl(rawWsUrl: string, protocol: string): string {
  if (protocol === 'https:' && rawWsUrl.startsWith('ws://')) {
    return `wss://${rawWsUrl.slice('ws://'.length)}`
  }
  return rawWsUrl
}
