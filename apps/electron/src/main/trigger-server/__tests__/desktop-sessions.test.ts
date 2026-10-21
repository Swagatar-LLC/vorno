/**
 * fork(PLAN-057): desktop session route-through, against a fake SessionManager
 * and the real event tap. No Electron.
 */
import { describe, test, expect } from 'bun:test';
import type { AgentEvent } from '@craft-agent/core/types';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { createDesktopSessionRoute, toAgentEvent, type DesktopSessionDeps } from '../desktop-sessions';
import { createSessionEventTap } from '../session-event-tap';

const clock = { t: 1000 };

function setup(opts: { sendMessage?: (id: string, c: string, o?: { optimisticMessageId?: string }) => Promise<unknown>; status?: 'idle' | 'processing' | 'disposed' } = {}) {
  const tap = createSessionEventTap();
  const forwarded: unknown[][] = [];
  const sink = tap.wrapSink((...args: unknown[]) => { forwarded.push(args); });
  const emit = (e: SessionEvent) => sink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: 'w1' }, e);
  const calls: Record<string, unknown[][]> = { create: [], send: [], cancel: [], respond: [], del: [] };
  let status: 'idle' | 'processing' | 'disposed' = opts.status ?? 'idle';
  const deps: DesktopSessionDeps = {
    async createSession(ws, o) { calls.create!.push([ws, o]); return { id: 's1' }; },
    async sendMessage(id, c, o) { calls.send!.push([id, c]); return opts.sendMessage ? opts.sendMessage(id, c, o) : undefined; },
    async cancelProcessing(id) { calls.cancel!.push([id]); },
    respondToPermission(id, rid, allowed, always) { calls.respond!.push([id, rid, allowed, always]); return true; },
    async deleteSession(id) { calls.del!.push([id]); },
    getStatus: () => status,
    subscribe: tap.subscribe,
    now: () => clock.t,
  };
  const route = createDesktopSessionRoute(deps);
  const create = (o: Partial<Parameters<typeof route>[0]> = {}) =>
    route({ workspaceId: 'w1', permissionPolicy: 'allow-safe', apiKeyName: 'CI', ...o });
  return { tap, emit, calls, create, forwarded, setStatus: (s: typeof status) => { status = s; } };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createSession', () => {
  test.each([
    ['deny-all', 'safe'],
    ['allow-safe', 'ask'],
    ['allow-all', 'allow-all'],
  ] as const)('policy %s maps to permissionMode %s', async (policy, mode) => {
    const s = setup();
    await s.create({ permissionPolicy: policy });
    expect((s.calls.create![0]![1] as { permissionMode: string }).permissionMode).toBe(mode);
  });

  test('passes model, sources, working directory and the API label; never hidden/unattended', async () => {
    const s = setup();
    const h = await s.create({ model: 'm1', enabledSources: ['a', 'b'], workingDirectory: '/tmp/x', apiKeyName: 'Nightly' });
    const [ws, o] = s.calls.create![0]!;
    expect(ws).toBe('w1');
    expect(o).toEqual({ permissionMode: 'ask', model: 'm1', enabledSourceSlugs: ['a', 'b'], workingDirectory: '/tmp/x', name: 'API · Nightly' });
    expect(h.sessionId).toBe('s1');
    expect(h.workspaceId).toBe('w1');
  });
});

describe('tap', () => {
  test('passes every call through unchanged, including other channels', () => {
    const s = setup();
    s.emit({ type: 'session_created', sessionId: 'zz' });
    expect(s.forwarded.length).toBe(1);
  });
});

