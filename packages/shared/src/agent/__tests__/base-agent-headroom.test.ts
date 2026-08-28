/**
 * Resolved config drives the Headroom boundary at session construction
 * (fork: PLAN-040 / SUV-0018).
 *
 * These tests run the *real* path end to end: a workspace `config.json` on
 * disk → `loadEffectiveHeadroomConfig()` → the boundary factory → the adapter a
 * constructed agent holds. Nothing about the resolution is mocked; only the SDK
 * loader is injected, through the seam SUV-0015 provided for exactly this.
 *
 * The instance layer is left unset: the shared suite's `bunfig.toml` preload
 * points `CRAFT_CONFIG_DIR` at a fresh temp dir (LEARNING-056), so the
 * instance-level `headroom` key is absent and the workspace layer is the only
 * thing steering the outcome — which is the claim under test.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HeadroomConfigOverrides } from '@craft-agent/core/types';
import type {
  HeadroomSdkClient,
  HeadroomSdkClientOptions,
  HeadroomSdkModule,
} from '../../headroom/sdk-adapter.ts';
import { TestAgent, createMockBackendConfig, createMockWorkspace } from './test-utils.ts';

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

/** Create a workspace root whose `config.json` carries the given override layer. */
function makeWorkspace(headroom: HeadroomConfigOverrides | undefined): string {
  const rootPath = mkdtempSync(join(tmpdir(), 'suv0018-ws-'));
  tempDirs.push(rootPath);
  writeWorkspaceHeadroom(rootPath, headroom);
  return rootPath;
}

/** Rewrite an existing workspace's stored Headroom layer — i.e. flip the toggle. */
function writeWorkspaceHeadroom(
  rootPath: string,
  headroom: HeadroomConfigOverrides | undefined,
): void {
  writeFileSync(
    join(rootPath, 'config.json'),
    JSON.stringify(
      {
        id: 'ws_suv0018',
        name: 'SUV-0018 Workspace',
        slug: 'suv0018',
        defaults: headroom === undefined ? {} : { headroom },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

interface SdkRecorder {
  /** Options each fake `HeadroomClient` was constructed with. */
  clientOptions: HeadroomSdkClientOptions[];
  /** The `model` each `compress` call carried, in order. */
  compressModels: Array<string | undefined>;
}

/**
 * A stand-in SDK module that records what the boundary hands it.
 *
 * The interesting assertion is not "an SDK-backed adapter exists" but "it was
 * built from *this workspace's* values", and the constructed options are the
 * only place that is observable from outside the boundary.
 */
function recordingSdk(recorder: SdkRecorder): HeadroomSdkModule {
  return {
    HeadroomClient: class implements HeadroomSdkClient {
      constructor(options?: HeadroomSdkClientOptions) {
        recorder.clientOptions.push(options ?? {});
      }
      async compress(
        _messages: unknown[],
        options?: { model?: string; tokenBudget?: number },
      ): Promise<unknown> {
        recorder.compressModels.push(options?.model);
        // `compressed: false` makes the adapter pass the input through — this
        // test is about wiring, not about the round-trip (SUV-0015 covers that).
        return { compressed: false };
      }
      async retrieve(): Promise<unknown> {
        return null;
      }
      async getStats(): Promise<unknown> {
        return null;
      }
    },
  };
}

function emptyRecorder(): SdkRecorder {
  return { clientOptions: [], compressModels: [] };
}

/**
 * A loader whose dynamic import genuinely fails to resolve — the situation a
 * build shipped without the optional SDK is in. Same idiom (and same reasoning)
 * as `headroom/__tests__/adapter-fallback.test.ts`.
 */
const ABSENT_PACKAGE = 'headroom-ai-not-installed-in-this-repo';
const loadAbsentSdk: () => Promise<HeadroomSdkModule> = () =>
  import(ABSENT_PACKAGE) as Promise<HeadroomSdkModule>;

describe('session construction wires resolved Headroom config (SUV-0018)', () => {
  it('gives sessions the no-op adapter when the workspace flag is off', async () => {
    const recorder = emptyRecorder();
    const rootPath = makeWorkspace({ enabled: false, verbosity: 'terse' });

    const agent = new TestAgent(
      createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath }),
        headroom: { loadSdk: async () => recordingSdk(recorder) },
      }),
    );

    const adapter = await agent.getHeadroomAdapter();
    expect(adapter.kind).toBe('noop');
    expect(await adapter.stats()).toEqual({ available: false, reason: 'disabled' });
    // Disabled must cost nothing: the SDK is never even loaded.
    expect(recorder.clientOptions).toHaveLength(0);
  });

  it('treats a workspace with no headroom key at all as off', async () => {
    const rootPath = makeWorkspace(undefined);

    const agent = new TestAgent(
      createMockBackendConfig({ workspace: createMockWorkspace({ rootPath }) }),
    );

    expect((await agent.getHeadroomAdapter()).kind).toBe('noop');
    expect(agent.getHeadroomConfig().enabled).toBe(false);
  });

  it('gives sessions the real adapter, built from the workspace values, when the flag is on', async () => {
    const recorder = emptyRecorder();
    const rootPath = makeWorkspace({
      enabled: true,
      compressionEngines: ['summarize', 'trim'],
      verbosity: 'terse',
      exposeStats: true,
    });

    const agent = new TestAgent(
      createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath }),
        model: 'claude-opus-5',
        headroom: { loadSdk: async () => recordingSdk(recorder) },
      }),
    );

    const adapter = await agent.getHeadroomAdapter();
    expect(adapter.kind).toBe('sdk');

    // Built exactly once, from the boundary's own client policy.
    expect(recorder.clientOptions).toHaveLength(1);
    expect(recorder.clientOptions[0]?.fallback).toBe(false);

    // The session's model reaches the adapter as its default — the one
    // session-scoped option value `HeadroomAdapterOptions` accepts today.
    await adapter.compress({ messages: [{ role: 'user', content: 'hello' }] });
    expect(recorder.compressModels).toEqual(['claude-opus-5']);

    // And the whole resolved config is what the session read, not defaults.
    expect(agent.getHeadroomConfig()).toEqual({
      enabled: true,
      compressionEngines: ['summarize', 'trim'],
      verbosity: 'terse',
      exposeStats: true,
    });
  });

  it('reads the config once at construction and returns a stable adapter', async () => {
    const recorder = emptyRecorder();
    const rootPath = makeWorkspace({ enabled: true });

    const agent = new TestAgent(
      createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath }),
        headroom: { loadSdk: async () => recordingSdk(recorder) },
      }),
    );

    const first = await agent.getHeadroomAdapter();
    const second = await agent.getHeadroomAdapter();

    expect(second).toBe(first);
    expect(recorder.clientOptions).toHaveLength(1);
  });
});

