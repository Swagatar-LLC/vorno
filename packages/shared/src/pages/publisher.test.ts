import { afterEach, describe, expect, test } from 'bun:test';
import { isPagesSharingEnabled } from '../feature-flags.ts';
import { PagePublisher, resolvePagesShareApiBaseUrl } from './publisher.ts';

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
    delete process.env.CRAFT_FEATURE_PAGES_SHARING;
    delete process.env.CRAFT_PAGES_SHARE_API_URL;
    expect(isPagesSharingEnabled()).toBe(false);
    expect(resolvePagesShareApiBaseUrl()).toBeUndefined();
  });

  test('refuses a Craft endpoint override before any request can be sent', async () => {
    process.env.CRAFT_FEATURE_PAGES_SHARING = '1';
    process.env.CRAFT_PAGES_SHARE_API_URL = 'https://thecraftagents.com/p/api';
    const fetchFn = (() => {
      throw new Error('publish must not send to Craft');
    }) as unknown as typeof fetch;
    const publisher = new PagePublisher({
      tokenStore: { get: async () => null, set: async () => {}, delete: async () => false },
      fetchFn,
    });
    expect(resolvePagesShareApiBaseUrl()).toBeUndefined();
    await expect(publisher.publish('/unused', 'workspace', 'page', { includeData: false }))
      .rejects.toMatchObject({ code: 'PAGE_SHARING_DISABLED' });
  });
});