describe('chat', () => {
  test('translates events and ends on complete', async () => {
    const s = setup({ sendMessage: async () => {
      s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'hi' } as never, status: 'accepted' });
      s.emit({ type: 'text_delta', sessionId: 's1', delta: 'He' });
      s.emit({ type: 'text_complete', sessionId: 's1', text: 'Hello' });
      s.emit({ type: 'tool_start', sessionId: 's1', toolName: 'Bash', toolUseId: 't1', toolInput: { c: 1 }, toolIntent: 'i', toolDisplayName: 'D' });
      s.emit({ type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolUseId: 't1', result: 'ok' });
      s.emit({ type: 'title_generated', sessionId: 's1', title: 'ui only' });
      s.emit({ type: 'complete', sessionId: 's1', tokenUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, contextTokens: 3, costUsd: 0.5 } });
      s.emit({ type: 'text_delta', sessionId: 's1', delta: 'after end' });
    } });
    const h = await s.create();
    const events = await collect(h.chat('hi'));
    expect(events).toEqual([
      { type: 'text_delta', text: 'He', turnId: undefined },
      { type: 'text_complete', text: 'Hello', isIntermediate: undefined, turnId: undefined, parentToolUseId: undefined },
      expect.objectContaining({ type: 'tool_start', toolName: 'Bash', input: { c: 1 }, intent: 'i', displayName: 'D' }),
      expect.objectContaining({ type: 'tool_result', toolUseId: 't1', result: 'ok', isError: false }),
      expect.objectContaining({ type: 'complete', usage: expect.objectContaining({ inputTokens: 3, outputTokens: 4, costUsd: 0.5 }) }),
    ]);
    expect(s.calls.send).toEqual([['s1', 'hi']]);
  });

  test('ends on interrupted (as complete)', async () => {
    const s = setup({ sendMessage: async () => { s.emit({ type: 'interrupted', sessionId: 's1' }); } });
    const h = await s.create();
    expect(await collect(h.chat('x'))).toEqual([{ type: 'complete' }]);
  });

  test('ends on error', async () => {
    const s = setup({ sendMessage: async () => { s.emit({ type: 'error', sessionId: 's1', error: 'boom' }); } });
    const h = await s.create();
    expect(await collect(h.chat('x'))).toEqual([{ type: 'error', message: 'boom' }]);
  });

  test('a rejected send yields error and ends', async () => {
    const s = setup({ sendMessage: async () => { throw new Error('no such session'); } });
    const h = await s.create();
    expect(await collect(h.chat('x'))).toEqual([{ type: 'error', message: 'no such session' }]);
  });

  test('forwards permission_request and does not answer it', async () => {
    const s = setup({ sendMessage: async () => {
      s.emit({ type: 'permission_request', sessionId: 's1', request: { sessionId: 's1', requestId: 'r1', toolName: 'Bash', command: 'ls', description: 'list', type: 'bash' } });
      s.emit({ type: 'complete', sessionId: 's1' });
    } });
    const h = await s.create();
    const events = await collect(h.chat('x'));
    expect(events[0]).toEqual(expect.objectContaining({ type: 'permission_request', requestId: 'r1', toolName: 'Bash', command: 'ls', description: 'list', permissionType: 'bash' }));
    expect(s.calls.respond).toEqual([]);
  });

  test('events of another session are ignored', async () => {
    const s = setup({ sendMessage: async () => {
      s.emit({ type: 'complete', sessionId: 'other' });
      s.emit({ type: 'complete', sessionId: 's1' });
    } });
    const h = await s.create();
    expect(await collect(h.chat('x'))).toEqual([{ type: 'complete' }]);
  });

  test('a send queued behind a running turn ignores that turn and ends with its own', async () => {
    let mine: string | undefined;
    const s = setup({ sendMessage: async (_id, _c, o) => {
      mine = o?.optimisticMessageId;
      s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'mine' } as never, status: 'queued', optimisticMessageId: mine });
    } });
    const h = await s.create();
    const p = collect(h.chat('mine'));
    await tick();
    expect(mine).toBeTruthy();
    s.emit({ type: 'text_delta', sessionId: 's1', delta: 'old turn' });
    s.emit({ type: 'complete', sessionId: 's1' }); // the UI turn ends
    s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'mine' } as never, status: 'processing', optimisticMessageId: mine });
    s.emit({ type: 'text_delta', sessionId: 's1', delta: 'new' });
    s.emit({ type: 'complete', sessionId: 's1' });
    expect(await p).toEqual([{ type: 'text_delta', text: 'new', turnId: undefined }, { type: 'complete' }]);
  });

  test('a later queued message starting its turn ends ours, matched by id not content', async () => {
    let mine: string | undefined;
    const s = setup({ sendMessage: async (_id, _c, o) => {
      mine = o?.optimisticMessageId;
      s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'same' } as never, status: 'accepted', optimisticMessageId: mine });
      s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'same' } as never, status: 'processing', optimisticMessageId: mine });
      s.emit({ type: 'text_delta', sessionId: 's1', delta: 'ours' });
      // no `complete`: a queued message follows
      s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'same' } as never, status: 'processing', optimisticMessageId: 'other-id' });
      s.emit({ type: 'text_delta', sessionId: 's1', delta: 'theirs' });
    } });
    const h = await s.create();
    expect(await collect(h.chat('same'))).toEqual([{ type: 'text_delta', text: 'ours', turnId: undefined }, { type: 'complete' }]);
  });

  test('a merged queue replay announcing another message before the turn does not end ours', async () => {
    let mine: string | undefined;
    const s = setup({ sendMessage: async (_id, _c, o) => {
      mine = o?.optimisticMessageId;
      s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'mine' } as never, status: 'processing', optimisticMessageId: mine });
      s.emit({ type: 'user_message', sessionId: 's1', message: { content: 'typed' } as never, status: 'processing', optimisticMessageId: 'merged-id' });
      s.emit({ type: 'text_delta', sessionId: 's1', delta: 'both' });
      s.emit({ type: 'complete', sessionId: 's1' });
    } });
    const h = await s.create();
    expect(await collect(h.chat('mine'))).toEqual([{ type: 'text_delta', text: 'both', turnId: undefined }, { type: 'complete' }]);
  });

  test('session_deleted ends the stream with an error', async () => {
    const s = setup();
    const h = await s.create();
    const p = collect(h.chat('x'));
    await tick();
    s.emit({ type: 'session_deleted', sessionId: 's1' });
    expect(await p).toEqual([{ type: 'error', message: 'Session was deleted in the desktop app' }]);
  });

  test('release ends a chat in flight without answering it', async () => {
    const s = setup();
    const h = await s.create();
    const p = collect(h.chat('x'));
    await tick();
    h.release();
    expect(await p).toEqual([]);
  });

  test('tracks lastActivityAt from events', async () => {
    const s = setup({ sendMessage: async () => { s.emit({ type: 'complete', sessionId: 's1' }); } });
    const h = await s.create();
    expect(h.getLastActivityAt()).toBe(1000);
    clock.t = 2000;
    await collect(h.chat('x'));
    expect(h.getLastActivityAt()).toBe(2000);
  });
});

