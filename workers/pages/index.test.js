/**
 * SUV-0060 security regression tests. These run without Cloudflare credentials.
 *
 * Load-bearing claims: public HTML is contained; an admin capability—not a link—
 * controls mutation; unpublish revokes before best-effort deletion; malformed or
 * oversized multipart bodies never make a public object visible.
 */
import { describe, expect, test } from 'bun:test'
import { handle, isExpired, MAX_CONTENT_BYTES, PAGE_ID_RE, randomToken, RETENTION_MS } from './index.js'

function makeBucket({ failDeletes = new Map() } = {}) {
  const objects = new Map()
  let failNextPut
  let blockNextManifest
  let revision = 0
  const drain = async value => {
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
    if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer())
    return new TextEncoder().encode(String(value))
  }
  return {
    objects,
    async put(key, value, options = {}) {
      if (blockNextManifest && key.endsWith('/manifest.json')) {
        const block = blockNextManifest
        blockNextManifest = undefined
        block.entered()
        await block.wait
      }
      if (options.onlyIf?.etagMatches && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null
      if (failNextPut?.(key)) {
        failNextPut = undefined
        throw new Error(`put failed for ${key}`)
      }
      const bytes = await drain(value)
      const etag = `etag-${++revision}`
      objects.set(key, { bytes, customMetadata: options.customMetadata, etag })
      return { etag }
    },
    async get(key) {
      const object = objects.get(key)
      return object ? { body: new Blob([object.bytes]).stream(), customMetadata: object.customMetadata, etag: object.etag } : null
    },
    async list({ prefix = '' } = {}) {
      return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }
    },
    failNextPut(predicate) { failNextPut = predicate },
    blockNextManifest() {
      let release
      let entered
      const wait = new Promise(resolve => { release = resolve })
      const enteredPromise = new Promise(resolve => { entered = resolve })
      blockNextManifest = { wait, entered }
      return { release, entered: enteredPromise }
    },
    async delete(key) {
      const remaining = failDeletes.get(key) || 0
      if (remaining) {
        failDeletes.set(key, remaining - 1)
        throw new Error(`delete failed for ${key}`)
      }
      objects.delete(key)
    },
  }
}

function makeEnv(overrides = {}) {
  return {
    PAGES: makeBucket(),
    PAGE_CREATE_LIMIT: { limit: async () => ({ success: true }) },
    PAGE_PASSWORD_LIMIT: { limit: async () => ({ success: true }) },
    PASSWORD_TICKET_SECRET: 'test-only-ticket-secret',
    // Tests exercise ticket lifecycle, not PBKDF CPU cost; production uses the measured default.
    PBKDF2_ITERATIONS: 1,
    ...overrides,
  }
}

const req = (path, init) => new Request(`https://pages.vorno.ai${path}`, init)
const digest = 'a'.repeat(64)

function bundle({ content = '<!doctype html><script>fetch("https://evil.example")</script>', snapshot, password } = {}) {
  const form = new FormData()
  form.set('manifest', JSON.stringify({ version: 1, slug: 'report', title: 'Report', kind: 'interactive', contentDigest: digest, includesData: snapshot !== undefined }))
  form.set('content', new Blob([content], { type: 'text/html' }), 'index.html')
  if (snapshot !== undefined) form.set('snapshot', new Blob([JSON.stringify(snapshot)], { type: 'application/json' }), 'snapshot.json')
  if (password !== undefined) form.set('password', password)
  return form
}

async function create(env, options = {}) {
  const response = await handle(req('/api/publications', { method: 'POST', body: bundle(options) }), env)
  return { response, data: await response.json() }
}

function auth(token) {
  return { authorization: `Bearer ${token}` }
}

async function content(env, id, headers = {}) {
  return handle(req(`/p/${id}/content`, { headers }), env)
}

