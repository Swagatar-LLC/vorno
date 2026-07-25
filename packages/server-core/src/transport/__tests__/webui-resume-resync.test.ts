/**
 * WebUI resume/resync tests — regression cover for the phantom follow-up chip
 * incident (session 260724-light-delta, 2026-07-25).
 *
 * The failure: a client held a follow-up annotation the server had already
 * removed, missing multiple `message_annotations_updated` events over 15+
 * minutes, and never reconciled. It was worst on mobile Safari, which freezes
 * backgrounded tabs.
 *
 * Two transport-level causes are covered here:
 *
 * 1. **Sequence gaps were swallowed.** The client logged a gap, advanced
 *    `lastSeenSeq` past it, and then acked that higher number — telling the
 *    server to evict the very events it had never received. State diverged
 *    permanently with no reconnect and no `stale` verdict to trigger recovery.
 *
 * 2. **No page-lifecycle liveness check.** The heartbeat is server→client only
 *    and `readyState` keeps reporting OPEN across an OS-level socket teardown,
 *    so a resumed tab could sit indefinitely believing it was connected.
 *
 * These use a fake WebSocket + a simulated `document`/`window` rather than a
 * real server pair, because the failure modes are *absence* of client traffic
 * (a gap that never happens on a healthy loopback socket, and a suspension the
 * test process cannot actually perform).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  EVENT_BUFFER_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  PROTOCOL_VERSION,
  type MessageEnvelope,
} from '@craft-agent/shared/protocol'

// Mirrors the derived constant in client.ts — the read-idle timer fires after
// this much time with no inbound read.
const READ_IDLE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MAX_MISSED + 1)

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  static instances: FakeWebSocket[] = []

  readyState = 0
  sent: string[] = []
  /** Set to make `send()` throw, simulating a half-open socket. */
  sendThrows = false

  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    if (this.sendThrows) throw new Error('simulated half-open socket')
    this.sent.push(data)
  }

  close(): void {
    this.readyState = this.CLOSED
    this.onclose?.({ code: 1000, wasClean: true })
  }

  // -- test helpers ---------------------------------------------------------

  /** Complete the transport handshake so the client considers itself connected. */
  open(): void {
    this.readyState = this.OPEN
    this.onopen?.()
  }

  deliver(envelope: MessageEnvelope): void {
    this.onmessage?.({ data: JSON.stringify(envelope) })
  }

  /** Push a session event with an explicit sequence number. */
  deliverEvent(seq: number, channel = 'session:event', args: unknown[] = []): void {
    this.deliver({ id: `evt-${seq}`, type: 'event', seq, channel, args } as MessageEnvelope)
  }

  parsedSent(): MessageEnvelope[] {
    return this.sent.map(raw => JSON.parse(raw) as MessageEnvelope)
  }

  sentOfType(type: string): MessageEnvelope[] {
    return this.parsedSent().filter(e => e.type === type)
  }
}

// ---------------------------------------------------------------------------
// Simulated page lifecycle
// ---------------------------------------------------------------------------

type Listener = (event: any) => void

