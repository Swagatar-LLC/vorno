import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPagesEnabled, isPagesSharingEnabled } from '../feature-flags.ts';
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

describe('Pages sharing default gate', () => {
  test('is disabled and has no implicit publication endpoint', () => {
    delete process.env.CRAFT_FEATURE_PAGES;
    delete process.env.CRAFT_FEATURE_PAGES_SHARING;
    delete process.env.CRAFT_PAGES_SHARE_API_URL;
    expect(isPagesEnabled()).toBe(false);
    expect(isPagesSharingEnabled()).toBe(false);
    expect(resolvePagesShareApiBaseUrl()).toBeUndefined();
    expect(isPagesSharingAvailable()).toBe(false);
  });

  test('refuses a Craft endpoint override before any request can be sent', async () => {
    process.env.CRAFT_FEATURE_PAGES = '1';
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://thecraftagents.com/p/api';
    const fetchFn = (() => {
      throw new Error('publish must not send to Craft');
    }) as unknown as typeof fetch;
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-craft-'));
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

  test('derives a cleanup API from a stored HTTPS share URL without the fresh-publish allowlist', () => {
    expect(resolveStoredPagesShareApiBaseUrl('https://legacy.example/p/publication-1')).toBe('https://legacy.example/api');
    expect(resolveStoredPagesShareApiBaseUrl('http://localhost/p/publication-1')).toBeUndefined();
  });

  test('existing updates and unpublish target the stored HTTPS origin when no publish endpoint is configured', async () => {
    process.env.CRAFT_FEATURE_PAGES = '1';
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    delete process.env.CRAFT_PAGES_SHARE_API_URL;
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-cleanup-'));
    const page = createPage(workspace, { name: 'Legacy copy', content: '<p>legacy</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1',
      url: 'https://legacy.example/p/publication-1',
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
            url: 'https://legacy.example/p/publication-1',
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
        'PUT https://legacy.example/api/publications/publication-1',
        'DELETE https://legacy.example/api/publications/publication-1',
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