describe('publication capabilities', () => {
  test('mints opaque IDs and one-time admin token while persisting only a hash', async () => {
    const env = makeEnv()
    const { response, data } = await create(env)
    expect(response.status).toBe(201)
    expect(data.id).toMatch(PAGE_ID_RE)
    expect(data.url).toBe(`https://pages.vorno.ai/p/${data.id}`)
    expect(data.adminToken).toHaveLength(43)
    expect(data.url).not.toContain(data.adminToken)
    const stored = new TextDecoder().decode(env.PAGES.objects.get(`${data.id}/manifest.json`).bytes)
    expect(stored).toContain('adminTokenHash')
    expect(stored).not.toContain(data.adminToken)
    expect(new Set(Array.from({ length: 1000 }, () => randomToken(16))).size).toBe(1000)
  })

  test('rejects unauthenticated mutation without changing public content', async () => {
    const env = makeEnv()
    const { data } = await create(env, { content: '<p>original</p>' })
    const update = await handle(req(`/api/publications/${data.id}`, { method: 'PUT', body: bundle({ content: '<p>evil</p>' }) }), env)
    expect(update.status).toBe(401)
    expect(await (await content(env, data.id)).text()).toBe('<p>original</p>')
    const idToken = await handle(req(`/api/publications/${data.id}`, { method: 'DELETE', headers: auth(data.id) }), env)
    expect(idToken.status).toBe(401)
    expect((await content(env, data.id)).status).toBe(200)
  })

  test('leaves the current public revision unchanged and cleans staging keys when an update write fails', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env, { content: '<p>original</p>', snapshot: { version: 1 } })
    bucket.failNextPut(key => key.endsWith('/snapshot.json'))
    const response = await handle(req(`/api/publications/${data.id}`, {
      method: 'PUT', headers: auth(data.adminToken), body: bundle({ content: '<p>new</p>', snapshot: { version: 2} }),
    }), env)
    expect(response.status).toBe(503)
    expect(await (await content(env, data.id)).text()).toBe('<p>original</p>')
    const keys = [...bucket.objects.keys()]
    expect(keys.filter(key => key.includes('/revisions/')).length).toBe(2)
  })

  test('a stale update cannot resurrect a publication after concurrent logical revocation', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env)
    const block = bucket.blockNextManifest()
    const update = handle(req(`/api/publications/${data.id}`, { method: 'PUT', headers: auth(data.adminToken), body: bundle({ content: '<p>stale update</p>' }) }), env)
    await block.entered
    const deleted = await handle(req(`/api/publications/${data.id}`, { method: 'DELETE', headers: auth(data.adminToken) }), env)
    expect(deleted.status).toBe(200)
    block.release()
    expect((await update).status).toBe(409)
    expect((await content(env, data.id)).status).toBe(404)
  })

  test('changes revision only for content updates, never a password-only update', async () => {
    const env = makeEnv()
    const { data } = await create(env)
    const password = new FormData()
    password.set('passwordAction', 'set')
    password.set('password', 'password-long-enough')
    const passwordResult = await handle(req(`/api/publications/${data.id}`, { method: 'PUT', headers: auth(data.adminToken), body: password }), env)
    expect(passwordResult.status).toBe(200)
    expect((await passwordResult.json()).revision).toBe(data.revision)
    const contentResult = await handle(req(`/api/publications/${data.id}`, { method: 'PUT', headers: auth(data.adminToken), body: bundle({ content: '<p>revised</p>' }) }), env)
    expect(contentResult.status).toBe(200)
    expect((await contentResult.json()).revision).not.toBe(data.revision)
  })
})