describe('handle delegation', () => {
  test('abort, respond, status, delete', async () => {
    const s = setup();
    const h = await s.create();
    await h.abort();
    expect(s.calls.cancel).toEqual([['s1']]);
    expect(h.respondToPermission('r9', true)).toBe(true);
    expect(s.calls.respond).toEqual([['s1', 'r9', true, false]]);
    expect(h.getStatus()).toBe('idle');
    s.setStatus('processing');
    expect(h.getStatus()).toBe('processing');
    expect(h.getSdkSessionId()).toBeUndefined();
    await h.delete();
    expect(s.calls.del).toEqual([['s1']]);
  });

  test('release unsubscribes and does not delete the desktop session', async () => {
    const s = setup();
    const h = await s.create();
    h.release();
    h.release();
    expect(s.calls.del).toEqual([]);
  });
});

describe('toAgentEvent', () => {
  test('drops UI-only events and maps retry/info/error', () => {
    expect(toAgentEvent({ type: 'sources_changed', sessionId: 's', enabledSourceSlugs: [] })).toBeNull();
    expect(toAgentEvent({ type: 'retry', sessionId: 's', phase: 'backoff', message: 'm' })).toEqual({ type: 'retry', phase: 'backoff', message: 'm' });
    expect(toAgentEvent({ type: 'retry', sessionId: 's', phase: 'end' })).toEqual({ type: 'retry', phase: 'end' });
    expect(toAgentEvent({ type: 'info', sessionId: 's', message: 'i' })).toEqual({ type: 'info', message: 'i' });
    expect(toAgentEvent({ type: 'error', sessionId: 's', error: 'e' })).toEqual({ type: 'error', message: 'e' });
  });
});
