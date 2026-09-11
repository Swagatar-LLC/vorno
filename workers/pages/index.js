/**
 * vorno-pages — isolated public Pages sharing (ADR-0033, SUV-0060).
 *
 * This Worker is intentionally separate from apps/viewer/worker and vorno-share:
 * it serves untrusted HTML, while the session-share origin must only serve inert
 * JSON. PAGES is the dedicated `vorno-pages` R2 binding; no viewer storage or
 * credentials cross this boundary.
 */

export const PAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024
const MAX_UPLOAD_REQUEST_BYTES = MAX_BUNDLE_BYTES + 128 * 1024
const PASSWORD_MIN_CHARS = 8
const PASSWORD_MAX_CHARS = 1024
const PASSWORD_TICKET_TTL_SECONDS = 60 * 60 * 12
// Measured locally with bench-password.js; deploy verification must remeasure on Workers.
const DEFAULT_PBKDF2_ITERATIONS = 100_000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

export function randomToken(byteLength) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function publicHeaders(contentType, extra = {}) {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...extra,
  }
}

function declaredLength(request) {
  const raw = request.headers.get('content-length')
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function publicationPath(id, suffix) {
  return `${id}/${suffix}`
}

function manifestPath(id) {
  return publicationPath(id, 'manifest.json')
}

function revisionPaths(id, revision) {
  return {
    contentKey: publicationPath(id, `revisions/${revision}/content.html`),
    snapshotKey: publicationPath(id, `revisions/${revision}/snapshot.json`),
  }
}

async function bodyText(object) {
  return new Response(object.body).text()
}

async function loadRecord(env, id) {
  const object = await env.PAGES.get(manifestPath(id))
  if (!object) return null
  try {
    const record = JSON.parse(await bodyText(object))
    return isRecord(record) ? { record, etag: object.etag } : null
  } catch {
    return null
  }
}

function isRecord(record) {
  return record && typeof record === 'object'
    && typeof record.id === 'string'
    && typeof record.adminTokenHash === 'string'
    && typeof record.revision === 'string'
    && (record.status === 'published' || record.status === 'unpublished')
    && record.manifest && typeof record.manifest === 'object'
}

async function saveRecord(env, record, etag) {
  const result = await env.PAGES.put(manifestPath(record.id), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
  })
  // R2 returns null for a failed conditional put. Test doubles may return undefined.
  return result !== null
}

async function rateLimited(env, bindingName, request, scope = '', failClosed = false) {
  const limiter = env[bindingName]
  if (!limiter) return failClosed
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  try {
    const { success } = await limiter.limit({ key: `${scope}:${ip}` })
    return !success
  } catch {
    return failClosed
  }
}

function cappedBody(body, max) {
  let seen = 0
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > max) throw new Error('too_large')
      controller.enqueue(chunk)
    },
  }))
}

function validManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return false
  if (manifest.version !== 1 || typeof manifest.slug !== 'string' || !manifest.slug || manifest.slug.length > 120) return false
  if (typeof manifest.title !== 'string' || !manifest.title || manifest.title.length > 300) return false
  if (!['static', 'interactive', 'live'].includes(manifest.kind)) return false
  if (!/^[a-f0-9]{64}$/.test(manifest.contentDigest || '')) return false
  return typeof manifest.includesData === 'boolean'
}