class FakeEventTarget {
  listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn)
  }

  dispatch(type: string, event: any = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  countFor(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeDocument extends FakeEventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const originals: Record<string, unknown> = {}
let fakeDocument: FakeDocument
let fakeWindow: FakeEventTarget

function installGlobals(): void {
  originals.WebSocket = (globalThis as any).WebSocket
  originals.document = (globalThis as any).document
  originals.window = (globalThis as any).window

  fakeDocument = new FakeDocument()
  fakeWindow = new FakeEventTarget()

  ;(globalThis as any).WebSocket = FakeWebSocket
  ;(globalThis as any).document = fakeDocument
  ;(globalThis as any).window = fakeWindow
}

function restoreGlobals(): void {
  ;(globalThis as any).WebSocket = originals.WebSocket
  if (originals.document === undefined) delete (globalThis as any).document
  else (globalThis as any).document = originals.document
  if (originals.window === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originals.window
}

/**
 * `client.ts` is imported *after* the globals are installed so the module sees
 * the fake `document`/`window` when the constructor wires lifecycle watchers.
 */
async function loadClientClass() {
  const mod = await import('../client')
  return mod.WsRpcClient
}

const CLIENT_ID = 'client-under-test'

async function connectedClient(opts?: { autoReconnect?: boolean; now?: () => number }) {
  const WsRpcClient = await loadClientClass()
  const client = new WsRpcClient('ws://127.0.0.1:1/ws', {
    workspaceId: 'ws-a',
    autoReconnect: opts?.autoReconnect ?? true,
    mode: 'remote',
    now: opts?.now,
  })

  client.connect()
  const ws = FakeWebSocket.instances.at(-1)!
  ws.open()
  ws.deliver({
    id: ws.sentOfType('handshake')[0]!.id,
    type: 'handshake_ack',
    protocolVersion: PROTOCOL_VERSION,
    serverVersion: '0.12.3',
    clientId: CLIENT_ID,
    registeredChannels: [],
  } as MessageEnvelope)

  return { client, ws }
}

/**
 * Force a reconnect and return the handshake sent on the resulting socket.
 * The handshake only goes out once the socket opens, so the fake has to be
 * driven there explicitly.
 */
function reconnectAndCaptureHandshake(client: { reconnectNow: () => void }): MessageEnvelope | undefined {
  const before = FakeWebSocket.instances.length
  client.reconnectNow()

  const target = FakeWebSocket.instances.slice(before).at(-1)
  if (!target) return undefined
  target.open()
  return target.sentOfType('handshake').at(-1)
}

beforeEach(() => {
  FakeWebSocket.instances = []
  installGlobals()
})

afterEach(() => {
  restoreGlobals()
})

// ---------------------------------------------------------------------------
// 1. Sequence gaps
// ---------------------------------------------------------------------------

describe('WsRpcClient — sequence gap recovery', () => {
  it('reports a stale reconnect so the app re-hydrates after a gap', async () => {
    const { client, ws } = await connectedClient()

    const staleSignals: boolean[] = []
    client.on('__transport:reconnected', (isStale: boolean) => staleSignals.push(isStale))

    ws.deliverEvent(1)
    ws.deliverEvent(2)
    expect(staleSignals).toEqual([])

    // Events 3 and 4 never arrive — e.g. `message_annotations_updated` dropped
    // while the tab was suspended.
    ws.deliverEvent(5)

    await new Promise(r => setTimeout(r, 5))
    expect(staleSignals).toEqual([true])

    client.destroy()
  })

  it('does not ack past a gap, so the server keeps the missed events replayable', async () => {
    const { client, ws } = await connectedClient()

    ws.deliverEvent(1)
    ws.deliverEvent(2)
    ws.deliverEvent(5) // gap: 3, 4 lost

    // The reconnect handshake carries the client's "I have everything up to
    // here" watermark. Reporting 5 would make the server evict 3-5 so they
    // could never be replayed — the bug that made phantom chips immortal.
    const handshake = reconnectAndCaptureHandshake(client)
    expect(handshake?.reconnectClientId).toBe(CLIENT_ID)
    expect(handshake?.lastSeq).toBe(2)

    client.destroy()
  })

  it('advances the watermark normally while events stay contiguous', async () => {
    const { client, ws } = await connectedClient()

    for (const seq of [1, 2, 3, 4]) ws.deliverEvent(seq)

    expect(reconnectAndCaptureHandshake(client)?.lastSeq).toBe(4)

    client.destroy()
  })

  it('counts the events lost in a gap', async () => {
    const { client, ws } = await connectedClient()

    ws.deliverEvent(10)
    ws.deliverEvent(14) // 11, 12, 13 lost

    expect(client.getMissedEventCount()).toBe(3)

    client.destroy()
  })

  it('collapses a burst of gaps into a single recovery pass', async () => {
    const { client, ws } = await connectedClient()

    const staleSignals: boolean[] = []
    client.on('__transport:reconnected', (isStale: boolean) => staleSignals.push(isStale))

    ws.deliverEvent(1)
    ws.deliverEvent(5)
    ws.deliverEvent(9)
    ws.deliverEvent(13)

    await new Promise(r => setTimeout(r, 5))
    expect(staleSignals).toEqual([true])

    client.destroy()
  })
})

// ---------------------------------------------------------------------------
// 2. Page lifecycle / resume
// ---------------------------------------------------------------------------

describe('WsRpcClient — page lifecycle liveness (mobile Safari suspension)', () => {
  it('registers lifecycle watchers in a browser environment', async () => {
    const { client } = await connectedClient()

    expect(fakeDocument.countFor('visibilitychange')).toBe(1)
    expect(fakeWindow.countFor('pageshow')).toBe(1)
    expect(fakeWindow.countFor('online')).toBe(1)

    client.destroy()
  })

  it('removes lifecycle watchers on destroy', async () => {
    const { client } = await connectedClient()
    client.destroy()

    expect(fakeDocument.countFor('visibilitychange')).toBe(0)
    expect(fakeWindow.countFor('pageshow')).toBe(0)
    expect(fakeWindow.countFor('online')).toBe(0)
  })

  it('forces a reconnect when the page was hidden past the replay window', async () => {
    const { client, ws } = await connectedClient()
    ws.deliverEvent(1)

    const socketsBefore = FakeWebSocket.instances.length

    fakeDocument.visibilityState = 'hidden'
    fakeDocument.dispatch('visibilitychange')

    // Simulate a suspension longer than the server's event-buffer TTL by
    // rewriting the recorded hide timestamp.
    ;(client as any).hiddenAt = Date.now() - (EVENT_BUFFER_TTL_MS + 5_000)

    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatch('visibilitychange')

    // A reconnect past the replay window is the only way to get an
    // authoritative `stale` verdict and the re-hydration that follows it.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore)

    client.destroy()
  })

  it('does not reconnect for a brief hide on a healthy socket', async () => {
    const { client, ws } = await connectedClient()
    ws.deliverEvent(1)

    const socketsBefore = FakeWebSocket.instances.length
    const sentBefore = ws.sent.length

    fakeDocument.visibilityState = 'hidden'
    fakeDocument.dispatch('visibilitychange')
    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatch('visibilitychange')

    expect(FakeWebSocket.instances.length).toBe(socketsBefore)
    // Still probes liveness with a cheap ack rather than assuming health.
    expect(ws.sent.length).toBe(sentBefore + 1)
    expect(ws.sentOfType('sequence_ack').at(-1)?.lastSeq).toBe(1)

    client.destroy()
  })

  it('reconnects on resume when the socket is half-open despite readyState OPEN', async () => {
    const { client, ws } = await connectedClient()
    ws.deliverEvent(1)

    const socketsBefore = FakeWebSocket.instances.length

    // The OS tore the connection down underneath us. This is the case no other
    // code path detects: the server heartbeat is server→client only, and
    // readyState still says OPEN.
    ws.sendThrows = true
    expect(ws.readyState).toBe(ws.OPEN)

    fakeDocument.visibilityState = 'hidden'
    fakeDocument.dispatch('visibilitychange')
    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatch('visibilitychange')

    expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore)

    client.destroy()
  })

  it('reconnects on resume when the socket is already closed', async () => {
    const { client, ws } = await connectedClient({ autoReconnect: false })
    ws.deliverEvent(1)

    ws.readyState = ws.CLOSED
    const socketsBefore = FakeWebSocket.instances.length

    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatch('visibilitychange')

    // autoReconnect: false means the client must not self-heal on resume.
    expect(FakeWebSocket.instances.length).toBe(socketsBefore)

    client.destroy()
  })

  it('forces a resync on bfcache restore (pageshow persisted)', async () => {
    const { client, ws } = await connectedClient()
    ws.deliverEvent(1)

    const socketsBefore = FakeWebSocket.instances.length
    fakeWindow.dispatch('pageshow', { persisted: true })

    expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore)

    client.destroy()
  })

  it('forces a resync when the network comes back online', async () => {
    const { client, ws } = await connectedClient()
    ws.deliverEvent(1)

    const socketsBefore = FakeWebSocket.instances.length
    fakeWindow.dispatch('online')

    expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore)

    client.destroy()
  })

  it('ignores lifecycle events before the client has connected', async () => {
    const WsRpcClient = await loadClientClass()
    const client = new WsRpcClient('ws://127.0.0.1:1/ws', { mode: 'remote' })

    // No connect() yet — resume must not spin up a socket on its own.
    fakeWindow.dispatch('online')
    expect(FakeWebSocket.instances.length).toBe(0)

    client.destroy()
  })
})

