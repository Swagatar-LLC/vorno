/**
 * Tool outputs go through the session's Headroom adapter (fork: PLAN-040 / SUV-0023).
 *
 * These run the real ingest step — `prepareToolResultForContext`, the function
 * `claude-agent.ts`'s loop calls for every tool result — against a real
 * `SdkHeadroomAdapter` built by the real boundary factory. The only stand-in is
 * the SDK transport itself, injected through the loader seam SUV-0015 provided.
 * Nothing about the guard, the adapter, the compression rules, or the event that
 * ends up in context is simulated.
 *
 * The four claims under test map 1:1 to the SUV's acceptance list:
 *   1. an enabled workspace's tool output reaches `compress()`
 *   2. the resulting context item carries a handle that redeems the *byte-identical* original
 *   3. a disabled workspace produces byte-identical context
 *   4. (elsewhere) the boundary gate still finds one SDK importer
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, HeadroomAdapter, Message } from '@craft-agent/core/types';
import { messageToStored, storedToMessage } from '@craft-agent/core/types';
import { createHeadroomAdapter } from '../../headroom/index.ts';
import { readSessionMessages, writeSessionJsonl } from '../../sessions/jsonl.ts';
import type { StoredSession } from '../../sessions/types.ts';
import type {
  HeadroomSdkClient,
  HeadroomSdkModule,
} from '../../headroom/sdk-adapter.ts';
import { prepareToolResultForContext } from '../tool-result-context.ts';

type ToolResultEvent = Extract<AgentEvent, { type: 'tool_result' }>;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

function sessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'suv0023-session-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * A tool output that is representative in the sense that matters here: large
 * enough to be worth compressing and to be a real context consumer, but below
 * the large-result guard's threshold, so it is exactly the content that reaches
 * the model verbatim today. Built from varied lines rather than a repeated
 * character so it is not base64-dense (which would divert it to the guard).
 */
function representativeToolOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 400; i += 1) {
    lines.push(
      `2026-08-26T12:${String(i % 60).padStart(2, '0')}:00Z  request ${i} ` +
        `status=200 duration=${i * 3}ms route=/api/items/${i} note=ordinary log line`,
    );
  }
  return lines.join('\n');
}

interface CompressCall {
  messages: unknown[];
  options?: { model?: string; tokenBudget?: number };
}

interface FakeService {
  /** Every `compress` call the boundary made, in order. */
  compressCalls: CompressCall[];
  /** What the service should answer with; `null` declines compression. */
  respond: (messages: unknown[]) => unknown;
  /** Handle → original content the service holds. */
  store: Map<string, string>;
}

/** An SDK module whose client is backed by {@link FakeService}. */
function fakeSdk(service: FakeService): HeadroomSdkModule {
  return {
    HeadroomClient: class implements HeadroomSdkClient {
      async compress(
        messages: unknown[],
        options?: { model?: string; tokenBudget?: number },
      ): Promise<unknown> {
        service.compressCalls.push({
          messages,
          ...(options === undefined ? {} : { options }),
        });
        return service.respond(messages);
      }
      async retrieve(hash: string): Promise<unknown> {
        const content = service.store.get(hash);
        if (content === undefined) {
          throw Object.assign(new Error('not found'), { statusCode: 404 });
        }
        return { originalContent: content };
      }
      async getStats(): Promise<unknown> {
        return null;
      }
    },
  };
}

/**
 * A service that genuinely compresses: it replaces the tool message's content
 * with a short stand-in, keeps the original under a handle, and reports honest
 * token numbers. This is the shape the real proxy answers with.
 */
function compressingService(): FakeService {
  const service: FakeService = {
    compressCalls: [],
    store: new Map(),
    respond: (messages) => {
      const first = messages[0] as Record<string, unknown>;
      const original = String(first.content);
      const handle = 'ccr_suv0023_handle';
      service.store.set(handle, original);
      const compressed = `[compressed: ${original.length} bytes]`;
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
      };
    },
  };
  return service;
}

function toolResultEvent(result: string): ToolResultEvent {
  return {
    type: 'tool_result',
    toolUseId: 'toolu_suv0023',
    toolName: 'Bash',
    result,
    isError: false,
    input: { command: 'cat access.log' },
    turnId: 'turn_1',
  };
}

/** Enabled workspace → the real SDK-backed adapter over the fake service. */
function enabledAdapter(service: FakeService): Promise<HeadroomAdapter> {
  return createHeadroomAdapter(
    { enabled: true, model: 'test-model' },
    { loadSdk: async () => fakeSdk(service) },
  );
}

