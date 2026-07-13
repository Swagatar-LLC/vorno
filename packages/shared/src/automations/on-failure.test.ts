/**
 * fork(PLAN-017): tests for runOnFailureActions (on-failure.ts).
 *
 * Covers: prompt routing via onPromptsReady (matcher-less PendingPrompt),
 * runPrompt preference, webhook default failure-context body vs explicit body
 * passthrough (captured by a local Bun.serve endpoint), and error swallowing.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { runOnFailureActions, type OnFailureContext } from './on-failure.ts';
import type { PendingPrompt, PromptAction } from './types.ts';

const baseContext: OnFailureContext = {
  automationId: 'm1',
  failureKind: 'outcome',
  sessionId: 'sess-9',
  errorCount: 2,
};

describe('runOnFailureActions', () => {
  // --------------------------------------------------------------------------
  // Prompt branch
  // --------------------------------------------------------------------------

  it('routes a prompt action through onPromptsReady as a matcher-less PendingPrompt', async () => {
    const captured: PendingPrompt[] = [];

    await runOnFailureActions({
      onFailure: [{ type: 'prompt', prompt: 'investigate @backup failure' }],
      automationName: 'Nightly backup',
      workspaceRootPath: '/tmp',
      context: baseContext,
      onPromptsReady: (prompts) => captured.push(...prompts),
    });

    expect(captured).toHaveLength(1);
    const pending = captured[0]!;
    // matcherId undefined ⇒ host writes no history ⇒ no recursion.
    expect(pending.matcherId).toBeUndefined();
    expect(pending.automationName).toBe('Nightly backup (onFailure)');
    expect(pending.prompt).toBe('investigate @backup failure');
    // @mentions are parsed so the spawned session resolves sources/skills.
    expect(pending.mentions).toEqual(['backup']);
  });

  it('uses the generic automationName when the matcher has no name', async () => {
    const captured: PendingPrompt[] = [];

    await runOnFailureActions({
      onFailure: [{ type: 'prompt', prompt: 'x' }],
      workspaceRootPath: '/tmp',
      context: baseContext,
      onPromptsReady: (prompts) => captured.push(...prompts),
    });

    expect(captured[0]!.automationName).toBe('Automation onFailure');
  });

  it('prefers runPrompt over onPromptsReady when both are supplied', async () => {
    const viaRunPrompt: PromptAction[] = [];
    const viaCallback: PendingPrompt[] = [];

    await runOnFailureActions({
      onFailure: [{ type: 'prompt', prompt: 'direct path', model: 'haiku' }],
      workspaceRootPath: '/tmp',
      context: baseContext,
      runPrompt: async (action) => { viaRunPrompt.push(action); },
      onPromptsReady: (prompts) => viaCallback.push(...prompts),
    });

    expect(viaRunPrompt).toHaveLength(1);
    expect(viaRunPrompt[0]!.prompt).toBe('direct path');
    expect(viaRunPrompt[0]!.model).toBe('haiku');
    expect(viaCallback).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Webhook branch — local server captures the request
  // --------------------------------------------------------------------------

  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  function startCapture(): { url: string; requests: Array<{ body: unknown; contentType: string | null }> } {
    const requests: Array<{ body: unknown; contentType: string | null }> = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const text = await req.text();
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* keep raw */ }
        requests.push({ body, contentType: req.headers.get('content-type') });
        return new Response('ok', { status: 200 });
      },
    });
    return { url: `http://localhost:${server.port}/hook`, requests };
  }

  it('webhook with no explicit body sends the failure-context JSON', async () => {
    const { url, requests } = startCapture();

    await runOnFailureActions({
      onFailure: [{ type: 'webhook', url }],
      workspaceRootPath: '/tmp',
      context: {
        automationId: 'm1',
        failureKind: 'missed',
        expectedTs: 1_700_000_000_000,
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.contentType).toContain('application/json');
    expect(requests[0]!.body).toEqual({
      automationId: 'm1',
      failureKind: 'missed',
      ok: false,
      expectedTs: 1_700_000_000_000,
    });
  });

  it('failure-context body includes sessionId/errorCount/error when present', async () => {
    const { url, requests } = startCapture();

    await runOnFailureActions({
      onFailure: [{ type: 'webhook', url }],
      workspaceRootPath: '/tmp',
      context: {
        automationId: 'm2',
        failureKind: 'dispatch',
        sessionId: 'sess-1',
        errorCount: 3,
        error: 'boom',
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({
      automationId: 'm2',
      failureKind: 'dispatch',
      ok: false,
      sessionId: 'sess-1',
      errorCount: 3,
      error: 'boom',
    });
  });

  it('webhook with an explicit body passes it through untouched', async () => {
    const { url, requests } = startCapture();

    await runOnFailureActions({
      onFailure: [{ type: 'webhook', url, body: { text: 'custom alert' } }],
      workspaceRootPath: '/tmp',
      context: baseContext,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ text: 'custom alert' });
  });

  // --------------------------------------------------------------------------
  // Error swallowing
  // --------------------------------------------------------------------------

  it('swallows a throwing action and still runs subsequent actions (never rejects)', async () => {
    const { url, requests } = startCapture();

    // First action: prompt whose runPrompt throws. Second action: webhook that
    // must still execute.
    await expect(runOnFailureActions({
      onFailure: [
        { type: 'prompt', prompt: 'will throw' },
        { type: 'webhook', url, body: { text: 'still delivered' } },
      ],
      workspaceRootPath: '/tmp',
      context: baseContext,
      runPrompt: async () => { throw new Error('executePromptAutomation exploded'); },
    })).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ text: 'still delivered' });
  });

  it('a failing webhook (HTTP 404) does not reject and does not block later actions', async () => {
    // 404 = client error → executeWithRetry does NOT retry (fast) and returns a
    // failed result rather than throwing.
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch: () => new Response('nope', { status: 404 }),
    });

    await expect(runOnFailureActions({
      onFailure: [
        { type: 'webhook', url: `http://localhost:${server.port}/gone` },
        { type: 'prompt', prompt: 'after the bad webhook' },
      ],
      workspaceRootPath: '/tmp',
      context: baseContext,
      runPrompt: async (action) => { seen.push(action.prompt); },
    })).resolves.toBeUndefined();

    expect(seen).toEqual(['after the bad webhook']);
  });
});