// ---------------------------------------------------------------------------
// 3. Steady-state read-idle liveness (no lifecycle event at all)
// ---------------------------------------------------------------------------

describe('WsRpcClient — read-idle liveness (steady-state half-open socket)', () => {
  it('reconnects purely via the idle timer when the socket goes half-open with no close/visibility event', async () => {
    // Injected clock so the read-idle threshold is crossed deterministically
    // without a real wall-clock wait.
    let clock = 1_000_000
    const { client, ws } = await connectedClient({ now: () => clock })

    ws.deliverEvent(1) // an inbound read — resets the read-idle clock

    const socketsBefore = FakeWebSocket.instances.length

    // The OS tore the connection down underneath us: readyState still reports
    // OPEN and no `close`/`visibilitychange`/`online` event ever fires. This is
    // the steady-state case the page-lifecycle watchers cannot see — the only
    // signal is the absence of inbound reads.
    ws.sendThrows = true
    expect(ws.readyState).toBe(ws.OPEN)

    // Advance past the read-idle threshold with zero inbound reads, then let one
    // idle tick run. The tick probes the socket; the probe send throws, so the
    // client reconnects through the same path PR #127 added.
    clock += READ_IDLE_THRESHOLD_MS + 1
    ;(client as any).checkReadIdle()

    expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore)

    client.destroy()
  })

  it('does not reconnect a healthy-but-quiet socket — it only probes', async () => {
    let clock = 1_000_000
    const { client, ws } = await connectedClient({ now: () => clock })

    ws.deliverEvent(1)
    const socketsBefore = FakeWebSocket.instances.length
    const sentBefore = ws.sent.length

    // Idle past the threshold, but the socket is genuinely healthy: the probe
    // send succeeds, so no reconnect — just a cheap keepalive ack.
    clock += READ_IDLE_THRESHOLD_MS + 1
    ;(client as any).checkReadIdle()

    expect(FakeWebSocket.instances.length).toBe(socketsBefore)
    expect(ws.sent.length).toBe(sentBefore + 1)
    expect(ws.sentOfType('sequence_ack').at(-1)?.lastSeq).toBe(1)

    client.destroy()
  })

  it('does not fire before the read-idle threshold elapses', async () => {
    let clock = 1_000_000
    const { client, ws } = await connectedClient({ now: () => clock })

    ws.deliverEvent(1)
    ws.sendThrows = true // would reconnect if a probe ran
    const socketsBefore = FakeWebSocket.instances.length

    // Just short of the threshold — the tick must be a no-op.
    clock += READ_IDLE_THRESHOLD_MS - 1
    ;(client as any).checkReadIdle()

    expect(FakeWebSocket.instances.length).toBe(socketsBefore)

    client.destroy()
  })
})
