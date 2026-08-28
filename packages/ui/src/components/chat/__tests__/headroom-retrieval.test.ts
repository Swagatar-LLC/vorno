/**
 * User-visible retrieval of compressed originals (fork: PLAN-040 / SUV-0026).
 *
 * These exercise the decisions the session view makes about compression, which
 * is where every one of the SUV's acceptance items actually lives:
 *
 *   1. an indicator appears for a compressed item, with both measured sizes,
 *      and nothing new appears for an uncompressed one
 *   2. "view original" yields content byte-identical to the pre-compression
 *      original — driven end to end through the real `compressToolOutput` and a
 *      real `HeadroomAdapter`, not against a hand-written fixture
 *   3. a failed retrieval produces an explicit error and no content
 *   4. with Headroom disabled there is no marker, therefore no indicator — the
 *      view has nothing extra to render, dormant or otherwise
 *
 * The round-trip case is deliberately not a unit test of `resolveHeadroomOriginal`
 * with a stubbed retriever. The claim worth defending is that the bytes the user
 * sees are the bytes that existed before compression, and the only way to test
 * that is to compress a known payload for real and redeem the handle the
 * compression actually issued.
 */

import { describe, expect, it } from 'bun:test'

import type { HeadroomAdapter, HeadroomRetrieveResult } from '@craft-agent/core/types'
import { createHeadroomAdapter } from '@craft-agent/shared/headroom'
import type { HeadroomSdkClient, HeadroomSdkModule } from '@craft-agent/shared/headroom'
import { compressToolOutput } from '@craft-agent/shared/headroom/tool-output'

import {
  formatByteSize,
  headroomErrorMessageKey,
  headroomIndicatorFor,
  resolveHeadroomOriginal,
} from '../headroom-retrieval'
import { messageToActivity } from '../turn-utils'
import type { Message } from '@craft-agent/core'

// ---------------------------------------------------------------------------
// A Headroom service that genuinely compresses and genuinely stores
// ---------------------------------------------------------------------------

/**
 * The payload the round trip is asserted against.
 *
 * Multi-byte characters, a trailing newline, CRLF, and a lone `\r` are all in
 * here on purpose: they are what a "byte-identical" claim is worth testing
 * with, because every one of them survives a sloppy trim or normalization
 * differently. A test built from plain ASCII would pass against an
 * implementation that quietly normalized line endings.
 */
const KNOWN_PAYLOAD = [
  'total 48',
  '-rw-r--r--  1 jh  staff   1.2K Aug 26 12:00 café.txt',
  '-rw-r--r--  1 jh  staff   3.4K Aug 26 12:01 日本語.md',
  'trailing whitespace:   ',
  'carriage\r\nreturn\rmix',
  '',
].join('\n') + '\n'

interface FakeService {
  store: Map<string, string>
  /** Set to make `retrieve` fail the way an unreachable service does. */
  retrieveThrows: boolean
  /** Set to make `retrieve` answer for no handle, i.e. a genuine 404. */
  forgetEverything: boolean
}

function fakeSdk(service: FakeService): HeadroomSdkModule {
  return {
    HeadroomClient: class implements HeadroomSdkClient {
      async compress(messages: unknown[]): Promise<unknown> {
        const first = messages[0] as Record<string, unknown>
        const original = String(first.content)
        const handle = 'ccr_suv0026_handle'
        service.store.set(handle, original)
        const compressed = `[compressed: ${original.length} chars]`
        return {
          compressed: true,
          messages: [
            { role: 'tool', content: compressed, tool_call_id: first.tool_call_id },
          ],
          ccrHashes: [handle],
          tokensBefore: Math.ceil(original.length / 4),
          tokensAfter: Math.ceil(compressed.length / 4),
          tokensSaved: Math.ceil((original.length - compressed.length) / 4),
          compressionRatio: compressed.length / original.length,
          transformsApplied: ['ccr'],
        }
      }
      async retrieve(hash: string): Promise<unknown> {
        if (service.retrieveThrows) throw new Error('connection refused')
        const content = service.forgetEverything ? undefined : service.store.get(hash)
        if (content === undefined) {
          throw Object.assign(new Error('not found'), { statusCode: 404 })
        }
        return { originalContent: content }
      }
      async getStats(): Promise<unknown> {
        return null
      }
    },
  }
}

function service(): FakeService {
  return { store: new Map(), retrieveThrows: false, forgetEverything: false }
}

function adapterFor(svc: FakeService, enabled = true): Promise<HeadroomAdapter> {
  return createHeadroomAdapter({ enabled, model: 'test-model' }, { loadSdk: async () => fakeSdk(svc) })
}

/** A tool message as the session view would hold it, after `content` compression. */
function toolMessage(extra: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    role: 'tool',
    content: '',
    timestamp: 1,
    toolName: 'Bash',
    toolUseId: 'toolu_suv0026',
    toolResult: '[compressed]',
    toolStatus: 'completed',
    ...extra,
  }
}