describe('multipart caps and rate brakes', () => {
  test('rejects an oversized content body without Content-Length and leaves no partial object', async () => {
    const env = makeEnv()
    const form = bundle({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) })
    const request = req('/api/publications', { method: 'POST', body: form })
    expect(request.headers.get('content-length')).toBeNull()
    const response = await handle(request, env)
    expect(response.status).toBe(413)
    expect(env.PAGES.objects.size).toBe(0)
  })

  test('rejects both oversized and understated dishonest Content-Length values without partial persistence', async () => {
    const earlyEnv = makeEnv()
    const early = await handle(req('/api/publications', {
      method: 'POST',
      headers: { 'content-length': String(11 * 1024 * 1024) },
      body: 'not-even-multipart',
    }), earlyEnv)
    expect(early.status).toBe(413)
    expect(earlyEnv.PAGES.objects.size).toBe(0)

    const lowEnv = makeEnv()
    const low = await handle(req('/api/publications', {
      method: 'POST',
      // The sender claims one byte but the multipart content itself exceeds the cap.
      headers: { 'content-length': '1' },
      body: bundle({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }),
    }), lowEnv)
    expect(low.status).toBe(413)
    expect(lowEnv.PAGES.objects.size).toBe(0)
  })

  test('rejects malformed opted-in snapshot JSON before persistence', async () => {
    const invalidSnapshot = makeEnv()
    const malformed = bundle({ snapshot: '{not-json' })
    // Replace the blob with malformed JSON without changing the opt-in manifest.
    malformed.set('snapshot', new Blob(['{not-json']), 'snapshot.json')
    expect((await handle(req('/api/publications', { method: 'POST', body: malformed }), invalidSnapshot)).status).toBe(400)
    expect(invalidSnapshot.PAGES.objects.size).toBe(0)
  })

  test('caps raw multipart bytes before parsing unused chunked fields', async () => {
    const env = makeEnv()
    const form = bundle()
    form.set('ignored', new Blob(['x'.repeat(11 * 1024 * 1024)]), 'ignored.bin')
    const response = await handle(req('/api/publications', { method: 'POST', body: form }), env)
    expect(response.status).toBe(413)
    expect(env.PAGES.objects.size).toBe(0)
  })

  test('fails closed when the create limiter is absent, denies, or throws', async () => {
    const denied = makeEnv({ PAGE_CREATE_LIMIT: { limit: async () => ({ success: false }) } })
    expect((await create(denied)).response.status).toBe(429)
    expect(denied.PAGES.objects.size).toBe(0)
    const unavailable = makeEnv({ PAGE_CREATE_LIMIT: { limit: async () => { throw new Error('down') } } })
    expect((await create(unavailable)).response.status).toBe(429)
    const missing = makeEnv({ PAGE_CREATE_LIMIT: undefined })
    expect((await create(missing)).response.status).toBe(429)
  })
})

