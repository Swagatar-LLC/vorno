/**
 * vorno-share — the session-share backend (ADR-0024, PLAN-035).
 *
 * Serves the built `apps/viewer` SPA *and* the share API from one origin, because
 * the viewer fetches `/s/api/{id}` relative (see src/App.tsx). Deployed to
 * share.vorno.ai; transcripts live in the R2 bucket bound as SHARES.
 *
 * Replaces the four `${VIEWER_URL}/s/api` call sites in SessionManager.ts that
 * previously went to upstream's host. The route shapes are unchanged so the
 * client and the viewer's `^/s/([a-zA-Z0-9_-]+)$` route both keep working:
 *
 *   POST   /s/api        create   → { id, url, editToken }
 *   GET    /s/api/:id    read
 *   PUT    /s/api/:id    replace  (Authorization: Bearer <editToken>)
 *   DELETE /s/api/:id    revoke   (Authorization: Bearer <editToken>)
 *
 * Two deliberate divergences from what we inherited, both in ADR-0024:
 *
 *  - Write auth. Upstream keys PUT/DELETE on the share id alone, and that id is
 *    in the URL the user forwards to other people — so any recipient can
 *    overwrite or delete the share. Create mints an edit token that never
 *    appears in the share URL; forwarding a link grants read and only read.
 *  - Reads are *always* application/json + nosniff, whatever was uploaded. This
 *    is what stops an unauthenticated POST endpoint being used as a free CDN or
 *    a phishing host on a vorno.ai domain: a browser only ever receives inert
 *    JSON.
 *
 * CPU budget: Workers Free allows 10ms CPU per invocation. Bodies are streamed
 * straight into R2 and never parsed — a multi-megabyte JSON.parse would blow
 * that, and would fail on exactly the large sessions people most want to share.
 * Do not "improve" this by validating the JSON shape here.
 */

/** Max transcript size. The client already renders 413 as "Session file is too large to share". */
const MAX_SHARE_BYTES = 8 * 1024 * 1024

/** 128 bits. The share link IS the access control, so the id is the credential. */
const SHARE_ID_BYTES = 16
const EDIT_TOKEN_BYTES = 32

/** 16 bytes of base64url — matches the viewer's `^/s/([a-zA-Z0-9_-]+)$`. */
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/

function base64url(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Unguessable random token. Anything sequential or short makes every user's transcript enumerable. */
export function randomToken(byteLength) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time compare of two hex digests — this is an auth path. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

/**
 * Enforce the size cap on the stream itself.
 *
 * Content-Length is checked first as a cheap early reject, but it is a claim by
 * the client, not a fact — so the bytes are counted as they pass. Erroring the
 * stream aborts the R2 put, and R2 writes are atomic, so no partial object is
 * left behind.
 */
function cappedBody(body, max) {
  let seen = 0
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > max) throw new Error('too_large')
        controller.enqueue(chunk)
      },
    })
  )
}

function declaredLength(request) {
  const raw = request.headers.get('content-length')
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Burst brake on unauthenticated creates. Cloudflare documents this binding as
 * per-colo and permissive — it is not an accounting system, and is not treated
 * as one. Absent binding (local dev, tests) means no limiting.
 */
async function isRateLimited(env, request) {
  if (!env.SHARE_CREATE_LIMIT) return false
  const key = request.headers.get('cf-connecting-ip') || 'unknown'
  try {
    const { success } = await env.SHARE_CREATE_LIMIT.limit({ key })
    return !success
  } catch {
    return false // never fail a share because the limiter is unavailable
  }
}

/** Resolve the edit token against the stored hash. Fails closed. */
async function authorizeWrite(env, id, request) {
  const head = await env.SHARES.head(id)
  if (!head) return { ok: false, response: json({ error: 'not_found' }, 404) }

  const expected = head.customMetadata?.editTokenHash
  const supplied = bearerToken(request)
  if (!expected || !supplied) return { ok: false, response: json({ error: 'unauthorized' }, 401) }
  if (!timingSafeEqual(await sha256Hex(supplied), expected)) {
    return { ok: false, response: json({ error: 'unauthorized' }, 401) }
  }
  return { ok: true, head }
}

async function createShare(request, env, url) {
  if (await isRateLimited(env, request)) return json({ error: 'rate_limited' }, 429)

  const length = declaredLength(request)
  if (length !== null && length > MAX_SHARE_BYTES) return json({ error: 'too_large' }, 413)
  if (!request.body) return json({ error: 'empty_body' }, 400)

  const id = randomToken(SHARE_ID_BYTES)
  const editToken = randomToken(EDIT_TOKEN_BYTES)

  try {
    await env.SHARES.put(id, cappedBody(request.body, MAX_SHARE_BYTES), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { editTokenHash: await sha256Hex(editToken) },
    })
  } catch {
    return json({ error: 'too_large' }, 413)
  }

  return json({ id, url: `${url.origin}/s/${id}`, editToken }, 201)
}

async function readShare(env, id) {
  const object = await env.SHARES.get(id)
  if (!object) return json({ error: 'not_found' }, 404)

  // Always JSON, always nosniff, never cached — a revoked share must actually
  // stop resolving, which an edge cache would defeat.
  return new Response(object.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })
}

async function replaceShare(request, env, id) {
  const auth = await authorizeWrite(env, id, request)
  if (!auth.ok) return auth.response

  const length = declaredLength(request)
  if (length !== null && length > MAX_SHARE_BYTES) return json({ error: 'too_large' }, 413)
  if (!request.body) return json({ error: 'empty_body' }, 400)

  try {
    // Rewriting the object also resets its lifecycle age, so an actively
    // updated share does not expire out from under its owner mid-conversation.
    await env.SHARES.put(id, cappedBody(request.body, MAX_SHARE_BYTES), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: auth.head.customMetadata,
    })
  } catch {
    return json({ error: 'too_large' }, 413)
  }

  return json({ id, ok: true })
}

async function revokeShare(request, env, id) {
  const auth = await authorizeWrite(env, id, request)
  if (!auth.ok) return auth.response
  await env.SHARES.delete(id)
  return json({ id, ok: true })
}

/**
 * Route the SPA. Mirrors apps/viewer/public/_redirects, which is what Cloudflare
 * Pages applied when upstream hosted this: the bundle is built with `base: '/s/'`
 * (vite.config.ts) so its asset URLs are `/s/assets/*` while the files land at
 * `dist/assets/*`.
 */
function assetRequest(request, url) {
  if (url.pathname.startsWith('/s/assets/')) {
    const rewritten = new URL(url)
    rewritten.pathname = url.pathname.slice('/s'.length)
    return new Request(rewritten, request)
  }
  if (url.pathname === '/s' || SHARE_ID_RE.test(url.pathname.slice('/s/'.length))) {
    const spa = new URL(url)
    spa.pathname = '/index.html'
    return new Request(spa, request)
  }
  return request
}

export async function handle(request, env) {
  const url = new URL(request.url)
  const { pathname } = url

  if (pathname === '/s/api' || pathname === '/s/api/') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    return createShare(request, env, url)
  }

  if (pathname.startsWith('/s/api/')) {
    const id = pathname.slice('/s/api/'.length)
    if (!SHARE_ID_RE.test(id)) return json({ error: 'not_found' }, 404)

    switch (request.method) {
      case 'GET':
        return readShare(env, id)
      case 'PUT':
        return replaceShare(request, env, id)
      case 'DELETE':
        return revokeShare(request, env, id)
      default:
        return json({ error: 'method_not_allowed' }, 405)
    }
  }

  return env.ASSETS.fetch(assetRequest(request, url))
}

export default { fetch: handle }