// ============================================================
// Acceptance 1 — tool outputs reach compress()
// ============================================================

describe('SUV-0023: tool outputs pass through adapter.compress()', () => {
  it('hands the enabled adapter the exact tool output, as a tool message', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);
    const output = representativeToolOutput();

    await prepareToolResultForContext(toolResultEvent(output), {
      sessionPath: sessionDir(),
      headroom: async () => adapter,
    });

    expect(service.compressCalls).toHaveLength(1);
    expect(service.compressCalls[0]?.messages).toEqual([
      {
        role: 'tool',
        content: output,
        tool_call_id: 'toolu_suv0023',
        name: 'Bash',
      },
    ]);
  });

  it('puts the compressed content — not the original — into the context item', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);
    const output = representativeToolOutput();

    const prepared = await prepareToolResultForContext(toolResultEvent(output), {
      sessionPath: sessionDir(),
      headroom: async () => adapter,
    });

    expect(prepared).not.toBeNull();
    expect(prepared?.result).not.toBe(output);
    expect(prepared?.result).toBe(`[compressed: ${output.length} bytes]`);
    expect(prepared?.result.length).toBeLessThan(output.length);
  });

  it('carries the session model through to the service', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);

    await prepareToolResultForContext(toolResultEvent(representativeToolOutput()), {
      sessionPath: sessionDir(),
      headroom: async () => adapter,
    });

    expect(service.compressCalls[0]?.options?.model).toBe('test-model');
  });
});

// ============================================================
// Acceptance 2 — round trip
// ============================================================

describe('SUV-0023: compressed items round-trip through adapter.retrieve()', () => {
  it('redeems the byte-identical original from the item’s handle', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);
    const output = representativeToolOutput();

    const prepared = await prepareToolResultForContext(toolResultEvent(output), {
      sessionPath: sessionDir(),
      headroom: async () => adapter,
    });

    const handle = prepared?.headroomHandle;
    expect(typeof handle).toBe('string');

    const retrieved = await adapter.retrieve(handle as string);
    expect(retrieved.retrieved).toBe(true);
    expect(retrieved.retrieved === true ? retrieved.content : null).toBe(output);
  });

  it('reports a miss — never fabricated content — for a handle the service lost', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);

    const prepared = await prepareToolResultForContext(
      toolResultEvent(representativeToolOutput()),
      { sessionPath: sessionDir(), headroom: async () => adapter },
    );
    service.store.clear();

    const retrieved = await adapter.retrieve(prepared?.headroomHandle as string);
    expect(retrieved).toEqual({ retrieved: false, reason: 'unknown-handle' });
  });
});

// ============================================================
// Compression is refused rather than accepted unsafely
// ============================================================

describe('SUV-0023: an unredeemable compression is refused', () => {
  const cases: Array<{ name: string; respond: FakeService['respond'] }> = [
    {
      name: 'no retrieval handle — the original would be unrecoverable',
      respond: (messages) => ({
        compressed: true,
        messages: [
          {
            role: 'tool',
            content: 'shrunk',
            tool_call_id: (messages[0] as Record<string, unknown>).tool_call_id,
          },
        ],
        ccrHashes: [],
      }),
    },
    {
      name: 'several handles — one carrier cannot promise the whole original',
      respond: (messages) => ({
        compressed: true,
        messages: [
          {
            role: 'tool',
            content: 'shrunk',
            tool_call_id: (messages[0] as Record<string, unknown>).tool_call_id,
          },
        ],
        ccrHashes: ['h1', 'h2'],
      }),
    },
    {
      name: 'answers about a different tool call',
      respond: () => ({
        compressed: true,
        messages: [{ role: 'tool', content: 'shrunk', tool_call_id: 'someone_else' }],
        ccrHashes: ['h1'],
      }),
    },
    {
      name: 'service declined to compress',
      respond: () => ({ compressed: false }),
    },
    {
      name: 'service is unreachable',
      respond: () => {
        throw new Error('ECONNREFUSED');
      },
    },
  ];

  for (const { name, respond } of cases) {
    it(`passes the original through unchanged when the service ${name}`, async () => {
      const service = compressingService();
      service.respond = respond;
      const adapter = await enabledAdapter(service);
      const output = representativeToolOutput();

      const prepared = await prepareToolResultForContext(toolResultEvent(output), {
        sessionPath: sessionDir(),
        headroom: async () => adapter,
      });

      // `null` is the loop's "unchanged" signal, so the original event is what
      // enters context.
      expect(prepared).toBeNull();
    });
  }
});