describe('public containment and snapshot opt-in', () => {
  test('serves HTML only in the opaque sandbox shell with strict no-egress CSP and no public bridge actions', async () => {
    const env = makeEnv()
    const { data } = await create(env)
    const publicContent = await content(env, data.id)
    expect(publicContent.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(publicContent.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
    expect(publicContent.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
    expect(publicContent.headers.get('x-content-type-options')).toBe('nosniff')
    expect(publicContent.headers.get('cache-control')).toBe('no-store')
    const shell = await handle(req(`/p/${data.id}`), env)
    const html = await shell.text()
    expect(html).toContain('Published by a Vorno user — not by Vorno')
    expect(html).toContain('src="/p/')
    expect(html).toContain('sandbox="allow-scripts allow-forms"')
    expect(html).toContain('public-actions-disabled')
    expect(html).toContain("grants:[]")
    expect(html).not.toContain('window.open')
  })

  test('sandboxes direct static documents without allowing scripts', async () => {
    const env = makeEnv()
    const form = bundle();
    form.set('manifest', JSON.stringify({ version: 1, slug: 'static', title: 'Static', kind: 'static', contentDigest: digest, includesData: false }))
    const created = await handle(req('/api/publications', { method: 'POST', body: form }), env)
    const data = await created.json()
    const direct = await content(env, data.id)
    expect(direct.headers.get('content-security-policy')).toContain('; sandbox')
    expect(direct.headers.get('content-security-policy')).not.toContain('sandbox allow-scripts')
  })

  test('never exposes a snapshot unless the publisher explicitly included one', async () => {
    const env = makeEnv()
    const privateSnapshot = await create(env)
    expect((await handle(req(`/p/${privateSnapshot.data.id}/snapshot`), env)).status).toBe(404)
    const included = await create(env, { snapshot: { version: 1, kv: { count: 2 }, series: {} } })
    const response = await handle(req(`/p/${included.data.id}/snapshot`), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.json()).toEqual({ version: 1, kv: { count: 2 }, series: {} })
  })
})

describe('password protection', () => {
  test('requires a correctly rate-limited password ticket for shell, content, and snapshot', async () => {
    const env = makeEnv()
    const { data } = await create(env, { password: 'password-long-enough', snapshot: { version: 1 } })
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(401)
    expect((await content(env, data.id)).status).toBe(401)
    expect((await handle(req(`/p/${data.id}/snapshot`), env)).status).toBe(401)

    const wrong = new FormData(); wrong.set('password', 'wrong-password')
    expect((await handle(req(`/p/${data.id}/password`, { method: 'POST', body: wrong }), env)).status).toBe(401)
    const right = new FormData(); right.set('password', 'password-long-enough')
    const ticketResponse = await handle(req(`/p/${data.id}/password`, { method: 'POST', body: right }), env)
    expect(ticketResponse.status).toBe(303)
    const cookie = ticketResponse.headers.get('set-cookie').split(';')[0]
    expect((await content(env, data.id, { cookie })).status).toBe(200)

    const oversized = new FormData(); oversized.set('password', 'password-long-enough'); oversized.set('ignored', new Blob(['x'.repeat(20 * 1024)]), 'ignored.txt')
    expect((await handle(req(`/p/${data.id}/password`, { method: 'POST', body: oversized }), env)).status).toBe(413)
    const understated = new FormData(); understated.set('password', 'password-long-enough'); understated.set('ignored', new Blob(['x'.repeat(20 * 1024)]), 'ignored.txt')
    expect((await handle(req(`/p/${data.id}/password`, { method: 'POST', headers: { 'content-length': '1' }, body: understated }), env)).status).toBe(413)

    const denied = makeEnv({ PAGE_PASSWORD_LIMIT: { limit: async () => ({ success: false }) } })
    const deniedCreate = await create(denied, { password: 'password-long-enough' })
    const deniedForm = new FormData(); deniedForm.set('password', 'password-long-enough')
    expect((await handle(req(`/p/${deniedCreate.data.id}/password`, { method: 'POST', body: deniedForm }), denied)).status).toBe(429)
    const unavailable = makeEnv({ PAGE_PASSWORD_LIMIT: { limit: async () => { throw new Error('down') } } })
    const unavailableCreate = await create(unavailable, { password: 'password-long-enough' })
    const unavailableForm = new FormData(); unavailableForm.set('password', 'password-long-enough')
    expect((await handle(req(`/p/${unavailableCreate.data.id}/password`, { method: 'POST', body: unavailableForm }), unavailable)).status).toBe(429)
  })

  test('clearing a password does not modify content and makes the public route immediately accessible', async () => {
    const env = makeEnv()
    const { data } = await create(env, { content: '<p>same</p>', password: 'password-long-enough' })
    const clear = new FormData(); clear.set('passwordAction', 'clear')
    expect((await handle(req(`/api/publications/${data.id}`, { method: 'PUT', headers: auth(data.adminToken), body: clear }), env)).status).toBe(200)
    expect(await (await content(env, data.id)).text()).toBe('<p>same</p>')
  })
})

describe('revocation and deletion recovery', () => {
  test('logically revokes every public route before a physical deletion failure, records it, and retries with the same admin token', async () => {
    const failures = new Map()
    const bucket = makeBucket({ failDeletes: failures })
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env, { snapshot: { version: 1 } })
    const activeRecord = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${data.id}/manifest.json`).bytes))
    failures.set(activeRecord.contentKey, 1)
    const first = await handle(req(`/api/publications/${data.id}`, { method: 'DELETE', headers: auth(data.adminToken) }), env)
    expect(first.status).toBe(200)
    expect((await first.json()).cleanupPending).toBe(true)
    for (const suffix of ['', '/content', '/snapshot']) {
      expect((await handle(req(`/p/${data.id}${suffix}`), env)).status).toBe(404)
    }
    const audit = new TextDecoder().decode(bucket.objects.get(`${data.id}/manifest.json`).bytes)
    expect(audit).toContain('"state":"pending"')
    expect(audit).toContain('delete failed')
    const retry = await handle(req(`/api/publications/${data.id}`, { method: 'DELETE', headers: auth(data.adminToken) }), env)
    expect((await retry.json()).cleanupPending).toBe(false)
    expect(bucket.objects.has(activeRecord.contentKey)).toBe(false)
  })
})

/**
 * SUV-0069 — the 30-day retention TTL.
 *
 * The Worker publishes a deletion promise at /privacy, so these tests are about
 * that promise being TRUE rather than about a cache expiring. An R2 lifecycle
 * rule deletes the bytes, but R2 evaluates lifecycle asynchronously and can run
 * hours late; the read path is what makes the deadline exact, so it is the half
 * that can be tested here at all.
 */
describe('retention TTL', () => {
  const DAY = 24 * 60 * 60 * 1000

  /** Backdate the CONTENT write, the only input the deadline reads. */
  function setUpdatedAt(bucket, id, contentUpdatedAt) {
    const key = `${id}/manifest.json`
    const record = JSON.parse(new TextDecoder().decode(bucket.objects.get(key).bytes))
    record.contentUpdatedAt = contentUpdatedAt
    const existing = bucket.objects.get(key)
    bucket.objects.set(key, { ...existing, bytes: new TextEncoder().encode(JSON.stringify(record)) })
    return record
  }

  test('serves at the deadline and refuses past it', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env)

    // Just INSIDE the window. The comparison is strictly greater-than, so the
    // last moment belongs to the publisher — an off-by-one here deletes a day
    // early, which is worse than a second late because it breaks a live link
    // before the promise fell due.
    //
    // The margin is not padding. `Date.now() - 30 * DAY` lands exactly ON the
    // boundary, and the Worker reads its own clock a few milliseconds later, so
    // elapsed is 30 days + ε and the page expires — a test that passes or fails
    // on scheduling luck. Measured at roughly a coin flip before this margin was
    // added. One second either side is far inside the resolution of a 30-day
    // rule and makes both directions deterministic.
    setUpdatedAt(bucket, data.id, Date.now() - 30 * DAY + 1000)
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(200)

    setUpdatedAt(bucket, data.id, Date.now() - 30 * DAY - 1000)
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(404)
  })

  test('an expired page is indistinguishable from one that never existed', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env, { snapshot: { version: 1 } })
    setUpdatedAt(bucket, data.id, Date.now() - 31 * DAY)

    // Every public route, and byte-for-byte the same answer as a random id.
    // Anything that separated "lapsed" from "never existed" would disclose
    // someone else's publishing history to an unauthenticated caller.
    const unknown = randomToken(8)
    for (const suffix of ['', '/content', '/snapshot']) {
      const expired = await handle(req(`/p/${data.id}${suffix}`), env)
      const missing = await handle(req(`/p/${unknown}${suffix}`), env)
      expect(expired.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(await expired.text()).toBe(await missing.text())
    }
  })

  test('the password gate does not leak an expired publication either', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env, { password: 'correct horse battery' })
    // Fresh, it answers the password challenge rather than 404 — so the 404
    // below is the retention check and not simply a missing page.
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(401)

    setUpdatedAt(bucket, data.id, Date.now() - 31 * DAY)
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(404)
    const form = new FormData()
    form.set('password', 'correct horse battery')
    const submit = await handle(req(`/p/${data.id}/password`, { method: 'POST', body: form }), env)
    expect(submit.status).toBe(404)
  })

  test('an update restarts the window', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env)

    // Day 29: nearly expired, still live, and the owner updates it.
    setUpdatedAt(bucket, data.id, Date.now() - 29 * DAY)
    const update = await handle(req(`/api/publications/${data.id}`, {
      method: 'PUT', headers: auth(data.adminToken), body: bundle({ content: '<p>revised</p>' }),
    }), env)
    expect(update.status).toBe(200)

    // The deadline now runs from the update, so what would have been day 31 of
    // the original window is day 2 of the new one.
    setUpdatedAt(bucket, data.id, Date.now() - 2 * DAY)
    const served = await handle(req(`/p/${data.id}/content`), env)
    expect(served.status).toBe(200)
    expect(await served.text()).toContain('revised')
  })

  test('an owner can still unpublish and clean up after the deadline', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env, { snapshot: { version: 1 } })
    const record = setUpdatedAt(bucket, data.id, Date.now() - 40 * DAY)
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(404)

    // Retention withdraws PUBLIC access. Admin routes authenticate against the
    // record directly, so an owner who wants the objects gone is never stranded
    // by the very deadline that hid them.
    const unpublish = await handle(req(`/api/publications/${data.id}`, { method: 'DELETE', headers: auth(data.adminToken) }), env)
    expect(unpublish.status).toBe(200)
    expect((await unpublish.json()).cleanupPending).toBe(false)
    expect(bucket.objects.has(record.contentKey)).toBe(false)
  })

  test('a manifest that cannot prove its age is treated as expired', async () => {
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env)
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(200)

    // Unreachable through this Worker — every write stamps `updatedAt` — so this
    // is corruption or a hand-edited object. Failing closed means the objects we
    // have lost track of are exactly the ones that stop being served, rather
    // than the ones that outlive the policy forever.
    for (const bad of [undefined, 'yesterday', Number.NaN]) {
      setUpdatedAt(bucket, data.id, bad)
      expect((await handle(req(`/p/${data.id}`), env)).status).toBe(404)
    }
  })

  test('a password change does not extend retention', async () => {
    // The regression that made this field exist. The R2 lifecycle rule deletes
    // an object 30 days after ITS OWN upload and cannot see manifest writes, so
    // a deadline that moved on a manifest-only write drifted away from the rule
    // enforcing it: the bytes went at day 30 while the Worker still called the
    // page live, leaving a shell that renders over an iframe that 404s — both a
    // broken page and a signal that something was published here once.
    const bucket = makeBucket()
    const env = makeEnv({ PAGES: bucket })
    const { data } = await create(env)
    setUpdatedAt(bucket, data.id, Date.now() - 29 * DAY)

    const form = new FormData()
    form.set('passwordAction', 'set')
    form.set('password', 'correct horse battery')
    const changed = await handle(req(`/api/publications/${data.id}`, { method: 'PUT', headers: auth(data.adminToken), body: form }), env)
    expect(changed.status).toBe(200)

    // The content anchor did not move, so the deadline did not move.
    const record = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${data.id}/manifest.json`).bytes))
    expect(Date.now() - record.contentUpdatedAt).toBeGreaterThan(28 * DAY)
    // And two days later — day 31 of the ORIGINAL window — it is gone, not
    // living on a window a password change bought it.
    setUpdatedAt(bucket, data.id, Date.now() - 31 * DAY)
    expect((await handle(req(`/p/${data.id}`), env)).status).toBe(404)
  })

  test('the deadline is strictly greater-than, to the millisecond', async () => {
    // `isExpired` takes `now` so the boundary can be pinned EXACTLY, with no
    // clock between the fixture and the assertion. The route-level test above
    // has to leave a second of margin to stay deterministic, which makes it
    // blind to a one-millisecond off-by-one; this is the half that sees it.
    const at = { contentUpdatedAt: 1_000_000 }
    expect(isExpired(at, 1_000_000 + RETENTION_MS)).toBe(false)
    expect(isExpired(at, 1_000_000 + RETENTION_MS + 1)).toBe(true)
  })
})
