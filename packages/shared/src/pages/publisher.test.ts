import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPagesSharingEnabled } from '../feature-flags.ts';
import { isPagesEnabled } from './capability.ts';
import { createPage, loadPageConfig, setPageShareState } from './storage.ts';
import {
  deletePageWithUnpublish,
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
    expect(resolveStoredPagesShareApiBaseUrl('http://localhost:8787/p/publication-1')).toBeUndefined();
    expect(resolveStoredPagesShareApiBaseUrl('http://localhost:8787/p/publication-1', 'http://localhost:8787/api')).toBe('http://localhost:8787/api');
    expect(resolveStoredPagesShareApiBaseUrl('http://127.0.0.1:8787/p/publication-1', 'http://localhost:8787/api')).toBeUndefined();
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

  test('uses the exact active localhost origin through create, update, and unpublish', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'http://localhost:8787/api';
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-localhost-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Local copy', content: '<p>local</p>' });
    const requests: string[] = [];
    const publisher = new PagePublisher({
      tokenStore: { get: async () => 'local-token', set: async () => {}, delete: async () => true },
      fetchFn: (async (url: string | URL, init?: RequestInit) => {
        requests.push(`${init?.method} ${String(url)}`);
        if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'local-1', url: 'http://localhost:8787/p/local-1', revision: 'r1', adminToken: 'local-token', passwordProtected: false, status: 'published', updatedAt: Date.now() }), { status: 201, headers: { 'content-type': 'application/json' } });
        if (init?.method === 'PUT') return new Response(JSON.stringify({ id: 'local-1', url: 'http://localhost:8787/p/local-1', revision: 'r2', passwordProtected: false, status: 'published', updatedAt: Date.now() }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('', { status: 204 });
      }) as unknown as typeof fetch,
    });
    try {
      await publisher.publish(workspace, 'workspace', page.slug, { includeData: false });
      await publisher.publish(workspace, 'workspace', page.slug, { includeData: false });
      await publisher.unpublish(workspace, 'workspace', page.slug);
      expect(requests).toEqual([
        'POST http://localhost:8787/api/publications',
        'PUT http://localhost:8787/api/publications/local-1',
        'DELETE http://localhost:8787/api/publications/local-1',
      ]);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
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

  test('keeps the share pointer when a missing vault token prevents any remote revocation attempt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pages-publisher-token-missing-'));
    const page = createPage(workspace, { name: 'Missing token', content: '<p>keep me</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1', url: 'https://pages.vorno.ai/p/publication-1', publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: Date.now(), updatedAt: Date.now(), passwordProtected: false,
    });
    const publisher = new PagePublisher({
      tokenStore: { get: async () => null, set: async () => {}, delete: async () => false },
      fetchFn: (async () => { throw new Error('must not fetch without token'); }) as unknown as typeof fetch,
    });
    try {
      expect((await publisher.unpublish(workspace, 'workspace', page.slug)).warning).toBe('remote-copy-may-remain');
      expect(loadPageConfig(workspace, page.slug)?.share?.publicationId).toBe('publication-1');
      const recovery = await publisher.describeLocalPublicationRecovery(workspace, 'workspace', page.slug);
      expect(recovery).toEqual({ publicationId: 'publication-1', reason: 'token-missing' });
      await publisher.forgetLocalPublication(workspace, 'workspace', page.slug, recovery.publicationId);
      expect(loadPageConfig(workspace, page.slug)?.share).toBeUndefined();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test('offers local recovery only for a retained publication that cannot be revoked remotely', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    delete process.env.CRAFT_PAGES_SHARE_API_URL;
    const workspace = mkdtempSync(join(tmpdir(), 'pages-forget-eligibility-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Eligibility', content: '<p>eligible</p>' });
    const share = {
      publicationId: 'publication-1', publishedRevision: 'r1', publishedContentDigest: page.contentDigest!,
      includesData: false, publishedAt: 1, updatedAt: 1, passwordProtected: false,
    };
    const build = (token: string | null) => new PagePublisher({
      tokenStore: { get: async () => token, set: async () => {}, delete: async () => true },
      fetchFn: (async () => { throw new Error('eligibility must not reach the network'); }) as unknown as typeof fetch,
    });
    try {
      // Nothing published: there is no local publication state to forget, so the
      // caller is refused before it can ask a human anything.
      await expect(build(null).describeLocalPublicationRecovery(workspace, 'workspace', page.slug))
        .rejects.toMatchObject({ code: 'PAGE_SHARE_NOT_PUBLISHED' });

      // Published, token present, origin recognized — the ordinary path works,
      // and offering the destructive local one here would strand a live copy.
      setPageShareState(workspace, page.slug, { ...share, url: 'https://pages.vorno.ai/p/publication-1' });
      await expect(build('token').describeLocalPublicationRecovery(workspace, 'workspace', page.slug))
        .rejects.toMatchObject({ code: 'PAGE_SHARE_FORGET_NOT_ELIGIBLE' });

      // The two states recovery exists for.
      await expect(build(null).describeLocalPublicationRecovery(workspace, 'workspace', page.slug))
        .resolves.toEqual({ publicationId: 'publication-1', reason: 'token-missing' });
      setPageShareState(workspace, page.slug, { ...share, url: 'http://localhost:8787/p/publication-1' });
      await expect(build('token').describeLocalPublicationRecovery(workspace, 'workspace', page.slug))
        .resolves.toEqual({ publicationId: 'publication-1', reason: 'origin-unusable' });
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test('refuses a stale forget approval so a republished publication keeps its token and pointer', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://pages.vorno.ai/api';
    const workspace = mkdtempSync(join(tmpdir(), 'pages-forget-stale-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Stale forget', content: '<p>stale</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1', url: 'https://pages.vorno.ai/p/publication-1', publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: 1, updatedAt: 1, passwordProtected: false,
    });
    // The vault is unreadable when the user asks to forget and readable again by
    // the time they answer — a keychain that unlocked, which is exactly when the
    // ordinary path starts working underneath an open confirmation.
    let token: string | null = null;
    // Read through a function so the assertion sees the declared type: the
    // writes happen inside the store's closures, which control-flow analysis
    // cannot follow, and it narrows `token` to `null` without one.
    const vaultToken = (): string | null => token;
    const deletes: Array<string | null> = [];
    const publisher = new PagePublisher({
      tokenStore: {
        get: async () => token,
        set: async (_workspaceId, _pageId, value) => { token = value; },
        delete: async () => { deletes.push(token); token = null; return true; },
      },
      fetchFn: (async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 'publication-2', url: 'https://pages.vorno.ai/p/publication-2', revision: 'r1',
            adminToken: 'token-2', passwordProtected: false, status: 'published', updatedAt: 2,
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response('', { status: 204 });
      }) as unknown as typeof fetch,
    });
    try {
      const approved = await publisher.describeLocalPublicationRecovery(workspace, 'workspace', page.slug);
      expect(approved.publicationId).toBe('publication-1');

      // While the confirmation is open: the token comes back, the old copy is
      // revoked for real, and the page is published again under a new identity.
      token = 'restored-token';
      await publisher.unpublish(workspace, 'workspace', page.slug);
      await publisher.publish(workspace, 'workspace', page.slug, { includeData: false });
      expect(loadPageConfig(workspace, page.slug)?.share?.publicationId).toBe('publication-2');

      await expect(publisher.forgetLocalPublication(workspace, 'workspace', page.slug, approved.publicationId))
        .rejects.toMatchObject({ code: 'PAGE_SHARE_FORGET_STALE' });
      // The new publication survives intact: the stale approval took neither the
      // token that manages it nor the pointer that finds it.
      expect(loadPageConfig(workspace, page.slug)?.share?.publicationId).toBe('publication-2');
      expect(vaultToken()).toBe('token-2');
      expect(deletes).toEqual(['restored-token']);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test('refuses a forget whose publication became revocable again while the confirmation was open', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://pages.vorno.ai/api';
    const workspace = mkdtempSync(join(tmpdir(), 'pages-forget-recovered-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Recovered capability', content: '<p>recovered</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1', url: 'https://pages.vorno.ai/p/publication-1', publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: 1, updatedAt: 1, passwordProtected: false,
    });
    let token: string | null = null;
    const vaultToken = (): string | null => token;
    let deletes = 0;
    const publisher = new PagePublisher({
      tokenStore: {
        get: async () => token,
        set: async () => {},
        delete: async () => { deletes++; token = null; return true; },
      },
      fetchFn: (async () => { throw new Error('local recovery must not reach the network'); }) as unknown as typeof fetch,
    });
    try {
      const approved = await publisher.describeLocalPublicationRecovery(workspace, 'workspace', page.slug);
      expect(approved).toEqual({ publicationId: 'publication-1', reason: 'token-missing' });

      // Same publication, but the keychain unlocked while the sheet was up, so
      // the ordinary revocation path works again.
      token = 'recovered-token';

      await expect(publisher.forgetLocalPublication(workspace, 'workspace', page.slug, approved.publicationId))
        .rejects.toMatchObject({ code: 'PAGE_SHARE_FORGET_NOT_ELIGIBLE' });
      // Nothing was destroyed, so the copy is still revocable for real.
      expect(vaultToken()).toBe('recovered-token');
      expect(deletes).toBe(0);
      expect(loadPageConfig(workspace, page.slug)?.share?.publicationId).toBe('publication-1');
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test('serializes lifecycle operations per page so a publish cannot land inside a forget', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://pages.vorno.ai/api';
    const workspace = mkdtempSync(join(tmpdir(), 'pages-forget-lock-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Lock', content: '<p>lock</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1', url: 'https://pages.vorno.ai/p/publication-1', publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: 1, updatedAt: 1, passwordProtected: false,
    });
    let token: string | null = null;
    const vaultToken = (): string | null => token;
    let releaseDelete!: () => void;
    const deleteParked = new Promise<void>(resolve => { releaseDelete = resolve; });
    let deleteStarted = false;
    const requests: string[] = [];
    const publisher = new PagePublisher({
      tokenStore: {
        get: async () => token,
        set: async (_workspaceId, _pageId, value) => { token = value; },
        // A vault write is I/O and can be slow. Parking here is what an
        // unserialized publish would have interleaved with.
        delete: async () => { deleteStarted = true; await deleteParked; token = null; return true; },
      },
      fetchFn: (async (url: string | URL, init?: RequestInit) => {
        requests.push(`${init?.method} ${String(url)}`);
        return new Response(JSON.stringify({
          id: 'publication-2', url: 'https://pages.vorno.ai/p/publication-2', revision: 'r1',
          adminToken: 'token-2', passwordProtected: false, status: 'published', updatedAt: 2,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    try {
      const forget = publisher.forgetLocalPublication(workspace, 'workspace', page.slug, 'publication-1');
      const publish = publisher.publish(workspace, 'workspace', page.slug, { includeData: false });
      await new Promise(resolve => setTimeout(resolve, 5));

      expect(deleteStarted).toBe(true);
      // The publish is queued behind the forget rather than running through it,
      // so it cannot mint a token into a vault slot the forget is about to clear.
      expect(requests).toEqual([]);

      releaseDelete();
      await forget;
      await publish;
      expect(requests).toEqual(['POST https://pages.vorno.ai/api/publications']);
      expect(loadPageConfig(workspace, page.slug)?.share?.publicationId).toBe('publication-2');
      expect(vaultToken()).toBe('token-2');
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test('delete aborts and preserves page/share state when token is missing or Worker cleanup is pending', async () => {
    for (const scenario of ['missing', 'pending'] as const) {
      const workspace = mkdtempSync(join(tmpdir(), `pages-delete-${scenario}-`));
      const page = createPage(workspace, { name: `Delete ${scenario}`, content: '<p>keep</p>' });
      setPageShareState(workspace, page.slug, {
        publicationId: 'publication-1', url: 'https://pages.vorno.ai/p/publication-1', publishedRevision: 'r1',
        publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: Date.now(), updatedAt: Date.now(), passwordProtected: false,
      });
      const tokenStore = { get: async () => scenario === 'missing' ? null : 'token', set: async () => {}, delete: async () => false };
      const fetchFn = (async () => new Response(JSON.stringify({ cleanupPending: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      try {
        await expect(deletePageWithUnpublish(workspace, 'workspace', page.slug, { tokenStore, fetchFn })).rejects.toThrow(/Retry unpublish|Restore the token/);
        expect(loadPageConfig(workspace, page.slug)?.share?.publicationId).toBe('publication-1');
      } finally { rmSync(workspace, { recursive: true, force: true }); }
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
      expect((await publisher.unpublish(workspace, 'workspace', page.slug)).warning).toBe('remote-cleanup-pending');
      // loadPageConfig validates a fresh disk reload, so this proves the retained
      // physical-cleanup capability survives persistence rather than being stripped.
      expect(loadPageConfig(workspace, page.slug)?.share?.cleanupPending).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('queues a publish behind a delete that is mid-revocation, so it finds no page instead of publishing', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://pages.vorno.ai/api';
    const workspace = mkdtempSync(join(tmpdir(), 'pages-delete-lock-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Delete lock', content: '<p>lock</p>' });
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1', url: 'https://pages.vorno.ai/p/publication-1', publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: 1, updatedAt: 1, passwordProtected: false,
    });
    const pageDir = join(workspace, 'pages', page.slug);

    let token: string | null = 'token-1';
    let releaseVaultDelete!: () => void;
    const vaultDeleteParked = new Promise<void>(resolve => { releaseVaultDelete = resolve; });
    const requests: string[] = [];
    // Parks AFTER the remote DELETE and AFTER the share pointer is cleared, which
    // is precisely the gap the old free function left the lock open across.
    const tokenStore = {
      get: async () => token,
      set: async (_workspaceId: string, _pageId: string, value: string) => { token = value; },
      delete: async () => { await vaultDeleteParked; token = null; return true; },
    };
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      requests.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          id: 'publication-2', url: 'https://pages.vorno.ai/p/publication-2', revision: 'r1',
          adminToken: 'token-2', passwordProtected: false, status: 'published', updatedAt: 2,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 204 });
    }) as unknown as typeof fetch;

    try {
      const deleting = deletePageWithUnpublish(workspace, 'workspace', page.slug, { tokenStore, fetchFn });
      await new Promise(resolve => setTimeout(resolve, 5));
      // Mid-operation: the remote copy is revoked, the folder is still there.
      expect(requests).toEqual(['DELETE https://pages.vorno.ai/api/publications/publication-1']);
      expect(existsSync(pageDir)).toBe(true);

      // A publish arriving now is the whole bug. It must not run until the delete
      // has finished, or it mints a live copy the delete then orphans.
      const republish = new PagePublisher({ tokenStore, fetchFn })
        .publish(workspace, 'workspace', page.slug, { includeData: false })
        .then(() => 'published', (error: unknown) => String(error));
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(requests).toHaveLength(1);
      expect(existsSync(pageDir)).toBe(true);

      releaseVaultDelete();
      await expect(deleting).resolves.toEqual({ publicCopyMayRemain: false });
      expect(existsSync(pageDir)).toBe(false);

      // The queued publish ran after the delete and found no page, so it never
      // reached the network: no remote publication outlives the local one.
      expect(await republish).toContain('PAGE_NOT_FOUND');
      expect(requests).toEqual(['DELETE https://pages.vorno.ai/api/publications/publication-1']);
      expect(token).toBeNull();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test('a delete arriving while a publish is in flight waits, then revokes what that publish created', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://pages.vorno.ai/api';
    const workspace = mkdtempSync(join(tmpdir(), 'pages-delete-inflight-'));
    enablePages(workspace);
    // Deliberately NOT shared yet. This is what made the old split-lock version
    // unsafe: it read "was this shared?" from disk with no lock held, saw no
    // pointer because the in-flight publish had not written one, skipped
    // unpublish entirely, and removed the folder — leaving the publication the
    // POST was about to create live, with its token in the vault and nothing
    // local pointing at either.
    const page = createPage(workspace, { name: 'In flight', content: '<p>inflight</p>' });
    const pageDir = join(workspace, 'pages', page.slug);

    let token: string | null = null;
    const vaultToken = (): string | null => token;
    let releasePost!: () => void;
    const postParked = new Promise<void>(resolve => { releasePost = resolve; });
    const requests: string[] = [];
    const tokenStore = {
      get: async () => token,
      set: async (_workspaceId: string, _pageId: string, value: string) => { token = value; },
      delete: async () => { token = null; return true; },
    };
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      requests.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'POST') {
        // A create is a network round trip, so this window is latency-wide, not
        // a scheduling artifact.
        await postParked;
        return new Response(JSON.stringify({
          id: 'publication-2', url: 'https://pages.vorno.ai/p/publication-2', revision: 'r1',
          adminToken: 'token-2', passwordProtected: false, status: 'published', updatedAt: 2,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 204 });
    }) as unknown as typeof fetch;

    try {
      const publishing = new PagePublisher({ tokenStore, fetchFn })
        .publish(workspace, 'workspace', page.slug, { includeData: false });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(requests).toEqual(['POST https://pages.vorno.ai/api/publications']);

      const deleting = deletePageWithUnpublish(workspace, 'workspace', page.slug, { tokenStore, fetchFn });
      await new Promise(resolve => setTimeout(resolve, 10));
      // The folder must still be here: removing it now is what orphans the copy.
      expect(existsSync(pageDir)).toBe(true);

      releasePost();
      await publishing;
      await expect(deleting).resolves.toEqual({ publicCopyMayRemain: false });

      // The delete read the share pointer INSIDE the lock, so it saw the
      // publication that had just been created and revoked it before removing
      // the folder. No remote copy outlives the local page.
      expect(requests).toEqual([
        'POST https://pages.vorno.ai/api/publications',
        'DELETE https://pages.vorno.ai/api/publications/publication-2',
      ]);
      expect(existsSync(pageDir)).toBe(false);
      expect(vaultToken()).toBeNull();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test('refuses to delete the local page while a share pointer is still recorded', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pages-delete-pointer-'));
    enablePages(workspace);
    const page = createPage(workspace, { name: 'Pointer guard', content: '<p>guard</p>' });
    const pageDir = join(workspace, 'pages', page.slug);
    setPageShareState(workspace, page.slug, {
      publicationId: 'publication-1', url: 'https://pages.vorno.ai/p/publication-1', publishedRevision: 'r1',
      publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: 1, updatedAt: 1, passwordProtected: false,
    });
    try {
      // A 204 with the pointer left in place: the unpublish reported success but
      // local state still names a public copy, so the folder must survive.
      await expect(deletePageWithUnpublish(workspace, 'workspace', page.slug, {
        tokenStore: {
          get: async () => 'token',
          set: async () => {},
          // Re-record the pointer the unpublish just cleared, standing in for
          // anything that could reintroduce one before the folder is removed.
          delete: async () => {
            setPageShareState(workspace, page.slug, {
              publicationId: 'publication-2', url: 'https://pages.vorno.ai/p/publication-2', publishedRevision: 'r1',
              publishedContentDigest: page.contentDigest!, includesData: false, publishedAt: 2, updatedAt: 2, passwordProtected: false,
            });
            return true;
          },
        },
        fetchFn: (async () => new Response('', { status: 204 })) as unknown as typeof fetch,
      })).rejects.toThrow('retry unpublish before deleting the local page');
      expect(existsSync(pageDir)).toBe(true);
      expect(loadPageConfig(workspace, page.slug)?.share?.publicationId).toBe('publication-2');
    } finally { rmSync(workspace, { recursive: true, force: true }); }
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