// ===========================================================================
// Acceptance 1 + 4 — the indicator appears only where it is warranted
// ===========================================================================

describe('SUV-0026 acceptance 1: compressed items show an indicator with both sizes', () => {
  it('reads a complete marker off the activity', () => {
    const activity = messageToActivity(
      toolMessage({
        headroomHandle: 'ccr_abc',
        headroomOriginalBytes: 20_480,
        headroomCompressedBytes: 1_024,
      }),
    )

    const indicator = headroomIndicatorFor(activity)

    expect(indicator).not.toBeNull()
    expect(indicator?.handle).toBe('ccr_abc')
    expect(indicator?.originalBytes).toBe(20_480)
    expect(indicator?.compressedBytes).toBe(1_024)
    expect(indicator?.savedBytes).toBe(19_456)
  })

  it('renders both sizes as byte quantities, the unit that was measured', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1_024)).toBe('1.0 KB')
    expect(formatByteSize(20_480)).toBe('20.0 KB')
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('floors the saving rather than reporting a negative one', () => {
    const indicator = headroomIndicatorFor({
      headroomHandle: 'ccr_grew',
      headroomOriginalBytes: 100,
      headroomCompressedBytes: 140,
    })

    expect(indicator?.savedBytes).toBe(0)
    // Both absolutes are still reported, so the floor hides nothing.
    expect(indicator?.originalBytes).toBe(100)
    expect(indicator?.compressedBytes).toBe(140)
  })
})

describe('SUV-0026 acceptance 1 + 4: uncompressed items show nothing new', () => {
  it('yields no indicator for an ordinary tool activity', () => {
    expect(headroomIndicatorFor(messageToActivity(toolMessage()))).toBeNull()
  })

  it('adds no keys at all to an uncompressed activity', () => {
    const activity = messageToActivity(toolMessage()) as Record<string, unknown>

    // Not "is undefined" — absent. A dormant key is how a hidden indicator
    // starts, and acceptance 4 is about there being nothing to hide.
    expect('headroomHandle' in activity).toBe(false)
    expect('headroomOriginalBytes' in activity).toBe(false)
    expect('headroomCompressedBytes' in activity).toBe(false)
  })

  it('refuses a partial marker rather than showing a size it was not given', () => {
    expect(headroomIndicatorFor({ headroomHandle: 'ccr_abc' })).toBeNull()
    expect(headroomIndicatorFor({ headroomHandle: 'ccr_abc', headroomOriginalBytes: 10 })).toBeNull()
    expect(headroomIndicatorFor({ headroomOriginalBytes: 10, headroomCompressedBytes: 2 })).toBeNull()
    expect(
      headroomIndicatorFor({ headroomHandle: '', headroomOriginalBytes: 10, headroomCompressedBytes: 2 }),
    ).toBeNull()
  })

  it('yields no indicator for null, undefined, or an unrelated object', () => {
    expect(headroomIndicatorFor(null)).toBeNull()
    expect(headroomIndicatorFor(undefined)).toBeNull()
    expect(headroomIndicatorFor({})).toBeNull()
  })
})

describe('SUV-0026 acceptance 4: a Headroom-disabled workspace produces no marker', () => {
  it('leaves the tool output uncompressed and unmarked, so the view has nothing to render', async () => {
    const svc = service()
    const adapter = await adapterFor(svc, false)

    const compression = await compressToolOutput(adapter, {
      toolCallId: 'toolu_suv0026',
      toolName: 'Bash',
      content: KNOWN_PAYLOAD,
    })

    expect(compression.handle).toBeUndefined()
    expect(compression.originalBytes).toBeUndefined()
    expect(compression.compressedBytes).toBeUndefined()
    expect(compression.content).toBe(KNOWN_PAYLOAD)

    // Which is exactly the input the indicator refuses.
    expect(
      headroomIndicatorFor({
        ...(compression.handle === undefined ? {} : { headroomHandle: compression.handle }),
        ...(compression.originalBytes === undefined ? {} : { headroomOriginalBytes: compression.originalBytes }),
        ...(compression.compressedBytes === undefined ? {} : { headroomCompressedBytes: compression.compressedBytes }),
      }),
    ).toBeNull()
  })
})

// ===========================================================================
// Acceptance 2 — byte-identical round trip against a known payload
// ===========================================================================