// ============================================================
// Acceptance 3 — the disabled path is byte-identical
// ============================================================

describe('SUV-0023: Headroom disabled leaves session context byte-identical', () => {
  /**
   * Reproduces pre-SUV behaviour exactly: the guard, and nothing else. This is
   * the code that used to sit inline in `claude-agent.ts`, kept here as the
   * comparison baseline so "byte-identical" is asserted against a real
   * reference rather than an expectation typed out by hand.
   */
  async function preSuvBehaviour(
    event: ToolResultEvent,
    sessionPath: string,
  ): Promise<ToolResultEvent | null> {
    const { guardLargeResult } = await import('../../utils/large-response.ts');
    const guarded = await guardLargeResult(event.result, {
      sessionPath,
      toolName: event.toolName || 'unknown',
      ...(event.input === undefined ? {} : { input: event.input }),
    });
    return guarded ? { ...event, result: guarded } : null;
  }

  const outputs: Array<{ name: string; text: string }> = [
    { name: 'a small result', text: 'ok' },
    { name: 'a representative result below the guard threshold', text: representativeToolOutput() },
  ];

  for (const { name, text } of outputs) {
    it(`produces the same transcript entry as pre-SUV code for ${name}`, async () => {
      const disabled = await createHeadroomAdapter({ enabled: false });
      const event = toolResultEvent(text);

      const before = await preSuvBehaviour(event, sessionDir());
      const after = await prepareToolResultForContext(event, {
        sessionPath: sessionDir(),
        headroom: async () => disabled,
      });

      expect(after).toEqual(before);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });
  }

  it('never adds a retrieval handle on the no-op path', async () => {
    const disabled = await createHeadroomAdapter({ enabled: false });
    const prepared = await prepareToolResultForContext(
      toolResultEvent(representativeToolOutput()),
      { sessionPath: sessionDir(), headroom: async () => disabled },
    );

    // The no-op issues no handles, so nothing is compressed and the event is
    // returned unchanged — the key is absent, not present-and-undefined.
    expect(prepared).toBeNull();
  });

  it('keeps the guard’s own output byte-identical when it fires', async () => {
    // A result far above the guard threshold, so the guard replaces it with a
    // file reference. With Headroom off that replacement must be untouched.
    const huge = representativeToolOutput().repeat(60);
    const disabled = await createHeadroomAdapter({ enabled: false });
    const event = toolResultEvent(huge);

    const after = await prepareToolResultForContext(event, {
      sessionPath: sessionDir(),
      headroom: async () => disabled,
    });

    expect(after).not.toBeNull();
    expect(after?.headroomHandle).toBeUndefined();
    expect(after?.result).toContain('Full data saved to:');
    expect(Object.keys(after as object).sort()).toEqual(Object.keys(event).sort());
  });
});

// ============================================================
// The guard still runs first, and compression sees its output
// ============================================================

// ============================================================
// Acceptance 5 — persistence and replay, with compression active
// ============================================================

/**
 * The message SessionManager builds from a `tool_result` event, reproduced
 * here at the shape it persists. See
 * `packages/server-core/src/sessions/SessionManager.ts:8252-8325`: the result
 * goes to `toolResult`, and the three Headroom fields are copied on as one
 * all-or-nothing set keyed off `headroomHandle`.
 *
 * Rebuilt rather than imported because `packages/shared` sits below
 * `packages/server-core`; importing SessionManager here would invert the
 * dependency. What matters for persistence is the message shape, and that is
 * what this reproduces.
 */
function toolMessageFrom(event: ToolResultEvent): Message {
  return {
    id: 'msg_suv0023',
    role: 'tool',
    content: `Ran ${event.toolName}`,
    timestamp: 1_756_000_000_000,
    toolName: event.toolName as string,
    toolUseId: event.toolUseId,
    toolResult: event.result,
    toolStatus: 'completed',
    isError: event.isError,
    ...(event.headroomHandle === undefined
      ? {}
      : {
          headroomHandle: event.headroomHandle,
          ...(event.headroomOriginalBytes === undefined
            ? {}
            : { headroomOriginalBytes: event.headroomOriginalBytes }),
          ...(event.headroomCompressedBytes === undefined
            ? {}
            : { headroomCompressedBytes: event.headroomCompressedBytes }),
        }),
  } as Message;
}

