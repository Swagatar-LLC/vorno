/**
 * Conductor × Headroom — inter-node context compression (fork: PLAN-040 / SUV-0024).
 *
 * A separate file from `TaskRunner.test.ts` on purpose: that suite is the persistence and
 * scheduling contract this SUV must not disturb, and leaving it untouched is itself an acceptance
 * criterion. Everything here is additive.
 *
 * The fake adapter below implements the real `HeadroomAdapter` contract and holds a store keyed by
 * the handles it issues, so `retrieve()` can be asserted for byte-identical recovery — the property
 * that makes compressing a node's context reversible rather than lossy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  HeadroomAdapter,
  HeadroomCompressRequest,
  HeadroomCompressResult,
  HeadroomMeasurement,
  HeadroomRetrieveResult,
  HeadroomUsageStats,
} from '@craft-agent/core/types';
import { headroomMeasured, headroomUnavailable, resolveHeadroomConfig } from '@craft-agent/core/types';
import { createSessionHeadroomAdapter } from '@craft-agent/shared/headroom';
import type { CreateSessionOptions } from '@craft-agent/shared/protocol';
import {
  parseTaskSpec,
  saveTaskSpec,
  readRunLog,
  readNodeOutput,
  type TaskSpec,
} from '@craft-agent/shared/tasks';
import type { SessionCompletionEvent } from '../sessions/SessionManager';
import { TaskRunner, type ConductorSessionHost } from './TaskRunner';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw);
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues));
  return r.data;
}

/**
 * Deliberately awkward text: a combining mark, a zero-width joiner, a CRLF and trailing whitespace.
 * "Byte-identical" is only a meaningful assertion against content that a normalizing round-trip
 * would visibly damage.
 */
const AUDIT_TEXT = 'Findings: café́ ‍ — line one\r\nline two   ';

class FakeHeadroomAdapter implements HeadroomAdapter {
  readonly kind = 'sdk' as const;
  readonly compressCalls: HeadroomCompressRequest[] = [];
  private readonly store = new Map<string, string>();
  private counter = 0;

  async compress(request: HeadroomCompressRequest): Promise<HeadroomCompressResult> {
    this.compressCalls.push(request);
    const handles: string[] = [];
    const messages = request.messages.map((m) => {
      const handle = `handle-${++this.counter}`;
      this.store.set(handle, m.content);
      handles.push(handle);
      return { ...m, content: `[compressed:${handle}]` };
    });
    return {
      messages,
      compressed: true,
      retrievalHandles: handles,
      stats: headroomMeasured({
        tokensBefore: 100,
        tokensAfter: 10,
        tokensSaved: 90,
        compressionRatio: 0.1,
        transformsApplied: ['extract'],
      }),
    };
  }

  async retrieve(handle: string): Promise<HeadroomRetrieveResult> {
    const content = this.store.get(handle);
    return content === undefined
      ? { retrieved: false, reason: 'unknown-handle' }
      : { retrieved: true, content };
  }

  async stats(): Promise<HeadroomMeasurement<HeadroomUsageStats>> {
    return headroomUnavailable('service-unavailable');
  }
}

/** Same mock host as the main suite, trimmed to what these cases drive. */
class MockHost implements ConductorSessionHost {
  private readonly listeners = new Set<(evt: SessionCompletionEvent) => void>();
  readonly created: { id: string; options: CreateSessionOptions }[] = [];
  readonly sent: { sessionId: string; message: string }[] = [];
  readonly finalTextById = new Map<string, string>();

  async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    const id = `sess-${options.name}`;
    this.created.push({ id, options });
    return { id };
  }
  async sendMessage(sessionId: string, message: string): Promise<void> {
    this.sent.push({ sessionId, message });
  }
  async setSessionStatus(): Promise<void> {}
  async setKanbanColumn(): Promise<void> {}
  async setTaskNodeCount(): Promise<void> {}
  async cancelProcessing(): Promise<void> {}
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getSessionFinalText(sessionId: string): string | undefined {
    return this.finalTextById.get(sessionId);
  }
  getSessionWorkingDirectory(): string | undefined {
    return undefined;
  }

  promptFor(nodeId: string): string | undefined {
    return this.sent.find((s) => s.sessionId === `sess-${nodeId}`)?.message;
  }
  complete(nodeId: string, finalText: string): void {
    const evt: SessionCompletionEvent = {
      sessionId: `sess-${nodeId}`,
      workspaceId: 'ws',
      reason: 'complete',
      finalText,
    };
    for (const listener of [...this.listeners]) listener(evt);
  }
}

