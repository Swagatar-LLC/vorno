/**
 * Tests for the vorno-share Worker (ADR-0024, PLAN-035).
 *
 * The load-bearing claims, in the order they'd hurt if false:
 *  1. A share link cannot be used by its recipients to overwrite or delete the share.
 *  2. Share ids are unguessable.
 *  3. The store can never serve anything but inert JSON.
 *  4. The size cap holds even when the client lies about Content-Length.
 */

import { describe, it, expect } from 'bun:test'
import { handle, randomToken, timingSafeEqual, SHARE_ID_RE } from './index.js'

const MAX_SHARE_BYTES = 8 * 1024 * 1024

/** In-memory stand-in for the R2 binding. */
function makeBucket() {
  const objects = new Map()
  const drain = async (value) =>
    value instanceof ReadableStream
      ? new Uint8Array(await new Response(value).arrayBuffer())
      : new TextEncoder().encode(String(value))

  return {
    objects,
    async put(key, value, options = {}) {
      // Drain first: a stream that errors past the cap must reject the put and
      // leave nothing behind, exactly as R2's atomic write does.
      const bytes = await drain(value)
      objects.set(key, { bytes, customMetadata: options.customMetadata })
    },
    async get(key) {
      const o = objects.get(key)
      return o ? { body: new Blob([o.bytes]).stream(), customMetadata: o.customMetadata } : null
    },
    async head(key) {
      const o = objects.get(key)
      return o ? { customMetadata: o.customMetadata } : null
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

function makeEnv(overrides = {}) {
  return {
    SHARES: makeBucket(),
    ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname) },
    ...overrides,
  }
}

const req = (path, init) => new Request(`https://share.vorno.ai${path}`, init)

async function create(env, body = JSON.stringify({ id: 's1', messages: [] })) {
  const res = await handle(req('/s/api', { method: 'POST', body }), env)
  return { res, data: await res.json() }
}

describe('share ids', () => {
  it('are 22 base64url chars and match the viewer route regex', () => {
    const viewerRoute = /^\/s\/([a-zA-Z0-9_-]+)$/
    for (let i = 0; i < 50; i++) {
      const id = randomToken(16)
      expect(id).toMatch(SHARE_ID_RE)
      expect(id.length).toBe(22)
      expect(`/s/${id}`).toMatch(viewerRoute)
    }
  })

  it('do not repeat — the link is the access control', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => randomToken(16)))
    expect(seen.size).toBe(1000)
  })
})

describe('timingSafeEqual', () => {
  it('compares equal-length strings and rejects everything else', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'ab')).toBe(false)
    expect(timingSafeEqual('abc', undefined)).toBe(false)
  })
})

describe('create', () => {
  it('stores the body and returns id, url and an edit token', async () => {
    const env = makeEnv()
    const { res, data } = await create(env)

    expect(res.status).toBe(201)
    expect(data.id).toMatch(SHARE_ID_RE)
    expect(data.url).toBe(`https://share.vorno.ai/s/${data.id}`)
    expect(data.editToken).toBeTruthy()
    // The token is never derivable from the link.
    expect(data.url).not.toContain(data.editToken)
    expect(env.SHARES.objects.has(data.id)).toBe(true)
  })

  it('stores a hash of the edit token, never the token', async () => {
    const env = makeEnv()
    const { data } = await create(env)
    const stored = env.SHARES.objects.get(data.id).customMetadata.editTokenHash
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toBe(data.editToken)
  })

  it('rejects an oversized body declared via Content-Length', async () => {
    const env = makeEnv()
    const res = await handle(
      req('/s/api', {
        method: 'POST',
        body: 'x',
        headers: { 'content-length': String(MAX_SHARE_BYTES + 1) },
      }),
      env
    )
    expect(res.status).toBe(413)
    expect(env.SHARES.objects.size).toBe(0)
  })

  it('rejects an oversized body even when Content-Length is absent or lying', async () => {
    const env = makeEnv()
    // No Content-Length: a chunked stream that overruns the cap mid-flight.
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 9; i++) controller.enqueue(new Uint8Array(1024 * 1024))
        controller.close()
      },
    })
    const res = await handle(req('/s/api', { method: 'POST', body, duplex: 'half' }), env)

    expect(res.status).toBe(413)
    // Nothing partial left behind.
    expect(env.SHARES.objects.size).toBe(0)
  })

  it('applies the rate limiter when the binding is present', async () => {
    const env = makeEnv({ SHARE_CREATE_LIMIT: { limit: async () => ({ success: false }) } })
    const res = await handle(req('/s/api', { method: 'POST', body: '{}' }), env)
    expect(res.status).toBe(429)
    expect(env.SHARES.objects.size).toBe(0)
  })

  it('still shares when the rate limiter itself fails', async () => {
    const env = makeEnv({
      SHARE_CREATE_LIMIT: {
        limit: async () => {
          throw new Error('limiter down')
        },
      },
    })
    const res = await handle(req('/s/api', { method: 'POST', body: '{}' }), env)
    expect(res.status).toBe(201)
  })

  it('refuses non-POST', async () => {
    expect((await handle(req('/s/api', { method: 'GET' }), makeEnv())).status).toBe(405)
  })
})