/**
 * Persist one message through the real durability path and read it back the way
 * a session reload does: `messageToStored` → `writeSessionJsonl` →
 * `readSessionMessages` → `storedToMessage`. No stand-ins — this is the same
 * write and the same parse a live session performs.
 *
 * @returns the replayed message and the raw JSONL line that held it.
 */
function persistAndReplay(message: Message): { replayed: Message; line: string } {
  const dir = sessionDir();
  const file = join(dir, 'session.jsonl');
  const session = {
    id: '260827-suv0023',
    workspaceRootPath: '/tmp/ws',
    createdAt: 1_756_000_000_000,
    lastUsedAt: 1_756_000_000_001,
    name: 'SUV-0023 persistence',
    messages: [messageToStored(message)],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  } as unknown as StoredSession;

  writeSessionJsonl(file, session);

  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const stored = readSessionMessages(file);
  expect(stored).toHaveLength(1);

  return {
    replayed: storedToMessage(stored[0] as never),
    // Line 1 is the header; line 2 is the message.
    line: lines[1] as string,
  };
}

describe('SUV-0023: persistence and replay hold with compression active', () => {
  it('replays a compressed tool result whose handle still redeems the original', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);
    const output = representativeToolOutput();

    const prepared = await prepareToolResultForContext(toolResultEvent(output), {
      sessionPath: sessionDir(),
      headroom: async () => adapter,
    });
    expect(prepared).not.toBeNull();

    const { replayed } = persistAndReplay(toolMessageFrom(prepared as ToolResultEvent));

    // The transcript carries the compressed text — what the model actually read —
    // not the original, and not a truncation of it.
    expect(replayed.toolResult).toBe(`[compressed: ${output.length} bytes]`);
    expect(replayed.toolResult).toBe(prepared?.result);

    // And the handle survives the round trip intact, so a reloaded session can
    // still redeem the byte-identical original. A handle that did not survive
    // would leave a transcript permanently smaller than the truth.
    expect(replayed.headroomHandle).toBe(prepared?.headroomHandle as string);
    const retrieved = await adapter.retrieve(replayed.headroomHandle as string);
    expect(retrieved.retrieved === true ? retrieved.content : null).toBe(output);
  });

  it('writes the compression marker into the JSONL line itself', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);

    const prepared = await prepareToolResultForContext(
      toolResultEvent(representativeToolOutput()),
      { sessionPath: sessionDir(), headroom: async () => adapter },
    );

    const { line } = persistAndReplay(toolMessageFrom(prepared as ToolResultEvent));
    const parsed = JSON.parse(line) as Record<string, unknown>;

    // Asserted against the parsed line rather than the mapper's return value so
    // this fails if the field is ever dropped at serialization rather than at
    // mapping.
    expect(parsed.headroomHandle).toBe(prepared?.headroomHandle as string);
  });

  it('leaves the persisted transcript byte-identical when Headroom is off', async () => {
    const disabled = await createHeadroomAdapter({ enabled: false });
    const event = toolResultEvent(representativeToolOutput());

    // Pre-SUV: the guard declined, so the original event is what was persisted.
    const before = persistAndReplay(toolMessageFrom(event));

    const after = await prepareToolResultForContext(event, {
      sessionPath: sessionDir(),
      headroom: async () => disabled,
    });
    const withChange = persistAndReplay(toolMessageFrom((after ?? event) as ToolResultEvent));

    // Byte-for-byte on the serialized line, not just structurally equal: key
    // order and the absence of the marker key both matter to "identical".
    expect(withChange.line).toBe(before.line);
    expect(withChange.line).not.toContain('headroomHandle');
    expect(withChange.replayed).toEqual(before.replayed);
  });
});

describe('SUV-0023: compression applies to what actually enters context', () => {
  it('compresses the guard’s replacement, not the raw oversized result', async () => {
    const service = compressingService();
    const adapter = await enabledAdapter(service);
    const huge = representativeToolOutput().repeat(60);

    const prepared = await prepareToolResultForContext(toolResultEvent(huge), {
      sessionPath: sessionDir(),
      headroom: async () => adapter,
    });

    expect(service.compressCalls).toHaveLength(1);
    const sent = String(
      (service.compressCalls[0]?.messages[0] as Record<string, unknown>).content,
    );
    expect(sent).not.toBe(huge);
    expect(sent).toContain('Full data saved to:');

    // And the original the handle redeems is the guard's message — the text
    // that would otherwise have entered context.
    const retrieved = await adapter.retrieve(prepared?.headroomHandle as string);
    expect(retrieved.retrieved === true ? retrieved.content : null).toBe(sent);
  });
});
