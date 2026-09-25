import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  CRAFT_SYSTEM_PROMPT_EXTENSION_NAME,
  createCraftResourceLoader,
  createSystemPromptOverride,
} from './system-prompt-override.ts';

/**
 * Regression contract for craft-agents-oss#648.
 *
 * Pi rebuilds its own system prompt on every `session.prompt()` and whenever the
 * tool loadout changes. The only supported way to replace the whole prompt is a
 * `before_agent_start` handler returning `{ systemPrompt }`, which the SDK applies
 * per run. These tests pin that the override registers exactly that handler,
 * stays silent until Craft sets a prompt, and always returns the latest prompt.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadInline(extension: InlineExtension): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  const factory = typeof extension === 'function' ? extension : extension.factory;
  void factory(pi);
  return handlers;
}

function invoke(handlers: Map<string, Handler[]>): unknown {
  const [handler, ...rest] = handlers.get('before_agent_start') ?? [];
  expect(handler).toBeDefined();
  expect(rest).toHaveLength(0);
  return handler!({ type: 'before_agent_start', prompt: 'hi', systemPrompt: 'SDK PROMPT' }, {});
}

describe('createSystemPromptOverride', () => {
  it('registers a single hidden before_agent_start handler under a stable inline name', () => {
    const override = createSystemPromptOverride();
    expect(override.extension).toMatchObject({ name: CRAFT_SYSTEM_PROMPT_EXTENSION_NAME, hidden: true });
    const handlers = loadInline(override.extension);
    expect([...handlers.keys()]).toEqual(['before_agent_start']);
  });

  it('leaves the SDK prompt alone until a prompt is set', () => {
    const override = createSystemPromptOverride();
    const handlers = loadInline(override.extension);
    expect(override.current()).toBeUndefined();
    expect(invoke(handlers)).toBeUndefined();
  });

  it('forces the exact Craft prompt once set, on every run', () => {
    const override = createSystemPromptOverride();
    const handlers = loadInline(override.extension);
    override.set('CRAFT_PROMPT');
    expect(invoke(handlers)).toEqual({ systemPrompt: 'CRAFT_PROMPT' });
    expect(invoke(handlers)).toEqual({ systemPrompt: 'CRAFT_PROMPT' });
    expect(override.current()).toBe('CRAFT_PROMPT');
  });

  it('a later set() replaces the forced prompt for the next run', () => {
    const override = createSystemPromptOverride();
    const handlers = loadInline(override.extension);
    override.set('FIRST');
    override.set('SECOND');
    expect(invoke(handlers)).toEqual({ systemPrompt: 'SECOND' });
  });
});

describe('createCraftResourceLoader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('loads the override as an inline extension through the SDK loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-pi-loader-'));
    dirs.push(root);
    const loader = await createCraftResourceLoader({
      cwd: root,
      agentDir: join(root, '.pi-agent'),
      settingsManager: SettingsManager.inMemory(),
      systemPromptOverride: createSystemPromptOverride(),
    });
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions.some(ext => ext.path === `<inline:${CRAFT_SYSTEM_PROMPT_EXTENSION_NAME}>`)).toBe(true);
  });
});

describe('session-level prompt delivery', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * End-to-end check that the forced prompt actually reaches the provider request —
   * the unit tests above only exercise the extension handler in isolation. Wires the
   * real loader into a real `AgentSession` (per the pattern in steering-sdk.test.ts)
   * and inspects the leading system message of the transcript each stream call
   * receives, across two turns, to pin the "always returns the latest prompt" claim.
   */
  it('projects the forced prompt onto the request across turns and a set() mid-run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-pi-session-'));
    dirs.push(root);
    const override = createSystemPromptOverride();
    const resourceLoader = await createCraftResourceLoader({
      cwd: root,
      agentDir: join(root, '.pi-agent'),
      settingsManager: SettingsManager.inMemory(),
      systemPromptOverride: override,
    });

    const model: Model<'openai-responses'> = {
      id: 'offline-system-prompt-test', name: 'Offline', api: 'openai-responses', provider: 'openai',
      baseUrl: 'https://invalid.test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
    };
    const { session } = await createAgentSession({
      cwd: root, model, settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(root), resourceLoader, tools: [],
      modelRuntime: {
        hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
        streamSimple: () => { throw new Error('Provider/network access is forbidden'); },
      } as unknown as ModelRuntime,
    });

    const leadingSystemPrompts: (string | undefined)[] = [];
    session.agent.streamFunction = (_model, context) => {
      const lead = context.messages.find(m => m.role === 'system');
      leadingSystemPrompts.push(typeof lead?.content === 'string' ? lead.content : undefined);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    };

    try {
      override.set('CRAFT_PROMPT_V1');
      await session.prompt('turn one');
      override.set('CRAFT_PROMPT_V2');
      await session.prompt('turn two');
    } finally {
      session.dispose();
    }

    expect(leadingSystemPrompts).toEqual(['CRAFT_PROMPT_V1', 'CRAFT_PROMPT_V2']);
  }, 5000);
});