async function readUpload(request, { allowPasswordAction = false } = {}) {
  const declared = declaredLength(request)
  if (declared !== null && declared > MAX_UPLOAD_REQUEST_BYTES) return { error: 'too_large', status: 413 }

  if (!request.body) return { error: 'invalid_multipart', status: 400 }
  let form
  try {
    // Cap raw multipart bytes before parsing, including ignored fields and chunked bodies.
    const cappedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: cappedBody(request.body, MAX_UPLOAD_REQUEST_BYTES),
      duplex: 'half',
    })
    form = await cappedRequest.formData()
  } catch (error) {
    return { error: error instanceof Error && error.message === 'too_large' ? 'too_large' : 'invalid_multipart', status: error instanceof Error && error.message === 'too_large' ? 413 : 400 }
  }

  const passwordAction = form.get('passwordAction')
  if (allowPasswordAction && (passwordAction === 'set' || passwordAction === 'clear')) {
    const password = form.get('password')
    if (passwordAction === 'set' && (typeof password !== 'string' || password.length < PASSWORD_MIN_CHARS || password.length > PASSWORD_MAX_CHARS)) {
      return { error: 'invalid_password', status: 400 }
    }
    if (passwordAction === 'clear' && password !== null) return { error: 'invalid_password_action', status: 400 }
    return { passwordAction, password: passwordAction === 'set' ? password : undefined }
  }
  if (passwordAction !== null) return { error: 'invalid_password_action', status: 400 }

  const manifestText = form.get('manifest')
  const content = form.get('content')
  const snapshot = form.get('snapshot')
  const password = form.get('password')
  if (typeof manifestText !== 'string' || !(content instanceof Blob) || (snapshot !== null && !(snapshot instanceof Blob))) {
    return { error: 'invalid_bundle', status: 400 }
  }
  if (password !== null && (typeof password !== 'string' || password.length < PASSWORD_MIN_CHARS || password.length > PASSWORD_MAX_CHARS)) {
    return { error: 'invalid_password', status: 400 }
  }

  let manifest
  try { manifest = JSON.parse(manifestText) } catch { return { error: 'invalid_manifest', status: 400 } }
  if (!validManifest(manifest)) return { error: 'invalid_manifest', status: 400 }
  if (content.size > MAX_CONTENT_BYTES || (snapshot instanceof Blob && snapshot.size > MAX_SNAPSHOT_BYTES)) {
    return { error: 'too_large', status: 413 }
  }
  const total = encoder.encode(manifestText).byteLength + content.size + (snapshot instanceof Blob ? snapshot.size : 0)
  if (total > MAX_BUNDLE_BYTES) return { error: 'too_large', status: 413 }
  if (manifest.includesData !== (snapshot instanceof Blob)) return { error: 'snapshot_mismatch', status: 400 }
  if (snapshot instanceof Blob) {
    try { JSON.parse(await snapshot.text()) } catch { return { error: 'invalid_snapshot', status: 400 } }
  }
  const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}/
  if (secretPattern.test(await content.text())) return { error: 'secret_candidate', status: 400 }
  return { manifest, content, snapshot: snapshot instanceof Blob ? snapshot : undefined, password: password || undefined }
}

function passwordIterations(env) {
  const value = Number(env.PBKDF2_ITERATIONS || DEFAULT_PBKDF2_ITERATIONS)
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000 ? value : DEFAULT_PBKDF2_ITERATIONS
}

async function hashPassword(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64urlBytes(salt), iterations },
    material,
    256,
  )
  return base64url(new Uint8Array(derived))
}

async function passwordMetadata(env, password) {
  if (!password) return undefined
  if (typeof env.PASSWORD_TICKET_SECRET !== 'string' || !env.PASSWORD_TICKET_SECRET) throw new Error('password_tickets_unconfigured')
  const salt = randomToken(16)
  const iterations = passwordIterations(env)
  return { salt, hash: await hashPassword(password, salt, iterations), iterations, version: randomToken(12) }
}

