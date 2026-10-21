/**
 * fork(PLAN-057): REST sessions routed through the host (desktop) seam.
 * Drives the real router via createTriggerServer with a fake HostBridge; no
 * CraftAgent is ever constructed. Keys are generated, never real.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '@craft-agent/core/types';
import { createProject } from '@craft-agent/shared/projects';
import { CONFIG_DIR } from '@craft-agent/shared/config/paths';
import { generateApiKey, type StoredApiKey } from '../../src/config';
import { createTriggerServer, type TriggerServerCore } from '../../src/core/create-trigger-server';
import {
  policyToPermissionMode,
  type HostBridge,
  type HostCreateSessionOptions,
  type HostCreatedSession,
  type HostSessionStatus,
} from '../../src/core/host-bridge';
import { RoutedSession, isSafeCommand } from '../../src/services/routed-session';
import { WsProtocol } from '../../src/transport/ws-protocol';
import { ClientRegistry } from '../../src/transport/client-registry';
import type { PoolSession } from '../../src/services/session-pool';

const WS_ID = 'ws-routed-test';
const serverConfigPath = join(CONFIG_DIR, 'server-config.json');
const storedConfigPath = join(CONFIG_DIR, 'config.json');
let savedStored: string | null = null;
let savedServer: string | null = null;
let wsRoot: string;

const keyA = generateApiKey('Key A', { workspaceIds: [], permissionPolicy: 'allow-all', maxConcurrentSessions: 2 });
const keyB = generateApiKey('Key B', { workspaceIds: [], permissionPolicy: 'allow-safe', maxConcurrentSessions: 2 });

function writeServerConfig(routeSessionsToDesktop: boolean, keys: StoredApiKey[] = [keyA.stored, keyB.stored]) {
  writeFileSync(serverConfigPath, JSON.stringify({
    enabled: true, port: 3847, host: '127.0.0.1', apiKeys: keys,
    rateLimits: { requestsPerMinute: 10000, concurrentSessions: 5 },
    routeSessionsToDesktop,
  }));
}

function writeStoredConfig(extra: Record<string, unknown> = {}) {
  writeFileSync(storedConfigPath, JSON.stringify({
    workspaces: [{ id: WS_ID, name: 'Routed Test', rootPath: wsRoot, createdAt: 1 }],
    activeWorkspaceId: WS_ID,
    ...extra,
  }));
}

const CONNECTIONS = {
  llmConnections: [
    { slug: 'chatgpt-plus', name: 'ChatGPT Plus', providerType: 'pi_compat', authType: 'none', models: ['gpt-5', 'gpt-5-mini'], createdAt: 1 },
    { slug: 'claude-max', name: 'Claude Max', providerType: 'anthropic', authType: 'oauth', models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5' }], createdAt: 1 },
  ],
  defaultLlmConnection: 'chatgpt-plus',
};

beforeAll(() => {
  savedStored = existsSync(storedConfigPath) ? readFileSync(storedConfigPath, 'utf-8') : null;
  savedServer = existsSync(serverConfigPath) ? readFileSync(serverConfigPath, 'utf-8') : null;
  wsRoot = mkdtempSync(join(tmpdir(), 'vorno-routed-ws-'));
  writeStoredConfig();
});

afterAll(() => {
  if (savedStored === null) rmSync(storedConfigPath, { force: true }); else writeFileSync(storedConfigPath, savedStored);
  if (savedServer === null) rmSync(serverConfigPath, { force: true }); else writeFileSync(serverConfigPath, savedServer);
  rmSync(wsRoot, { recursive: true, force: true });
});

// ---- fakes ----

class FakeHandle implements HostCreatedSession {
  workspaceId = WS_ID;
  status: HostSessionStatus = 'idle';
  responses: Array<[string, boolean]> = [];
  released = 0;
  deleted = 0;
  aborted = 0;
  script: AgentEvent[] = [];
  /** Resolved when a permission is answered, so scripted turns can wait on it. */
  private waiters = new Map<string, () => void>();
  constructor(public sessionId: string) {}
  async *chat(_content: string): AsyncGenerator<AgentEvent> {
    this.status = 'processing';
    for (const ev of this.script) {
      yield ev;
      if (ev.type === 'permission_request') {
        // The host blocks the turn until the permission is answered.
        if (!this.responses.some(([id]) => id === ev.requestId)) {
          await new Promise<void>(r => this.waiters.set(ev.requestId, r));
        }
      }
    }
    this.status = 'idle';
  }
  async abort() { this.aborted++; }
  respondToPermission(id: string, allowed: boolean) {
    this.responses.push([id, allowed]);
    this.waiters.get(id)?.();
    return true;
  }
  getStatus() { return this.status; }
  getSdkSessionId() { return `sdk-${this.sessionId}`; }
  getLastActivityAt() { return 1; }
  release() { this.released++; }
  async delete() { this.deleted++; }
}