const CHAIN_SPEC = {
  id: 'chain',
  title: 'Chain',
  goal: 'audit then design',
  defaults: { model: 'claude-opus-5' },
  nodes: [
    { id: 'audit', prompt: 'Audit the code' },
    { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
  ],
};

describe('Conductor × Headroom (SUV-0024)', () => {
  let root: string;
  let host: MockHost;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-headroom-'));
    host = new MockHost();
    saveTaskSpec(root, specOf(CHAIN_SPEC));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRunner(headroom?: HeadroomAdapter): TaskRunner {
    return new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      now: () => '2026-06-07T00:00:00.000Z',
      ...(headroom ? { headroom } : {}),
    });
  }

  /** Run the two-node chain to the point where `design` has been dispatched. */
  async function runChain(runner: TaskRunner, runId: string): Promise<void> {
    runner.run('chain', { runId, verifyOnComplete: false });
    await tick();
    host.complete('audit', AUDIT_TEXT);
    await tick();
  }

  it('passes a node output through adapter.compress() before it enters downstream context', async () => {
    const adapter = new FakeHeadroomAdapter();
    await runChain(makeRunner(adapter), 'r1');

    // The upstream output reached the adapter, as a single assistant message, under the
    // downstream node's resolved model.
    expect(adapter.compressCalls.length).toBe(1);
    expect(adapter.compressCalls[0]!.messages).toEqual([{ role: 'assistant', content: AUDIT_TEXT }]);
    expect(adapter.compressCalls[0]!.model).toBe('claude-opus-5');

    // …and the downstream prompt carries the compressed form, not the original.
    const prompt = host.promptFor('design');
    expect(prompt).toBe('Design using [compressed:handle-1]');
    expect(prompt).not.toContain('Findings:');
  });

  it('records retrieval handles in the run log, and retrieve() returns byte-identical originals', async () => {
    const adapter = new FakeHeadroomAdapter();
    await runChain(makeRunner(adapter), 'r1');

    const entries = readRunLog(root, 'chain', 'r1').filter((e) => e.kind === 'node-compressed');
    expect(entries.length).toBe(1);
    const entry = entries[0] as { nodeId: string; handles: string[]; tokensSaved?: number };
    expect(entry.nodeId).toBe('audit');
    expect(entry.handles.length).toBe(1);
    expect(entry.tokensSaved).toBe(90);

    const recovered = await adapter.retrieve(entry.handles[0]!);
    expect(recovered.retrieved).toBe(true);
    const content = (recovered as { retrieved: true; content: string }).content;
    expect(content).toBe(AUDIT_TEXT);
    // Byte-for-byte, not merely string-equal after any normalization.
    expect(Buffer.from(content, 'utf8').equals(Buffer.from(AUDIT_TEXT, 'utf8'))).toBe(true);
  });

  it('leaves the recorded node output uncompressed on disk', async () => {
    await runChain(makeRunner(new FakeHeadroomAdapter()), 'r1');
    expect(readNodeOutput(root, 'chain', 'r1', 'audit')?.text).toBe(AUDIT_TEXT);
  });

  it('compresses each distinct output once, not once per consumer', async () => {
    rmSync(join(root, 'tasks'), { recursive: true, force: true });
    saveTaskSpec(
      root,
      specOf({
        id: 'chain',
        title: 'Fan out',
        goal: 'one audit, two consumers',
        nodes: [
          { id: 'audit', prompt: 'Audit the code' },
          { id: 'a', depends_on: ['audit'], prompt: 'A: ${nodes.audit.output}' },
          { id: 'b', depends_on: ['audit'], prompt: 'B: ${nodes.audit.output}' },
        ],
      }),
    );
    const adapter = new FakeHeadroomAdapter();
    await runChain(makeRunner(adapter), 'r1');

    expect(adapter.compressCalls.length).toBe(1);
    expect(host.promptFor('a')).toBe('A: [compressed:handle-1]');
    expect(host.promptFor('b')).toBe('B: [compressed:handle-1]');
  });

  it('does not compress an output the downstream node never references', async () => {
    rmSync(join(root, 'tasks'), { recursive: true, force: true });
    saveTaskSpec(
      root,
      specOf({
        id: 'chain',
        title: 'Unreferenced',
        goal: 'ordering dependency only',
        nodes: [
          { id: 'audit', prompt: 'Audit the code' },
          { id: 'design', depends_on: ['audit'], prompt: 'Design from scratch' },
        ],
      }),
    );
    const adapter = new FakeHeadroomAdapter();
    await runChain(makeRunner(adapter), 'r1');

    expect(adapter.compressCalls.length).toBe(0);
    expect(host.promptFor('design')).toBe('Design from scratch');
  });

  describe('with Headroom disabled', () => {
    /** Prompts + run-log entry kinds — the observable dispatch behaviour and run record. */
    async function observe(headroom: HeadroomAdapter | undefined, runId: string) {
      const localHost = new MockHost();
      host = localHost;
      const runner = new TaskRunner({
        host: localHost,
        workspaceId: 'ws',
        workspaceRoot: root,
        now: () => '2026-06-07T00:00:00.000Z',
        ...(headroom ? { headroom } : {}),
      });
      await runChain(runner, runId);
      return {
        prompts: localHost.sent.map((s) => `${s.sessionId}::${s.message}`),
        log: readRunLog(root, 'chain', runId).map((e) => JSON.stringify(e)),
        output: readNodeOutput(root, 'chain', runId, 'audit'),
      };
    }

    it('dispatches and records exactly as it does with no adapter at all', async () => {
      // Baseline: no adapter wired — literally the pre-SUV code path.
      const baseline = await observe(undefined, 'baseline');
      // The adapter a workspace with Headroom switched off actually gets: resolved-from-nothing
      // config through the boundary factory, not a hand-picked implementation (SUV-0018's guard).
      const disabled = await observe(
        await createSessionHeadroomAdapter(resolveHeadroomConfig(undefined, undefined)),
        'disabled',
      );

      expect(disabled.prompts).toEqual(baseline.prompts);
      expect(disabled.output).toEqual(baseline.output);
      // Same events in the same order; only the run id embedded in `run-started` differs.
      expect(disabled.log.map((l) => l.replaceAll('"disabled"', '"baseline"'))).toEqual(baseline.log);
      expect(disabled.log.some((l) => l.includes('node-compressed'))).toBe(false);
      expect(disabled.prompts.some((p) => p.includes('compressed'))).toBe(false);
    });
  });
});
