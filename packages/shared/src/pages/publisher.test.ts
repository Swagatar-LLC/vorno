import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPagesSharingEnabled } from '../feature-flags.ts';
import { isPagesEnabled } from './capability.ts';
import { createPage, setPageShareState } from './storage.ts';
import {
  PagePublisher,
  isPagesSharingAvailable,
  resolvePagesShareApiBaseUrl,
  resolveStoredPagesShareApiBaseUrl,
} from './publisher.ts';

const originalSharing = process.env.CRAFT_FEATURE_PAGES_SHARING;
const originalApi = process.env.CRAFT_PAGES_SHARE_API_URL;

afterEach(() => {
  if (originalSharing === undefined) delete process.env.CRAFT_FEATURE_PAGES_SHARING;
  else process.env.CRAFT_FEATURE_PAGES_SHARING = originalSharing;
  if (originalApi === undefined) delete process.env.CRAFT_PAGES_SHARE_API_URL;
  else process.env.CRAFT_PAGES_SHARE_API_URL = originalApi;
});

function enablePages(workspace: string): void {
  writeFileSync(join(workspace, 'config.json'), JSON.stringify({ id: 'workspace', name: 'Workspace', slug: 'workspace', defaults: { pages: { enabled: true } }, createdAt: 1, updatedAt: 1 }));
}

describe('Pages sharing default gate', () => {
  test('is disabled and has no implicit publication endpoint', () => {
    delete process.env.CRAFT_FEATURE_PAGES_SHARING;
    delete process.env.CRAFT_PAGES_SHARE_API_URL;
    expect(isPagesEnabled(undefined)).toBe(false);
    expect(isPagesSharingEnabled()).toBe(false);
    expect(resolvePagesShareApiBaseUrl()).toBeUndefined();
    expect(isPagesSharingAvailable(undefined)).toBe(false);
  });

  test('refuses a Craft endpoint override before any request can be sent', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://thecraftagents.com/p/api';
    const fetchFn = (() => {
      throw new Error('publish must not send to Craft');
    }) as unknown as typeof fetch;
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-craft-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Blocked', content: '<p>blocked</p>' });
    const publisher = new PagePublisher({
      tokenStore: { get: async () => null, set: async () => {}, delete: async () => false },
      fetchFn,
    });
    try {
      expect(resolvePagesShareApiBaseUrl()).toBeUndefined();
      await expect(publisher.publish(workspace, 'workspace', page.slug, { includeData: false }))
        .rejects.toMatchObject({ code: 'PAGE_SHARING_DISABLED' });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('derives cleanup APIs only from recognized legacy and Vorno public URL shapes', () => {
    expect(resolveStoredPagesShareApiBaseUrl('https://thecraftagents.com/p/publication-1')).toBe('https://thecraftagents.com/p/api');
    expect(resolveStoredPagesShareApiBaseUrl('https://pages.vorno.ai/p/publication-1')).toBe('https://pages.vorno.ai/api');
    for (const hostile of [
      'https://evil.example/p/publication-1',
      'https://pages.vorno.ai:444/p/publication-1',
      'https://user@pages.vorno.ai/p/publication-1',
      'https://pages.vorno.ai/p/publication-1?redirect=https://evil.example',
      'https://pages.vorno.ai/not-public/publication-1',
    ]) expect(resolveStoredPagesShareApiBaseUrl(hostile)).toBeUndefined();
  });

  test('accepts only exact production and bounded local fresh-publication API forms', () => {
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://pages.vorno.ai/api/';
    expect(resolvePagesShareApiBaseUrl()).toBe('https://pages.vorno.ai/api');
    process.env.CRAFT_PAGES_SHARE_API_URL = 'http://localhost:8787/api';
    expect(resolvePagesShareApiBaseUrl()).toBe('http://localhost:8787/api');
    for (const invalid of [
      'https://pages.vorno.ai:444/api', 'https://pages.vorno.ai/other',
      'https://user@pages.vorno.ai/api', 'https://pages.vorno.ai/api?x=1',
      'http://localhost/api', 'http://localhost:8787/other',
    ]) {
      process.env.CRAFT_PAGES_SHARE_API_URL = invalid;
      expect(resolvePagesShareApiBaseUrl()).toBeUndefined();
    }
  });

  test('existing updates and unpublish target the stored HTTPS origin when no publish endpoint is configured', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    delete process.env.CRAFT_PAGES_SHARE_API_URL;
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-cleanup-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Legacy copy', content: '<p>legacy</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1',
      url: 'https://thecraftagents.com/p/publication-1',
      publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!,
      includesData: false,
      publishedAt: Date.now(),
      updatedAt: Date.now(),
      passwordProtected: false,
    });
    const requests: string[] = [];
    const publisher = new PagePublisher({
      tokenStore: { get: async () => 'token', set: async () => {}, delete: async () => true },
      fetchFn: (async (url: string | URL, init?: RequestInit) => {
        requests.push(`${init?.method} ${String(url)}`);
        if (init?.method === 'PUT') {
          return new Response(JSON.stringify({
            id: 'publication-1',
            url: 'https://thecraftagents.com/p/publication-1',
            revision: 'r2',
            passwordProtected: true,
            status: 'published',
            updatedAt: Date.now(),
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('', { status: 204 });
      }) as typeof fetch,
    });
    try {
      await publisher.setPassword(workspace, 'workspace', page.slug, 'password');
      await publisher.unpublish(workspace, 'workspace', page.slug);
      expect(requests).toEqual([
        'PUT https://thecraftagents.com/p/api/publications/publication-1',
        'DELETE https://thecraftagents.com/p/api/publications/publication-1',
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('surfaces a physical-cleanup warning after the Worker has logically revoked the publication', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-cleanup-warning-'));
    const page = createPage(workspace, { name: 'Cleanup warning', content: '<p>warning</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1',
      url: 'https://pages.vorno.ai/p/publication-1',
      publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!,
      includesData: false,
      publishedAt: Date.now(),
      updatedAt: Date.now(),
      passwordProtected: false,
    });
    const publisher = new PagePublisher({
      tokenStore: { get: async () => 'token', set: async () => {}, delete: async () => true },
      fetchFn: (async () => new Response(JSON.stringify({ cleanupPending: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    });
    try {
      expect((await publisher.unpublish(workspace, 'workspace', page.slug)).warning).toBe('remote-copy-may-remain');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('rejects a hostile edited stored URL before fetch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-hostile-'));
    const page = createPage(workspace, { name: 'Hostile copy', content: '<p>hostile</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1',
      url: 'https://evil.example/p/publication-1',
      publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!,
      includesData: false,
      publishedAt: Date.now(),
      updatedAt: Date.now(),
      passwordProtected: false,
    });
    let fetchCalled = false;
    const publisher = new PagePublisher({
      tokenStore: { get: async () => 'token', set: async () => {}, delete: async () => true },
      fetchFn: (async () => { fetchCalled = true; return new Response('', { status: 204 }); }) as unknown as typeof fetch,
    });
    try {
      await expect(publisher.unpublish(workspace, 'workspace', page.slug))
        .rejects.toMatchObject({ code: 'PAGE_SHARE_REMOTE_ERROR' });
      expect(fetchCalled).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