const wsFor = (c: TriggerServerCore) => new WsProtocol({
  pool: c.pool, eventBus: c.pool.getEventBus(), registry: new ClientRegistry(), getConfig: () => ({} as never),
});

const perm = (requestId: string, command: string): AgentEvent =>
  ({ type: 'permission_request', requestId, toolName: 'Bash', command, description: 'run' }) as AgentEvent;

let core: TriggerServerCore;
let calls: HostCreateSessionOptions[];
let handles: FakeHandle[];
let nextScript: AgentEvent[];

function makeBridge(): HostBridge {
  return {
    createSession: async (opts) => {
      calls.push(opts);
      const h = new FakeHandle(`routed-${handles.length + 1}`);
      h.script = nextScript;
      handles.push(h);
      return h;
    },
  };
}

function req(key: { fullKey: string }, method: string, path: string, body?: unknown) {
  return core.fetchHandler(new Request(`http://localhost:3847${path}`, {
    method,
    headers: { Authorization: `Bearer ${key.fullKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function create(key: { fullKey: string }, policy?: string) {
  const res = await req(key, 'POST', '/api/sessions', { workspaceId: WS_ID, permissionPolicy: policy });
  return { res, json: (await res.json()) as any };
}

beforeEach(() => {
  calls = []; handles = []; nextScript = [{ type: 'complete' } as AgentEvent];
  writeServerConfig(true);
  core = createTriggerServer(JSON.parse(readFileSync(serverConfigPath, 'utf-8')), makeBridge());
});

describe('routing decision', () => {
  test('flag on + seam: routed with the capped policy and key name', async () => {
    const { res, json } = await create(keyB, 'allow-all'); // key B caps at allow-safe
    expect(res.status).toBe(201);
    expect(json).toEqual({ sessionId: 'routed-1', workspaceId: WS_ID, permissionPolicy: 'allow-safe', status: 'idle' });
    expect(calls).toEqual([{
      workspaceId: WS_ID, model: undefined, permissionPolicy: 'allow-safe',
      enabledSources: undefined, workingDirectory: undefined, apiKeyName: 'Key B',
    }]);
    expect(JSON.stringify(calls)).not.toContain(keyB.fullKey);
  });

  test('routed session is listed for its key only', async () => {
    await create(keyA);
    const a = await (await req(keyA, 'GET', '/api/sessions')).json() as any[];
    const b = await (await req(keyB, 'GET', '/api/sessions')).json() as any[];
    expect(a.map(s => s.sessionId)).toEqual(['routed-1']);
    expect(b).toEqual([]);
  });

  function stubPoolCreate() {
    let created = 0;
    (core.pool as any).create = async (_cfg: unknown, apiKeyId: string) => {
      created++;
      const h = new FakeHandle(`pool-${created}`);
      core.pool.adopt(h as unknown as PoolSession, apiKeyId);
      return h;
    };
    return () => created;
  }

  test('flag off + seam: pool path, createSession not called', async () => {
    writeServerConfig(false);
    const created = stubPoolCreate();
    const { res, json } = await create(keyA);
    expect(res.status).toBe(201);
    expect(json.sessionId).toBe('pool-1');
    expect(created()).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test('flag on + no seam (standalone): pool path', async () => {
    core = createTriggerServer(JSON.parse(readFileSync(serverConfigPath, 'utf-8')), {});
    const created = stubPoolCreate();
    const { res } = await create(keyA);
    expect(res.status).toBe(201);
    expect(created()).toBe(1);
  });

  test('projectId: validated against the workspace and passed to the host', async () => {
    const project = createProject(wsRoot, { name: 'Api Test Project' });
    const ok = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, projectId: project.id });
    expect(ok.status).toBe(201);
    expect(calls[0]!.projectId).toBe(project.id);
  });

  test('projectId: omitted is passed as undefined', async () => {
    await create(keyA);
    expect(calls[0]!.projectId).toBeUndefined();
  });

  test('projectId: unknown project (or a slug) is 400 and nothing is created', async () => {
    createProject(wsRoot, { name: 'Slug Project' });
    for (const projectId of ['proj_00000000', 'slug-project']) {
      const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, projectId });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toContain('not found');
    }
    expect(calls).toHaveLength(0);
    expect(core.pool.activeCount).toBe(0);
  });

  test('projectId: non-string is 400', async () => {
    const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, projectId: 5 });
    expect(res.status).toBe(400);
  });

  test('projectId: pool path rejects it with 400', async () => {
    writeServerConfig(false);
    const project = createProject(wsRoot, { name: 'Pool Project' });
    const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, projectId: project.id });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('routeSessionsToDesktop');
    expect(calls).toHaveLength(0);
  });

  test('name: trimmed and passed to the host; omitted is undefined', async () => {
    const ok = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, name: '  Nightly triage ' });
    expect(ok.status).toBe(201);
    expect(calls[0]!.name).toBe('Nightly triage');
    await create(keyA);
    expect(calls[1]!.name).toBeUndefined();
  });

  test('name: empty, blank, non-string or over 200 chars is 400', async () => {
    for (const name of ['', '   ', 5, 'x'.repeat(201)]) {
      const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, name });
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test('name and llmConnection: pool path rejects them with 400', async () => {
    writeServerConfig(false);
    for (const extra of [{ name: 'n' }, { llmConnection: 'claude-max' }]) {
      const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, ...extra });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toContain('routeSessionsToDesktop');
    }
    expect(calls).toHaveLength(0);
  });

  describe('llmConnection and model validation', () => {
    beforeEach(() => writeStoredConfig(CONNECTIONS));
    afterAll(() => writeStoredConfig());

    test('llmConnection is passed to the host; omitted is undefined', async () => {
      const ok = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, llmConnection: 'claude-max' });
      expect(ok.status).toBe(201);
      expect(calls[0]!.llmConnection).toBe('claude-max');
      await create(keyA);
      expect(calls[1]!.llmConnection).toBeUndefined();
    });

    test('unknown llmConnection is 400 listing the valid slugs', async () => {
      const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, llmConnection: 'nope' });
      expect(res.status).toBe(400);
      const err = ((await res.json()) as any).error as string;
      expect(err).toContain('nope');
      expect(err).toContain('chatgpt-plus');
      expect(err).toContain('claude-max');
      expect(calls).toHaveLength(0);
    });

    test('llmConnection: non-string is 400', async () => {
      const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, llmConnection: 5 });
      expect(res.status).toBe(400);
    });

    test('model not on the default connection is 400 naming model, connection and available ids', async () => {
      const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, model: 'claude-sonnet-5' });
      expect(res.status).toBe(400);
      const err = ((await res.json()) as any).error as string;
      expect(err).toContain('claude-sonnet-5');
      expect(err).toContain('chatgpt-plus');
      expect(err).toContain('gpt-5-mini');
      expect(calls).toHaveLength(0);
    });

    test('model is validated against the given llmConnection', async () => {
      const ok = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, llmConnection: 'claude-max', model: 'claude-sonnet-5' });
      expect(ok.status).toBe(201);
      const bad = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, llmConnection: 'claude-max', model: 'gpt-5' });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).error).toContain('claude-max');
    });

    test.each(['gpt-5', 'fast', 'default'])('model %s is accepted on the default connection', async (model) => {
      const res = await req(keyA, 'POST', '/api/sessions', { workspaceId: WS_ID, model });
      expect(res.status).toBe(201);
      expect(calls[0]!.model).toBe(model);
    });
  });

  test('host error becomes 500 with the message and nothing is adopted', async () => {
    core = createTriggerServer(JSON.parse(readFileSync(serverConfigPath, 'utf-8')), {
      createSession: async () => { throw new Error('desktop unavailable'); },
    });
    const { res, json } = await create(keyA);
    expect(res.status).toBe(500);
    expect(json.error).toContain('desktop unavailable');
    expect(core.pool.activeCount).toBe(0);
  });

  test('concurrency limit counts routed sessions', async () => {
    expect((await create(keyA)).res.status).toBe(201);
    expect((await create(keyA)).res.status).toBe(201);
    const third = await create(keyA);
    expect(third.res.status).toBe(429);
    expect(calls).toHaveLength(2);
  });
});

describe('ownership', () => {
  test('every /:id route 404s for another key', async () => {
    const { json } = await create(keyA);
    const id = json.sessionId;
    const checks: Array<[string, string, unknown?]> = [
      ['GET', `/api/sessions/${id}`],
      ['DELETE', `/api/sessions/${id}`],
      ['POST', `/api/sessions/${id}/messages`, { content: 'hi' }],
      ['POST', `/api/sessions/${id}/abort`],
      ['GET', `/api/sessions/${id}/events`],
      ['GET', `/api/sessions/${id}/pending`],
      ['POST', `/api/sessions/${id}/permissions`, { requestId: 'x', decision: 'allow' }],
    ];
    for (const [m, p, b] of checks) {
      const res = await req(keyB, m, p, b);
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error).toBe(`Session '${id}' not found`);
    }
    expect(handles[0].deleted).toBe(0);
    expect(handles[0].aborted).toBe(0);
    expect((await req(keyA, 'GET', `/api/sessions/${id}`)).status).toBe(200);
  });
});

describe('SSE turn', () => {
  test('frames are `event: <type>` and the stream closes on complete', async () => {
    nextScript = [
      { type: 'text_delta', text: 'hello' } as AgentEvent,
      { type: 'complete' } as AgentEvent,
    ];
    const { json } = await create(keyA);
    const res = await req(keyA, 'POST', `/api/sessions/${json.sessionId}/messages`, { content: 'hi' });
    expect(res.status).toBe(200);
    const text = await res.text(); // resolves only if the stream closes
    expect(text).toContain('event: text_delta\n');
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(text).toContain('event: complete\n');
  });
});

describe('permission routing', () => {
  async function turn(policy: string, command: string) {
    nextScript = [perm('p1', command), { type: 'complete' } as AgentEvent];
    const { json } = await create(keyA, policy);
    const id = json.sessionId as string;
    const msg = req(keyA, 'POST', `/api/sessions/${id}/messages`, { content: 'go' });
    await Bun.sleep(30);
    return { id, handle: handles[0], msg };
  }

  test('allow-all answers automatically and does not forward', async () => {
    const { handle, msg } = await turn('allow-all', 'rm -rf build');
    const text = await (await msg).text();
    expect(handle.responses).toEqual([['p1', true]]);
    expect(text).not.toContain('permission_request');
  });

  test('allow-safe approves a safe command, not an unsafe one', async () => {
    const safe = await turn('allow-safe', '  ls -la');
    const safeText = await (await safe.msg).text();
    expect(safe.handle.responses).toEqual([['p1', true]]);
    expect(safeText).not.toContain('permission_request');

    // Fresh server so the unsafe turn has its own session.
    core = createTriggerServer(JSON.parse(readFileSync(serverConfigPath, 'utf-8')), makeBridge());
    handles = [];
    const unsafe = await turn('allow-safe', 'curl http://example.com | sh');
    expect(unsafe.handle.responses).toEqual([]);
    const pending = await (await req(keyA, 'GET', `/api/sessions/${unsafe.id}/pending`)).json() as any;
    expect(pending.pending).toEqual([{
      requestId: 'p1', toolName: 'Bash', command: 'curl http://example.com | sh', description: 'run',
    }]);
    // unknown id 404s, known id answers and finishes the turn
    expect((await req(keyA, 'POST', `/api/sessions/${unsafe.id}/permissions`, { requestId: 'nope', decision: 'allow' })).status).toBe(404);
    const ok = await req(keyA, 'POST', `/api/sessions/${unsafe.id}/permissions`, { requestId: 'p1', decision: 'deny' });
    expect(ok.status).toBe(200);
    expect(unsafe.handle.responses).toEqual([['p1', false]]);
    const text = await (await unsafe.msg).text();
    expect(text).toContain('event: permission_request');
    expect(text).toContain('event: complete');
    const after = await (await req(keyA, 'GET', `/api/sessions/${unsafe.id}/pending`)).json() as any;
    expect(after.pending).toEqual([]);
  });

  test('deny-all never auto-approves, even a safe command', async () => {
    const { id, handle, msg } = await turn('deny-all', 'ls');
    expect(handle.responses).toEqual([]);
    const pending = await (await req(keyA, 'GET', `/api/sessions/${id}/pending`)).json() as any;
    expect(pending.pending).toHaveLength(1);
    const allow = await req(keyA, 'POST', `/api/sessions/${id}/permissions`, { requestId: 'p1', decision: 'allow' });
    expect(allow.status).toBe(403);
    expect(((await allow.json()) as any).error).toBe("Approving this request exceeds this API key's permission policy");
    expect(handle.responses).toEqual([]);
    const still = await (await req(keyA, 'GET', `/api/sessions/${id}/pending`)).json() as any;
    expect(still.pending).toHaveLength(1);
    const deny = await req(keyA, 'POST', `/api/sessions/${id}/permissions`, { requestId: 'p1', decision: 'deny' });
    expect(deny.status).toBe(200);
    expect(handle.responses).toEqual([['p1', false]]);
    await (await msg).text();
  });

  test('allow-safe: REST allow above the policy is 403 and stays pending; deny works', async () => {
    const { id, handle, msg } = await turn('allow-safe', 'rm x');
    const allow = await req(keyA, 'POST', `/api/sessions/${id}/permissions`, { requestId: 'p1', decision: 'allow' });
    expect(allow.status).toBe(403);
    expect(handle.responses).toEqual([]);
    expect(((await (await req(keyA, 'GET', `/api/sessions/${id}/pending`)).json()) as any).pending).toHaveLength(1);
    expect((await req(keyA, 'POST', `/api/sessions/${id}/permissions`, { requestId: 'p1', decision: 'deny' })).status).toBe(200);
    expect(handle.responses).toEqual([['p1', false]]);
    await (await msg).text();
  });

  test('WS respondToPermission allow is refused above the policy, deny is accepted', async () => {
    const { id, handle, msg } = await turn('allow-safe', 'rm x');
    const ws = wsFor(core);
    const call = (allowed: boolean) => (ws as any).rpcRespondPermission(
      { apiKey: keyA.stored }, [{ sessionId: id, requestId: 'p1', allowed }]);
    expect(() => call(true)).toThrow(/exceeds this API key/);
    expect(handle.responses).toEqual([]);
    expect(call(false)).toEqual({ responded: true });
    expect(handle.responses).toEqual([['p1', false]]);
    await (await msg).text();
  });

  test('a request left pending is denied after the timeout', async () => {
    const h = new FakeHandle('t1');
    h.script = [perm('p1', 'rm x'), { type: 'complete' } as AgentEvent];
    const rs = new RoutedSession(h, 'deny-all', 20);
    const done = (async () => { for await (const _ of rs.chat('go')) { /* drain */ } })();
    await Bun.sleep(80);
    expect(h.responses).toEqual([['p1', false]]);
    expect(rs.getPending()).toEqual([]);
    expect(rs.respondToPermission('p1', false)).toBe(false); // late answer is harmless
    await done;
  });

  test('abort denies pending requests, then aborts the handle', async () => {
    const { id, handle } = await turn('deny-all', 'ls');
    const res = await req(keyA, 'POST', `/api/sessions/${id}/abort`);
    expect(res.status).toBe(200);
    expect(handle.responses).toEqual([['p1', false]]);
    expect(handle.aborted).toBe(1);
  });
});

describe('lifecycle', () => {
  test('DELETE destroys the host session and removes it from the pool', async () => {
    const { json } = await create(keyA);
    const res = await req(keyA, 'DELETE', `/api/sessions/${json.sessionId}`);
    expect(res.status).toBe(200);
    expect(handles[0].deleted).toBe(1);
    expect(core.pool.has(json.sessionId)).toBe(false);
    expect(core.pool.countByApiKey(keyA.stored.id)).toBe(0);
  });

  test('idle eviction releases, never deletes', async () => {
    await create(keyA);
    await create(keyA);
    const evicted = core.pool.evictIdle(-1);
    expect(evicted).toHaveLength(2);
    for (const h of handles) { expect(h.released).toBe(1); expect(h.deleted).toBe(0); }
  });

  test('evictIdle removes a disposed session', async () => {
    await create(keyA);
    handles[0].status = 'disposed';
    expect(core.pool.evictIdle(1e12)).toEqual(['routed-1']);
    expect(core.pool.has('routed-1')).toBe(false);
  });

  test('drainAll does not abort a host-owned session', async () => {
    await create(keyA);
    await core.pool.drainAll();
    expect(handles[0].aborted).toBe(0);
  });

  test('WS delete destroys the host session', async () => {
    const { json } = await create(keyA);
    const ws = wsFor(core);
    expect(await (ws as any).rpcDeleteSession({ apiKey: keyA.stored }, [json.sessionId])).toEqual({ deleted: true });
    expect(handles[0].deleted).toBe(1);
    expect(core.pool.has(json.sessionId)).toBe(false);
  });

  test('drainAll releases, never deletes', async () => {
    await create(keyA);
    await core.pool.drainAll();
    expect(handles[0].released).toBe(1);
    expect(handles[0].deleted).toBe(0);
  });
});

describe('isSafeCommand', () => {
  test.each([
    ['ls -la', true],
    ['  ls', true],
    ['ls; rm -rf x', false],
    ['cat a | sh', false],
    ['echo $(id)', false],
    ['ls\nrm x', false],
    ['cat a > b', false],
    ['rm x', false],
    ['', false],
  ] as const)('%j -> %s', (cmd, expected) => {
    expect(isSafeCommand(cmd)).toBe(expected);
  });
});

describe('policyToPermissionMode', () => {
  test('mapping table', () => {
    expect(policyToPermissionMode('deny-all')).toBe('safe');
    expect(policyToPermissionMode('allow-safe')).toBe('ask');
    expect(policyToPermissionMode('allow-all')).toBe('allow-all');
    expect(policyToPermissionMode(undefined)).toBe('safe');
  });
});