describe('a toggle change applies to the next session, not the current one (SUV-0018)', () => {
  it('leaves session A on its adapter and gives session B the new one', async () => {
    const recorder = emptyRecorder();
    const rootPath = makeWorkspace({ enabled: false });
    const deps = { loadSdk: async () => recordingSdk(recorder) };

    const sessionA = new TestAgent(
      createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath }),
        session: undefined,
        headroom: deps,
      }),
    );
    const adapterA = await sessionA.getHeadroomAdapter();
    expect(adapterA.kind).toBe('noop');

    // The user flips the workspace toggle on while session A is alive.
    writeWorkspaceHeadroom(rootPath, { enabled: true });

    const sessionB = new TestAgent(
      createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath }),
        session: undefined,
        headroom: deps,
      }),
    );

    expect((await sessionB.getHeadroomAdapter()).kind).toBe('sdk');

    // Session A is untouched — same instance, same kind, same reported reason.
    expect(await sessionA.getHeadroomAdapter()).toBe(adapterA);
    expect(adapterA.kind).toBe('noop');
    expect(await adapterA.stats()).toEqual({ available: false, reason: 'disabled' });
    expect(sessionA.getHeadroomConfig().enabled).toBe(false);
    expect(sessionB.getHeadroomConfig().enabled).toBe(true);
  });

  it('also carries a turn-off in the same direction', async () => {
    const recorder = emptyRecorder();
    const rootPath = makeWorkspace({ enabled: true });
    const deps = { loadSdk: async () => recordingSdk(recorder) };

    const sessionA = new TestAgent(
      createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath }),
        headroom: deps,
      }),
    );
    const adapterA = await sessionA.getHeadroomAdapter();
    expect(adapterA.kind).toBe('sdk');

    writeWorkspaceHeadroom(rootPath, { enabled: false });

    const sessionB = new TestAgent(
      createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath }),
        headroom: deps,
      }),
    );

    expect((await sessionB.getHeadroomAdapter()).kind).toBe('noop');
    expect(await sessionA.getHeadroomAdapter()).toBe(adapterA);
  });
});

describe('graceful degradation when the SDK is unavailable (SUV-0018)', () => {
  it('constructs the session anyway, on the no-op adapter, and logs a warning', async () => {
    // Prove the premise: the specifier really does fail to resolve.
    await expect(loadAbsentSdk()).rejects.toThrow();

    const rootPath = makeWorkspace({ enabled: true });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    let agent: TestAgent;
    try {
      agent = new TestAgent(
        createMockBackendConfig({
          workspace: createMockWorkspace({ rootPath }),
          headroom: { loadSdk: loadAbsentSdk },
        }),
      );
      // Construction itself must not throw, and the agent must be usable.
      const adapter = await agent.getHeadroomAdapter();

      expect(adapter.kind).toBe('noop');
      expect(await adapter.stats()).toEqual({
        available: false,
        reason: 'sdk-unavailable',
      });
      // Vorno stays fully functional: no method throws, messages pass through.
      const messages = [{ role: 'user' as const, content: 'still works' }];
      expect((await adapter.compress({ messages })).messages).toBe(messages);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((line) => line.toLowerCase().includes('headroom'))).toBe(true);
  });

  it('does not warn on the ordinary disabled path', async () => {
    const rootPath = makeWorkspace({ enabled: false });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const agent = new TestAgent(
        createMockBackendConfig({ workspace: createMockWorkspace({ rootPath }) }),
      );
      expect((await agent.getHeadroomAdapter()).kind).toBe('noop');
    } finally {
      console.warn = originalWarn;
    }

    // "Off" is not a degradation. Warning about it would train users to ignore
    // the message that actually matters.
    expect(warnings.filter((line) => line.toLowerCase().includes('headroom'))).toEqual(
      [],
    );
  });
});