async function hmac(env, value) {
  if (typeof env.PASSWORD_TICKET_SECRET !== 'string' || !env.PASSWORD_TICKET_SECRET) throw new Error('password_tickets_unconfigured')
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.PASSWORD_TICKET_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

async function issueTicket(env, record) {
  const payload = base64url(encoder.encode(JSON.stringify({ id: record.id, version: record.password.version, exp: Math.floor(Date.now() / 1000) + PASSWORD_TICKET_TTL_SECONDS })))
  return `${payload}.${await hmac(env, payload)}`
}

async function hasValidTicket(request, env, record) {
  if (!record.password) return true
  const ticket = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith('vorno_pages_ticket='))?.slice('vorno_pages_ticket='.length)
  if (!ticket) return false
  const [payload, signature, extra] = ticket.split('.')
  if (!payload || !signature || extra || !timingSafeEqual(signature, await hmac(env, payload))) return false
  try {
    const decoded = JSON.parse(decoder.decode(base64urlBytes(payload)))
    return decoded.id === record.id && decoded.version === record.password.version && Number.isInteger(decoded.exp) && decoded.exp > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

async function authorize(request, env, id) {
  const loaded = await loadRecord(env, id)
  if (!loaded) return { response: json({ error: 'not_found' }, 404) }
  const { record, etag } = loaded
  const supplied = bearerToken(request)
  if (!supplied || !timingSafeEqual(await sha256Hex(supplied), record.adminTokenHash)) {
    return { response: json({ error: 'unauthorized' }, 401) }
  }
  return { record, etag }
}

function publicationDto(request, record, includeToken = false, adminToken) {
  const url = new URL(request.url)
  return {
    id: record.id,
    url: `${url.origin}/p/${record.id}`,
    revision: record.revision,
    ...(includeToken ? { adminToken } : {}),
    passwordProtected: Boolean(record.password),
    status: record.status,
    updatedAt: record.updatedAt,
  }
}

async function writeBundle(env, record, upload, etag) {
  // All parsing and limits complete before the first put. Immutable revision
  // keys mean a failed upload cannot replace content selected by the live
  // manifest; the manifest pointer is switched only after every new object is ready.
  await env.PAGES.put(record.contentKey, upload.content, { httpMetadata: { contentType: 'text/html; charset=utf-8' } })
  if (upload.snapshot) await env.PAGES.put(record.snapshotKey, upload.snapshot, { httpMetadata: { contentType: 'application/json; charset=utf-8' } })
  return saveRecord(env, record, etag)
}

async function createPublication(request, env) {
  if (await rateLimited(env, 'PAGE_CREATE_LIMIT', request, 'create', true)) return json({ error: 'rate_limited' }, 429)
  const upload = await readUpload(request)
  if (upload.error) return json({ error: upload.error }, upload.status)

  let password
  try { password = await passwordMetadata(env, upload.password) } catch { return json({ error: 'password_tickets_unconfigured' }, 503) }
  const id = randomToken(16)
  const adminToken = randomToken(32)
  const now = Date.now()
  const revision = randomToken(8)
  const record = {
    id,
    status: 'published',
    adminTokenHash: await sha256Hex(adminToken),
    revision,
    ...revisionPaths(id, revision),
    manifest: upload.manifest,
    password,
    createdAt: now,
    updatedAt: now,
    cleanup: { state: 'none', attempts: 0 },
  }
  try {
    if (!(await writeBundle(env, record, upload))) throw new Error('manifest_conflict')
  } catch {
    // Best effort removes a failed partial write; public reads require the manifest, written last.
    await Promise.allSettled([env.PAGES.delete(record.contentKey), env.PAGES.delete(record.snapshotKey), env.PAGES.delete(manifestPath(id))])
    return json({ error: 'storage_failed' }, 503)
  }
  return json(publicationDto(request, record, true, adminToken), 201)
}

async function updatePublication(request, env, id) {
  const auth = await authorize(request, env, id)
  if (auth.response) return auth.response
  if (auth.record.status !== 'published') return json({ error: 'not_found' }, 404)
  const upload = await readUpload(request, { allowPasswordAction: true })
  if (upload.error) return json({ error: upload.error }, upload.status)

  if (upload.passwordAction) {
    let password
    try { password = upload.passwordAction === 'set' ? await passwordMetadata(env, upload.password) : undefined } catch { return json({ error: 'password_tickets_unconfigured' }, 503) }
    const record = { ...auth.record, password, updatedAt: Date.now() }
    if (!(await saveRecord(env, record, auth.etag))) return json({ error: 'conflict' }, 409)
    return json(publicationDto(request, record))
  }

  const revision = randomToken(8)
  const record = {
    ...auth.record,
    manifest: upload.manifest,
    revision,
    ...revisionPaths(id, revision),
    updatedAt: Date.now(),
  }
  let saved
  try { saved = await writeBundle(env, record, upload, auth.etag) } catch { saved = undefined }
  if (!saved) {
    await Promise.allSettled([env.PAGES.delete(record.contentKey), env.PAGES.delete(record.snapshotKey)])
    return json({ error: saved === false ? 'conflict' : 'storage_failed' }, saved === false ? 409 : 503)
  }
  await cleanupSupersededRevisions(env, record)
  return json(publicationDto(request, record))
}

async function cleanupSupersededRevisions(env, record) {
  // Keep only the selected revision after a successful manifest switch. Any
  // transient delete failure is retried by the next update and by unpublish.
  try {
    const listed = await env.PAGES.list({ prefix: `${record.id}/revisions/` })
    await Promise.allSettled(listed.objects
      .map(object => object.key)
      .filter(key => key !== record.contentKey && key !== record.snapshotKey)
      .map(key => env.PAGES.delete(key)))
  } catch {
    // The manifest selects exactly one revision; unpublish is the full-prefix backstop.
  }
}

async function cleanupPublication(env, record, etag) {
  const errors = []
  let objects = []
  try {
    let cursor
    do {
      const listed = await env.PAGES.list({ prefix: `${record.id}/`, cursor })
      objects.push(...listed.objects.map(object => object.key))
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  for (const key of objects.filter(key => key !== manifestPath(record.id))) {
    try { await env.PAGES.delete(key) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  }
  const cleanup = {
    state: errors.length ? 'pending' : 'complete',
    attempts: (record.cleanup?.attempts || 0) + 1,
    lastAttemptAt: Date.now(),
    ...(errors.length ? { lastError: errors.join('; ').slice(0, 500) } : {}),
  }
  const updated = { ...record, cleanup, updatedAt: Date.now() }
  return (await saveRecord(env, updated, etag)) ? updated : record
}

async function unpublishPublication(request, env, id) {
  // CAS prevents a stale content PUT from writing a published manifest after revocation.
  let auth
  for (let attempt = 0; attempt < 3; attempt++) {
    auth = await authorize(request, env, id)
    if (auth.response) return auth.response
    if (auth.record.status === 'unpublished') break
    const revoked = { ...auth.record, status: 'unpublished', unpublishedAt: Date.now(), cleanup: { state: 'pending', attempts: 0 } }
    if (await saveRecord(env, revoked, auth.etag)) {
      auth = await authorize(request, env, id)
      break
    }
  }
  if (!auth || auth.response) return json({ error: 'conflict' }, 409)
  if (auth.record.status !== 'unpublished') return json({ error: 'conflict' }, 409)
  let record = auth.record
  try {
    record = await cleanupPublication(env, record, auth.etag)
  } catch {
    // The logical tombstone was committed first, so public routes remain 404.
  }
  return json({ ...publicationDto(request, record), cleanupPending: record.cleanup.state !== 'complete' })
}

const SHELL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
const CONTENT_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"

function contentCsp(record) {
  return `${CONTENT_CSP}; sandbox${record.manifest.kind === 'static' ? '' : ' allow-scripts'}`
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function safeInlineJson(value) {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

function shellHtml(record, snapshot) {
  const sandbox = record.manifest.kind === 'static' ? '' : 'allow-scripts allow-forms'
  const id = record.id
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(record.manifest.title)} — Vorno Pages</title><style>html,body{height:100%;margin:0;font-family:system-ui,sans-serif;background:#111;color:#eee}aside{box-sizing:border-box;padding:9px 14px;background:#202020;border-bottom:1px solid #444;font-size:13px}strong{color:#fff}iframe{display:block;width:100%;height:calc(100% - 39px);border:0;background:#fff}</style></head><body><aside><strong>Published by a Vorno user — not by Vorno.</strong> Treat links and forms on this page with care.</aside><iframe id="page" title="${escapeHtml(record.manifest.title)}" src="/p/${id}/content" sandbox="${sandbox}"></iframe><script>const frame=document.getElementById('page');const init={protocol:'craft-pages/v1',type:'init',payload:{page:{slug:${safeInlineJson(record.manifest.slug)},kind:${safeInlineJson(record.manifest.kind)}},nonce:${safeInlineJson(randomToken(16))},snapshot:${safeInlineJson(snapshot)},grants:[]}};addEventListener('message',event=>{const msg=event.data;if(!msg||msg.protocol!=='craft-pages/v1'||event.source!==frame.contentWindow)return;if(msg.type==='ready')frame.contentWindow.postMessage(init,'*');if(msg.type==='action')event.source.postMessage({protocol:'craft-pages/v1',type:'action-result',payload:{result:{requestId:msg.requestId,ok:false,error:'public-actions-disabled',durationMs:0}}},'*');if(msg.type==='grant-request')event.source.postMessage({protocol:'craft-pages/v1',type:'grants',payload:{grants:[]}},'*')});</script></body></html>`
}

function passwordHtml(record) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Password required — Vorno Pages</title><style>body{max-width:32rem;margin:4rem auto;padding:0 1rem;font-family:system-ui,sans-serif}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin:.4rem 0}button{width:auto}</style></head><body><h1>Password required</h1><p>This page was published by a Vorno user, not by Vorno.</p><form method="post" action="/p/${record.id}/password"><label>Password<input required type="password" name="password" autocomplete="current-password"></label><button type="submit">View page</button></form></body></html>`
}

async function publicRecord(env, id) {
  const loaded = await loadRecord(env, id)
  return loaded?.record.status === 'published' ? loaded.record : null
}

async function serveShell(request, env, id) {
  const record = await publicRecord(env, id)
  if (!record) return json({ error: 'not_found' }, 404)
  if (!(await hasValidTicket(request, env, record))) {
    return new Response(passwordHtml(record), { status: 401, headers: publicHeaders('text/html; charset=utf-8', { 'content-security-policy': SHELL_CSP }) })
  }
  let snapshot = null
  if (record.manifest.includesData) {
    const object = await env.PAGES.get(record.snapshotKey)
    if (!object) return json({ error: 'not_found' }, 404)
    try { snapshot = JSON.parse(await bodyText(object)) } catch { return json({ error: 'not_found' }, 404) }
  }
  return new Response(shellHtml(record, snapshot), { headers: publicHeaders('text/html; charset=utf-8', { 'content-security-policy': SHELL_CSP }) })
}

async function serveContent(request, env, id) {
  const record = await publicRecord(env, id)
  if (!record) return json({ error: 'not_found' }, 404)
  if (!(await hasValidTicket(request, env, record))) return json({ error: 'password_required' }, 401)
  const object = await env.PAGES.get(record.contentKey)
  if (!object) return json({ error: 'not_found' }, 404)
  return new Response(object.body, { headers: publicHeaders('text/html; charset=utf-8', { 'content-security-policy': contentCsp(record) }) })
}

async function serveSnapshot(request, env, id) {
  const record = await publicRecord(env, id)
  if (!record || !record.manifest.includesData) return json({ error: 'not_found' }, 404)
  if (!(await hasValidTicket(request, env, record))) return json({ error: 'password_required' }, 401)
  const object = await env.PAGES.get(record.snapshotKey)
  if (!object) return json({ error: 'not_found' }, 404)
  return new Response(object.body, { headers: publicHeaders('application/json; charset=utf-8') })
}

async function submitPassword(request, env, id) {
  const record = await publicRecord(env, id)
  if (!record || !record.password) return json({ error: 'not_found' }, 404)
  if (await rateLimited(env, 'PAGE_PASSWORD_LIMIT', request, `password:${id}`)) return json({ error: 'rate_limited' }, 429)
  let form
  try { form = await request.formData() } catch { return json({ error: 'invalid_password' }, 400) }
  const password = form.get('password')
  if (typeof password !== 'string') return json({ error: 'invalid_password' }, 400)
  const candidate = await hashPassword(password, record.password.salt, record.password.iterations)
  if (!timingSafeEqual(candidate, record.password.hash)) return json({ error: 'password_invalid' }, 401)
  const ticket = await issueTicket(env, record)
  return new Response(null, { status: 303, headers: { location: `/p/${id}`, 'set-cookie': `vorno_pages_ticket=${ticket}; Max-Age=${PASSWORD_TICKET_TTL_SECONDS}; Path=/p/${id}; HttpOnly; Secure; SameSite=Strict`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}

export async function handle(request, env) {
  const url = new URL(request.url)
  const apiMatch = url.pathname.match(/^\/api\/publications\/([A-Za-z0-9_-]+)$/)
  if (url.pathname === '/api/publications') {
    return request.method === 'POST' ? createPublication(request, env) : json({ error: 'method_not_allowed' }, 405)
  }
  if (apiMatch) {
    const id = apiMatch[1]
    if (!PAGE_ID_RE.test(id)) return json({ error: 'not_found' }, 404)
    if (request.method === 'PUT') return updatePublication(request, env, id)
    if (request.method === 'DELETE') return unpublishPublication(request, env, id)
    return json({ error: 'method_not_allowed' }, 405)
  }

  const publicMatch = url.pathname.match(/^\/p\/([A-Za-z0-9_-]+)(?:\/(content|snapshot|password))?$/)
  if (!publicMatch || !PAGE_ID_RE.test(publicMatch[1])) return json({ error: 'not_found' }, 404)
  const [, id, resource] = publicMatch
  if (!resource && request.method === 'GET') return serveShell(request, env, id)
  if (resource === 'content' && request.method === 'GET') return serveContent(request, env, id)
  if (resource === 'snapshot' && request.method === 'GET') return serveSnapshot(request, env, id)
  if (resource === 'password' && request.method === 'POST') return submitPassword(request, env, id)
  return json({ error: 'method_not_allowed' }, 405)
}

export default { fetch: handle }
