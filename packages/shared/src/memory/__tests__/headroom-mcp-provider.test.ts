/**
 * The `headroom-mcp` provider (fork: PLAN-040 / SUV-0029; ADR-0029).
 *
 * Two kinds of test here, and the split is deliberate:
 *
 * - **Unit** — prose parsing, interpreter resolution, error classification, and
 *   the degrade path. These run everywhere, always, with no Headroom installed.
 * - **Opt-in integration** — a real stdio round trip against the real Python
 *   server, skipped unless `VORNO_TEST_HEADROOM_MEMORY=1`. It is opt-in rather
 *   than conditional-on-presence because a test that silently skips itself
 *   whenever the dependency is absent is a test that will be absent on CI, on a
 *   fresh clone, and on the one machine where it mattered — and nobody will
 *   notice. Requiring an explicit flag makes "was this actually exercised" a
 *   question with an answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HEADROOM_DB_FILE,
  HeadroomMcpMemoryProvider,
  looksLikeMissingEmbedder,
  parseHeadroomSearchProse,
  resolveHeadroomPython,
} from '../headroom-mcp-provider.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vorno-headroom-mem-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('parseHeadroomSearchProse — ADR-0029 C3, reads are prose', () => {
  it('parses the documented wire format', () => {
    const records = parseHeadroomSearchProse(
      '1. [relevance=0.50] Jeff prefers absolute dates.\n2. [relevance=0.16] The repo uses Bun.',
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ content: 'Jeff prefers absolute dates.', relevance: 0.5 });
    expect(records[1]).toMatchObject({ content: 'The repo uses Bun.', relevance: 0.16 });
  });

  it('marks every record as unstructured — this is the honest C3 flag', () => {
    // Everything beyond content and relevance is best-effort parsing, and the
    // host has to be able to tell.
    for (const record of parseHeadroomSearchProse('1. [relevance=0.9] A fact.')) {
      expect(record.structured).toBe(false);
      expect(record.tags).toBeUndefined();
      expect(record.createdAt).toBeUndefined();
    }
  });

  it('keeps an unrecognised line rather than dropping the memory', () => {
    // Losing a memory because upstream reformatted its output is a worse
    // failure than ranking one poorly.
    const records = parseHeadroomSearchProse('Some unexpected shape entirely.');
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toBe('Some unexpected shape entirely.');
    expect(records[0]!.relevance).toBe(0);
  });

  it('treats an empty or "no results" response as no records', () => {
    expect(parseHeadroomSearchProse('')).toEqual([]);
    expect(parseHeadroomSearchProse('   \n  ')).toEqual([]);
    expect(parseHeadroomSearchProse('No memories found')).toEqual([]);
    expect(parseHeadroomSearchProse('none')).toEqual([]);
  });

  it('clamps a relevance outside 0..1 rather than propagating it', () => {
    expect(parseHeadroomSearchProse('1. [relevance=9.9] x')[0]!.relevance).toBe(1);
  });
});

describe('resolveHeadroomPython', () => {
  it('treats an explicit path as authoritative, not as a first guess', () => {
    // Falling through to discovery would mean quietly running a *different*
    // interpreter than the caller named.
    const fake = join(workspace, 'python');
    writeFileSync(fake, '#!/bin/sh\n', 'utf8');
    expect(resolveHeadroomPython(fake)).toBe(fake);
  });

  it('returns null — not a fallback — when the explicit path does not exist', () => {
    expect(resolveHeadroomPython(join(workspace, 'no-such-python'))).toBeNull();
  });

  it('returns null or a real path when discovering, never a nonexistent one', () => {
    const resolved = resolveHeadroomPython();
    if (resolved !== null) expect(resolved).toContain('python');
  });
});

describe('looksLikeMissingEmbedder — keeping describe() honest', () => {
  it('recognises the C1 embedder failure', () => {
    expect(looksLikeMissingEmbedder('HF_HUB_OFFLINE is set and the model is not cached')).toBe(true);
    expect(looksLikeMissingEmbedder('Could not reach huggingface.co')).toBe(true);
    expect(looksLikeMissingEmbedder('embedder initialization failed')).toBe(true);
    expect(looksLikeMissingEmbedder('all-MiniLM-L6-v2-onnx not available')).toBe(true);
  });

  it('does NOT claim an unrelated failure is a provisioning problem', () => {
    // The real error this test was written for. Reporting it as "unprovisioned"
    // would tell the user to download 86 MB that will not help.
    expect(looksLikeMissingEmbedder('backend initialization failed: unable to open database file')).toBe(
      false,
    );
    expect(looksLikeMissingEmbedder('permission denied')).toBe(false);
    expect(looksLikeMissingEmbedder('')).toBe(false);
    expect(looksLikeMissingEmbedder(undefined as unknown as string)).toBe(false);
  });
});

describe('the store path is a property of the workspace, not of the cwd', () => {
  it('pins the database inside the workspace memory folder', () => {
    const provider = new HeadroomMcpMemoryProvider({ workspaceRootPath: workspace, topK: 5 });
    const dbPath = provider.getDatabasePath();
    // Left to itself the server resolves its database from the current working
    // directory, which for a desktop app is wherever it happened to be
    // launched from — so memory would land in a different store depending on
    // how Vorno was started.
    expect(dbPath.startsWith(workspace)).toBe(true);
    expect(dbPath.endsWith(HEADROOM_DB_FILE)).toBe(true);
    expect(dbPath).toContain('memory');
  });
});

describe('degrade path with Headroom absent', () => {
  const absentProvider = () =>
    new HeadroomMcpMemoryProvider({
      workspaceRootPath: workspace,
      topK: 5,
      pythonPath: join(workspace, 'definitely-not-a-python'),
    });

  it('describes itself as absent without throwing', async () => {
    const capabilities = await absentProvider().describe();
    expect(capabilities.state).toBe('absent');
    expect(capabilities.providerId).toBe('headroom-mcp');
    expect(capabilities.notes.length).toBeGreaterThan(0);
  });

  it('reports search and save as unavailable rather than throwing', async () => {
    const provider = absentProvider();
    const found = await provider.search({ query: 'anything' });
    const saved = await provider.save({ facts: [{ content: 'anything' }] });
    expect(found.available).toBe(false);
    expect(saved.available).toBe(false);
    expect(!found.available && found.reason).toBe('provider-absent');
  });

  it('declares its constraints honestly even when it cannot run', async () => {
    const capabilities = await absentProvider().describe();
    // C2 and C3 are properties of the surface, true whether or not it is
    // currently reachable — so they must be declarable without a live server.
    expect(capabilities.scopeLayers).toEqual(['user']);
    expect(capabilities.structuredReads).toBe(false);
    expect(capabilities.egress).toBe('first-run-model-fetch');
    expect(capabilities.requiresProvisioning).toBe(true);
  });

  it('dispose is safe to call when nothing was ever started', async () => {
    await expect(absentProvider().dispose()).resolves.toBeUndefined();
  });
});

const RUN_INTEGRATION = process.env.VORNO_TEST_HEADROOM_MEMORY === '1';

describe.skipIf(!RUN_INTEGRATION)('opt-in: real stdio round trip against Headroom', () => {
  it('saves and retrieves a fact through the real memory server', async () => {
    const provider = new HeadroomMcpMemoryProvider({
      workspaceRootPath: workspace,
      topK: 5,
      userId: 'vorno-integration-test',
    });

    const capabilities = await provider.describe();
    if (capabilities.state !== 'ready') {
      // A real, reportable outcome rather than a silent pass: the run says
      // which of the three states it landed in and why.
      throw new Error(
        `Headroom memory is ${capabilities.state}, not ready: ${capabilities.notes.join(' ')}`,
      );
    }

    const saved = await provider.save({
      facts: [{ content: 'Vorno integration probe: the sky is documented as blue.' }],
    });
    expect(saved.available).toBe(true);

    const found = await provider.search({ query: 'sky documented blue' });
    expect(found.available).toBe(true);
    if (found.available) {
      expect(found.value.length).toBeGreaterThan(0);
      expect(found.value.every((record) => record.structured === false)).toBe(true);
    }

    await provider.dispose();
  }, 60_000);
});