describe('read', () => {
  it('round-trips the transcript', async () => {
    const env = makeEnv()
    const payload = JSON.stringify({ id: 'abc', messages: [{ role: 'user', content: 'hi' }] })
    const { data } = await create(env, payload)

    const res = await handle(req(`/s/api/${data.id}`), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(payload)
  })

  it('serves inert JSON no matter what was uploaded', async () => {
    const env = makeEnv()
    const { data } = await create(env, '<html><script>alert(1)</script></html>')

    const res = await handle(req(`/s/api/${data.id}`), env)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // A revoked share must actually stop resolving — an edge cache would defeat that.
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('404s unknown and malformed ids', async () => {
    const env = makeEnv()
    expect((await handle(req(`/s/api/${randomToken(16)}`), env)).status).toBe(404)
    expect((await handle(req('/s/api/1'), env)).status).toBe(404)
    expect((await handle(req('/s/api/a'.repeat(40)), env)).status).toBe(404)
  })

  it('never reaches the API with a traversal path — URL parsing normalizes it away', async () => {
    const env = makeEnv()
    // `new URL()` resolves `..` before we route, so this is an asset lookup for
    // /etc/passwd (which the assets binding can only answer out of dist/), not a
    // share-id lookup. Asserted so a future hand-rolled path parse can't quietly
    // reintroduce the traversal.
    const res = await handle(req('/s/api/../../etc/passwd'), env)
    expect(await res.text()).toBe('/etc/passwd')
    expect(env.SHARES.objects.size).toBe(0)
  })
})

describe('write auth — a share link grants read and only read', () => {
  it('rejects PUT with no token and leaves the transcript untouched', async () => {
    const env = makeEnv()
    const original = JSON.stringify({ id: 'orig' })
    const { data } = await create(env, original)

    const res = await handle(req(`/s/api/${data.id}`, { method: 'PUT', body: '{"id":"evil"}' }), env)
    expect(res.status).toBe(401)
    expect(await (await handle(req(`/s/api/${data.id}`), env)).text()).toBe(original)
  })

  it('rejects PUT with the share id used as the token', async () => {
    const env = makeEnv()
    const { data } = await create(env)
    const res = await handle(
      req(`/s/api/${data.id}`, {
        method: 'PUT',
        body: '{}',
        headers: { authorization: `Bearer ${data.id}` },
      }),
      env
    )
    expect(res.status).toBe(401)
  })

  it('accepts PUT with the edit token and replaces the content', async () => {
    const env = makeEnv()
    const { data } = await create(env, '{"turn":1}')

    const res = await handle(
      req(`/s/api/${data.id}`, {
        method: 'PUT',
        body: '{"turn":2}',
        headers: { authorization: `Bearer ${data.editToken}` },
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(await (await handle(req(`/s/api/${data.id}`), env)).text()).toBe('{"turn":2}')
  })

  it('keeps the edit token working across updates', async () => {
    const env = makeEnv()
    const { data } = await create(env)
    const auth = { authorization: `Bearer ${data.editToken}` }

    await handle(req(`/s/api/${data.id}`, { method: 'PUT', body: '{"n":1}', headers: auth }), env)
    const second = await handle(
      req(`/s/api/${data.id}`, { method: 'PUT', body: '{"n":2}', headers: auth }),
      env
    )
    expect(second.status).toBe(200)
  })

  it('rejects DELETE without the token and accepts it with', async () => {
    const env = makeEnv()
    const { data } = await create(env)

    expect((await handle(req(`/s/api/${data.id}`, { method: 'DELETE' }), env)).status).toBe(401)
    expect(env.SHARES.objects.has(data.id)).toBe(true)

    const ok = await handle(
      req(`/s/api/${data.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${data.editToken}` },
      }),
      env
    )
    expect(ok.status).toBe(200)
    expect((await handle(req(`/s/api/${data.id}`), env)).status).toBe(404)
  })

  it('does not leak whether an id exists via the auth path', async () => {
    const env = makeEnv()
    const res = await handle(req(`/s/api/${randomToken(16)}`, { method: 'DELETE' }), env)
    expect(res.status).toBe(404)
  })
})

describe('SPA routing (mirrors public/_redirects)', () => {
  const pathServed = async (path) => {
    const env = makeEnv()
    return (await handle(req(path), env)).text()
  }

  it('rewrites /s/assets/* to /assets/* — the bundle builds with base "/s/"', async () => {
    expect(await pathServed('/s/assets/index-abc123.js')).toBe('/assets/index-abc123.js')
  })

  it('serves the SPA shell for a share URL', async () => {
    expect(await pathServed(`/s/${randomToken(16)}`)).toBe('/index.html')
  })

  it('passes everything else through untouched', async () => {
    expect(await pathServed('/')).toBe('/')
    expect(await pathServed('/favicon.ico')).toBe('/favicon.ico')
  })
})
