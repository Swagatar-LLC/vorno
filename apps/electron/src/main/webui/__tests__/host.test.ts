/**
 * fork(PLAN-022): WebUI host single-port WS proxy tests.
 *
 * The host's `upgrade` handler authenticates the `craft_session` cookie on `/ws`
 * and RAW-TCP splices the upgrade to a loopback RPC listener. These drive
 * `handleWsUpgrade` directly with a fake client socket and a real loopback
 * "RPC" TCP target. Bun ≥1.3 emits `upgrade` on `node:http` (older bun did
 * not), but writes to the upgraded socket never reach the TCP client under bun
 * (LEARNING-038) — so the reverse leg and status-line rejects are asserted
 * HERE with the fake socket, while smoke.e2e.test.ts covers the forward leg
 * through the real listener. The packaged app runs on Node, where both work.
 *
 * Asserts:
 *   - no cookie / invalid cookie ⇒ 401 (never spliced)
 *   - non-`/ws` upgrade path ⇒ socket destroyed, auth never consulted
 *   - no live target ⇒ 503
 *   - valid cookie ⇒ request line + forwarded Cookie + head bytes reach the
 *     target, and bytes written back by the target reach the client
 */
import { describe, test, expect } from 'bun:test';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { PassThrough, type Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { handleWsUpgrade, type WsProxyTarget } from '../host';

/**
 * A minimal fake client socket: a Duplex whose writes we can read back (what the
 * host wrote to the browser) and whose `destroy()`/`destroyed` we can observe.
 */
class FakeSocket extends PassThrough {
  written = '';
  wasDestroyed = false;
  constructor() {
    super();
    this.on('data', (chunk: Buffer) => { this.written += chunk.toString('utf8'); });
  }
  override destroy(err?: Error): this {
    this.wasDestroyed = true;
    return super.destroy(err) as this;
  }
}

/** Build a fake IncomingMessage carrying method/url/headers/rawHeaders. */
function fakeReq(path: string, headers: Record<string, string>): IncomingMessage {
  const rawHeaders: string[] = [];
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    rawHeaders.push(k, v);
    lower[k.toLowerCase()] = v;
  }
  return {
    method: 'GET',
    url: path,
    httpVersion: '1.1',
    headers: lower,
    rawHeaders,
  } as unknown as IncomingMessage;
}

/** A loopback "RPC" listener: captures the first chunk, echoes a marker back. */
function makeFakeTarget(): Promise<{ port: number; received: Promise<string>; close: () => void }> {
  return new Promise((resolve) => {
    let resolveReceived: (v: string) => void;
    const received = new Promise<string>((r) => { resolveReceived = r; });
    const server: Server = createNetServer((sock: Socket) => {
      sock.once('data', (buf: Buffer) => {
        resolveReceived(buf.toString('utf8'));
        sock.write('FROM_TARGET');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({ port, received, close: () => server.close() });
    });
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WebUI host — single-port WS proxy (handleWsUpgrade)', () => {
  test('no cookie ⇒ 401, never spliced to the target', async () => {
    const target = await makeFakeTarget();
    let targetSawData = false;
    void target.received.then(() => { targetSawData = true; });

    const socket = new FakeSocket();
    await handleWsUpgrade(
      fakeReq('/ws', { Upgrade: 'websocket' }),
      socket as unknown as Duplex,
      Buffer.alloc(0),
      async () => false,
      () => ({ port: target.port }),
    );
    expect(socket.written).toContain('401');
    expect(socket.wasDestroyed).toBe(true);
    await delay(50);
    expect(targetSawData).toBe(false);
    target.close();
  });

  test('invalid cookie ⇒ 401', async () => {
    const target = await makeFakeTarget();
    const socket = new FakeSocket();
    await handleWsUpgrade(
      fakeReq('/ws', { Cookie: 'craft_session=bad' }),
      socket as unknown as Duplex,
      Buffer.alloc(0),
      async (c) => c === 'craft_session=good',
      () => ({ port: target.port }),
    );
    expect(socket.written).toContain('401');
    target.close();
  });

  test('non-/ws upgrade path ⇒ destroyed, auth never consulted', async () => {
    const target = await makeFakeTarget();
    let validateCalled = false;
    const socket = new FakeSocket();
    await handleWsUpgrade(
      fakeReq('/socket', { Cookie: 'craft_session=good' }),
      socket as unknown as Duplex,
      Buffer.alloc(0),
      async () => { validateCalled = true; return true; },
      () => ({ port: target.port }),
    );
    // Path rejected before auth: destroyed with no HTTP status line written.
    expect(socket.wasDestroyed).toBe(true);
    expect(socket.written).toBe('');
    expect(validateCalled).toBe(false);
    target.close();
  });

  test('no live RPC target ⇒ 503', async () => {
    const socket = new FakeSocket();
    await handleWsUpgrade(
      fakeReq('/ws', { Cookie: 'craft_session=good' }),
      socket as unknown as Duplex,
      Buffer.alloc(0),
      async () => true,
      () => undefined,
    );
    expect(socket.written).toContain('503');
    expect(socket.wasDestroyed).toBe(true);
  });

  test('valid cookie ⇒ upgrade replayed to target + bidirectional splice', async () => {
    const target = await makeFakeTarget();
    const socket = new FakeSocket();

    await handleWsUpgrade(
      fakeReq('/ws', {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        Cookie: 'craft_session=good',
        'Sec-WebSocket-Key': 'abc123==',
        Host: '192.168.1.20:3848',
      }),
      socket as unknown as Duplex,
      Buffer.from('CLIENT_HEAD_BYTES'),
      async (c) => c === 'craft_session=good',
      () => ({ port: target.port }),
    );

    // Forward direction: the replayed request line, forwarded Cookie (auth holds
    // at the RPC hop), other WS headers, and the buffered head bytes all arrive.
    const received = await target.received;
    expect(received).toContain('GET /ws HTTP/1.1');
    expect(received).toContain('Cookie: craft_session=good');
    expect(received).toContain('Sec-WebSocket-Key: abc123==');
    expect(received).toContain('CLIENT_HEAD_BYTES');

    // Reverse direction: bytes the target writes back reach the client socket.
    await delay(50);
    expect(socket.written).toContain('FROM_TARGET');

    target.close();
  });
});