describe('SUV-0026 acceptance 2: "view original" is byte-identical to the pre-compression original', () => {
  it('redeems the handle the compression issued and returns the exact input bytes', async () => {
    const svc = service()
    const adapter = await adapterFor(svc)

    const compression = await compressToolOutput(adapter, {
      toolCallId: 'toolu_suv0026',
      toolName: 'Bash',
      content: KNOWN_PAYLOAD,
    })

    // Precondition: the payload really was compressed, so the round trip is a
    // round trip and not a pass-through comparing a string to itself.
    expect(compression.handle).toBeDefined()
    expect(compression.content).not.toBe(KNOWN_PAYLOAD)

    const indicator = headroomIndicatorFor({
      headroomHandle: compression.handle,
      headroomOriginalBytes: compression.originalBytes,
      headroomCompressedBytes: compression.compressedBytes,
    })
    expect(indicator).not.toBeNull()

    const state = await resolveHeadroomOriginal(
      indicator!.handle,
      (handle) => adapter.retrieve(handle),
    )

    expect(state.status).toBe('retrieved')
    const retrieved = state.status === 'retrieved' ? state.content : null

    // Byte-identical, asserted three ways: exact string equality, identical
    // length (so no trailing-newline loss hides behind a lenient matcher), and
    // identical UTF-8 bytes (so no encoding round trip is being papered over).
    expect(retrieved).toBe(KNOWN_PAYLOAD)
    expect(retrieved?.length).toBe(KNOWN_PAYLOAD.length)
    expect(Buffer.from(retrieved!, 'utf8').equals(Buffer.from(KNOWN_PAYLOAD, 'utf8'))).toBe(true)
  })

  it('reports the measured sizes of that same round trip', async () => {
    const svc = service()
    const adapter = await adapterFor(svc)

    const compression = await compressToolOutput(adapter, {
      toolCallId: 'toolu_suv0026',
      toolName: 'Bash',
      content: KNOWN_PAYLOAD,
    })

    // Measured, not estimated: the original size is the UTF-8 length of the
    // payload that went in, which is larger than its character count because
    // the payload is not ASCII.
    expect(compression.originalBytes).toBe(Buffer.byteLength(KNOWN_PAYLOAD, 'utf8'))
    expect(compression.originalBytes).toBeGreaterThan(KNOWN_PAYLOAD.length)
    expect(compression.compressedBytes).toBe(Buffer.byteLength(compression.content, 'utf8'))
  })
})

// ===========================================================================
// Acceptance 3 — a failed retrieval is explicit, and never the compressed body
// ===========================================================================

describe('SUV-0026 acceptance 3: failed retrieval shows an error, not compressed content', () => {
  it('reports the service\'s own reason when the handle is no longer held', async () => {
    const svc = service()
    const adapter = await adapterFor(svc)

    const compression = await compressToolOutput(adapter, {
      toolCallId: 'toolu_suv0026',
      toolName: 'Bash',
      content: KNOWN_PAYLOAD,
    })
    expect(compression.handle).toBeDefined()

    svc.forgetEverything = true

    const state = await resolveHeadroomOriginal(compression.handle!, (h) => adapter.retrieve(h))

    expect(state.status).toBe('error')
    expect(state).not.toHaveProperty('content')
    // Whatever the reason, it is never the compressed text dressed as the original.
    expect(JSON.stringify(state)).not.toContain(compression.content)
  })

  it('reports an unreachable service rather than resolving to content', async () => {
    const svc = service()
    const adapter = await adapterFor(svc)

    const compression = await compressToolOutput(adapter, {
      toolCallId: 'toolu_suv0026',
      toolName: 'Bash',
      content: KNOWN_PAYLOAD,
    })

    svc.retrieveThrows = true

    const state = await resolveHeadroomOriginal(compression.handle!, (h) => adapter.retrieve(h))

    expect(state.status).toBe('error')
    expect(state).not.toHaveProperty('content')
  })

  it('reports `unsupported` where the platform offers no retrieval at all', async () => {
    const state = await resolveHeadroomOriginal('ccr_abc', undefined)

    expect(state).toEqual({ status: 'error', reason: 'unsupported' })
  })

  it('reports `failed` when the retrieval itself rejects', async () => {
    const state = await resolveHeadroomOriginal('ccr_abc', async () => {
      throw new Error('IPC channel closed')
    })

    expect(state).toEqual({ status: 'error', reason: 'failed' })
  })

  it('refuses a malformed success answer rather than rendering it as the original', async () => {
    const malformed = { retrieved: true } as unknown as HeadroomRetrieveResult
    const state = await resolveHeadroomOriginal('ccr_abc', async () => malformed)

    expect(state).toEqual({ status: 'error', reason: 'failed' })
  })

  it('passes every boundary miss reason through unchanged, so the message is specific', async () => {
    const reasons = ['disabled', 'sdk-unavailable', 'service-unavailable', 'unknown-handle'] as const

    for (const reason of reasons) {
      const state = await resolveHeadroomOriginal('ccr_abc', async () => ({ retrieved: false, reason }))
      expect(state).toEqual({ status: 'error', reason })
    }
  })

  it('maps every error reason to a distinct message key', () => {
    const reasons = [
      'disabled',
      'sdk-unavailable',
      'service-unavailable',
      'unknown-handle',
      'unsupported',
      'failed',
    ] as const

    const keys = reasons.map(headroomErrorMessageKey)
    expect(new Set(keys).size).toBe(reasons.length)
    for (const key of keys) expect(key.startsWith('turnCard.headroom.error.')).toBe(true)
  })
})
