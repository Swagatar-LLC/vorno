/**
 * Page Publisher
 *
 * Client for the Cloudflare pages-share Worker (workers/pages). Owns the
 * local half of the publish/update/unpublish flow:
 *
 *   publish    → POST bundle → store admin token in the credential vault →
 *                write the local share pointer (page.json, atomic)
 *   republish  → PUT new revision with the vault token
 *   password   → PUT metadata-only change (set/clear) with the vault token
 *   unpublish  → DELETE with the vault token → clear pointer + vault entry
 *
 * Trust boundaries:
 *   - The admin token is a 256-bit capability minted by the Worker and
 *     returned exactly once; it lives only in the credential vault under
 *     `page_publish_token::{workspaceId}::{pageId}` and in the Authorization
 *     header of update/delete requests. It is never written to page.json,
 *     logs, or errors.
 *   - The password is forwarded once over HTTPS on set and never persisted,
 *     logged, or echoed back.
 *   - If the vault write fails right after a create, the remote publication
 *     is deleted immediately so no unmanageable public copy is left behind.
 *
 * Feature gating: publish/republish/password check `isPagesSharingEnabled()`;
 * unpublish deliberately does not, so disabling the flag never strands a
 * published page (design §12).
 */

import type { PageConfig, PageShareInfo } from '@craft-agent/core';
import { isPagesSharingEnabled } from '../feature-flags.ts';
import { isPagesEnabled } from './capability.ts';
import { deletePage, loadPageConfig, setPageShareState } from './storage.ts';
import { buildPageShareBundle, PageShareError } from './share-bundle.ts';

/**
 * Resolve an explicitly configured Vorno or localhost-development publication API.
 * Fresh publication never falls back to Craft or another arbitrary endpoint.
 */
export function resolvePagesShareApiBaseUrl(): string | undefined {
  const base = typeof process !== 'undefined' ? process.env?.CRAFT_PAGES_SHARE_API_URL?.trim() : undefined;
  return base ? resolveApprovedPagesShareApiBaseUrl(base) : undefined;
}

/** The publisher and capability RPC must agree on this exact predicate. */
export function isPagesSharingAvailable(
  workspaceRootPath: string | undefined,
  apiBaseUrl = resolvePagesShareApiBaseUrl(),
): boolean {
  return isPagesEnabled(workspaceRootPath) && isPagesSharingEnabled() && apiBaseUrl !== undefined;
}

/**
 * Existing public copies remain revocable after endpoint/default changes.
 * Stored URLs are resource identities, not arbitrary fetch authorities: only
 * the legacy Craft and exact Vorno public URL shapes can recover an API base.
 */
export function resolveStoredPagesShareApiBaseUrl(shareUrl: string, activeDevelopmentApiBaseUrl?: string): string | undefined {
  let url: URL;
  try { url = new URL(shareUrl); } catch { return undefined; }
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (!/^\/p\/[A-Za-z0-9_-]+$/.test(url.pathname)) return undefined;
  if (url.protocol === 'https:' && !url.port && url.hostname === 'thecraftagents.com') return 'https://thecraftagents.com/p/api';
  if (url.protocol === 'https:' && !url.port && url.hostname === 'pages.vorno.ai') return 'https://pages.vorno.ai/api';
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port) {
    const candidate = `${url.origin}/api`;
    return activeDevelopmentApiBaseUrl === candidate ? candidate : undefined;
  }
  return undefined;
}

function resolveApprovedPagesShareApiBaseUrl(base: string): string | undefined {
  let url: URL;
  try { url = new URL(base); } catch { return undefined; }
  if (url.username || url.password || url.search || url.hash) return undefined;
  const apiPath = url.pathname === '/api' || url.pathname === '/api/';
  if (!apiPath) return undefined;
  if (url.protocol === 'https:' && url.hostname === 'pages.vorno.ai' && !url.port) {
    return 'https://pages.vorno.ai/api';
  }
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port) {
    return `${url.origin}/api`;
  }
  return undefined;
}

/** Minimal vault seam so tests can run without the real CredentialManager */
export interface PagePublishTokenStore {
  get(workspaceId: string, pageId: string): Promise<string | null>;
  set(workspaceId: string, pageId: string, token: string): Promise<void>;
  delete(workspaceId: string, pageId: string): Promise<boolean>;
}

/**
 * Production token store backed by the encrypted credential vault
 * (`page_publish_token::{workspaceId}::{pageId}`).
 */
export function createCredentialPagePublishTokenStore(): PagePublishTokenStore {
  const credentialId = (workspaceId: string, pageId: string) =>
    ({ type: 'page_publish_token', workspaceId, name: pageId }) as const;
  return {
    async get(workspaceId, pageId) {
      const { getCredentialManager } = await import('../credentials/index.ts');
      const stored = await getCredentialManager().get(credentialId(workspaceId, pageId));
      return stored?.value ?? null;
    },
    async set(workspaceId, pageId, token) {
      const { getCredentialManager } = await import('../credentials/index.ts');
      await getCredentialManager().set(credentialId(workspaceId, pageId), { value: token });
    },
    async delete(workspaceId, pageId) {
      const { getCredentialManager } = await import('../credentials/index.ts');
      return getCredentialManager().delete(credentialId(workspaceId, pageId));
    },
  };
}

export interface PagePublisherOptions {
  tokenStore: PagePublishTokenStore;
  /** Injectable for tests (defaults to global fetch) */
  fetchFn?: typeof fetch;
  /** Fresh-publication API base, e.g. https://pages.vorno.ai/api */
  apiBaseUrl?: string;
  log?: (message: string) => void;
}

export interface PublishPageOptions {
  /** Publish the current data snapshot alongside the HTML (default false) */
  includeData: boolean;
  /** Optional viewer password, applied at create time only */
  password?: string;
  /** Required when the page has approved source-action grants */
  viewOnlyAcknowledged?: boolean;
}

export interface UnpublishResult {
  config: PageConfig;
  /**
   * Set when local state was cleared without remote confirmation (vault token
   * missing) — the public copy may still exist until it is garbage-collected.
   */
  warning?: 'remote-copy-may-remain' | 'remote-cleanup-pending';
}

interface WorkerPublicationResponse {
  id: string;
  url: string;
  revision: string;
  adminToken?: string;
  passwordProtected: boolean;
  status: 'published' | 'unpublished';
  updatedAt: number;
}

const ERROR_BODY_MAX_CHARS = 300;

/** Why a retained share pointer can no longer be revoked through the normal path. */
export type LocalPublicationRecoveryReason = 'token-missing' | 'origin-unusable';

export interface LocalPublicationRecovery {
  /** The publication a human is about to be asked about, and the only one the approval covers. */
  publicationId: string;
  reason: LocalPublicationRecoveryReason;
}

// ============================================================================
// Per-page serialization
// ============================================================================

/**
 * Tails of the in-flight lifecycle operation for each page, so the four entry
 * points below run one at a time per page.
 *
 * Module-scoped on purpose: every RPC call builds a fresh PagePublisher, so an
 * instance field would serialize nothing. What must not interleave is the
 * read-modify-write of two pieces of state that only mean anything together —
 * the `page.json` share pointer and the vault token under
 * `page_publish_token::{workspaceId}::{pageId}`. A forget that deletes the
 * token a concurrent publish just minted leaves a live public copy nobody can
 * revoke, and there is no local state left to notice it from.
 *
 * The acquiring entry points are `publish`, `setPassword`, `unpublish`,
 * `forgetLocalPublication`, and `deleteWithUnpublish`, and none of them calls
 * another — each delegates to a private `*Locked` body, and composite operations
 * call those bodies directly. Keep it that way: a public method calling a public
 * method would wait for itself forever.
 *
 * A lifecycle operation must hold this across its WHOLE state transition, not
 * just its remote call. `deleteWithUnpublish` is the cautionary case — it used to
 * release between unpublishing and removing the folder, and a publish landing in
 * that gap left a live public copy with nothing pointing at it.
 */
const pageLifecycleTails = new Map<string, Promise<void>>();

function withPageLifecycleLock<T>(
  workspaceRootPath: string,
  pageSlug: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([workspaceRootPath, pageSlug]);
  const previous = pageLifecycleTails.get(key) ?? Promise.resolve();
  // Both arms run `run`: a predecessor that rejected has still released the
  // page, and inheriting its failure would wedge the page for the whole process.
  const result = previous.then(run, run);
  const tail = result.then(() => {}, () => {});
  pageLifecycleTails.set(key, tail);
  // Drop the entry once nothing is queued behind it, so a long-lived host does
  // not retain one settled promise per page it ever published.
  void tail.then(() => {
    if (pageLifecycleTails.get(key) === tail) pageLifecycleTails.delete(key);
  });
  return result;
}

export class PagePublisher {
  private readonly tokenStore: PagePublishTokenStore;
  private readonly fetchFn: typeof fetch;
  private readonly publishApiBaseUrl: string | undefined;
  private readonly log: (message: string) => void;

  constructor(options: PagePublisherOptions) {
    this.tokenStore = options.tokenStore;
    this.fetchFn = options.fetchFn ?? fetch;
    this.publishApiBaseUrl = options.apiBaseUrl
      ? resolveApprovedPagesShareApiBaseUrl(options.apiBaseUrl)
      : resolvePagesShareApiBaseUrl();
    this.log = options.log ?? (() => {});
  }

  /**
   * Publish a page: create a new publication, or upload a new revision when
   * one already exists. Returns the updated PageConfig (share pointer set).
   */
  publish(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
    options: PublishPageOptions,
  ): Promise<PageConfig> {
    return withPageLifecycleLock(workspaceRootPath, pageSlug, () =>
      this.publishLocked(workspaceRootPath, workspaceId, pageSlug, options));
  }

  private async publishLocked(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
    options: PublishPageOptions,
  ): Promise<PageConfig> {
    this.assertExistingPublicationEnabled(workspaceRootPath);

    const config = this.requirePage(workspaceRootPath, pageSlug);
    const bundle = buildPageShareBundle(workspaceRootPath, pageSlug, {
      includeData: options.includeData,
      viewOnlyAcknowledged: options.viewOnlyAcknowledged,
    });

    const existingShare = config.share;
    if (existingShare) {
      const token = await this.tokenStore.get(workspaceId, config.id);
      if (!token) {
        throw new PageShareError(
          'PAGE_SHARE_TOKEN_MISSING',
          'The key for managing this page\'s public copy is missing from secure storage. Unpublish the page, then publish it again.',
        );
      }
      return this.uploadRevision(workspaceRootPath, pageSlug, config, existingShare, token, bundle);
    }

    // Create a fresh publication only through the configured approved endpoint.
    this.assertFreshPublishingAvailable(workspaceRootPath);
    const form = new FormData();
    form.set('manifest', JSON.stringify(bundle.manifest));
    form.set('content', new Blob([bundle.content], { type: 'text/html' }), 'index.html');
    if (bundle.snapshotJson !== undefined) {
      form.set('snapshot', new Blob([bundle.snapshotJson], { type: 'application/json' }), 'snapshot.json');
    }
    if (options.password) form.set('password', options.password);

    const response = await this.request(this.requirePublishApiBaseUrl(), 'POST', '/publications', { body: form });
    const dto = await this.parsePublication(response, 201);
    if (!dto.adminToken) {
      throw new PageShareError('PAGE_SHARE_REMOTE_ERROR', 'Create response did not include an admin token');
    }

    // Vault write MUST succeed before we acknowledge the publication locally;
    // otherwise delete the remote copy so it never becomes unmanageable.
    try {
      await this.tokenStore.set(workspaceId, config.id, dto.adminToken);
    } catch (err) {
      this.log(`Vault write failed after publication create; rolling back remote ${dto.id}`);
      try {
        await this.request(this.requirePublishApiBaseUrl(), 'DELETE', `/publications/${encodeURIComponent(dto.id)}`, {
          adminToken: dto.adminToken,
        });
      } catch {
        // Best effort — the create is reported failed either way.
      }
      throw new PageShareError(
        'PAGE_SHARE_VAULT_ERROR',
        `Could not save the key for managing the public copy to secure storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const now = Date.now();
    const share: PageShareInfo = {
      publicationId: dto.id,
      url: dto.url,
      publishedRevision: dto.revision,
      publishedContentDigest: bundle.contentDigest,
      includesData: bundle.manifest.includesData,
      publishedAt: now,
      updatedAt: now,
      passwordProtected: dto.passwordProtected,
    };
    const updated = setPageShareState(workspaceRootPath, pageSlug, share);
    this.log(`Published page ${pageSlug} as ${dto.id}`);
    return updated;
  }

  /** Change or remove the viewer password (metadata-only; content untouched). */
  setPassword(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
    password: string | null,
  ): Promise<PageConfig> {
    return withPageLifecycleLock(workspaceRootPath, pageSlug, () =>
      this.setPasswordLocked(workspaceRootPath, workspaceId, pageSlug, password));
  }

  private async setPasswordLocked(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
    password: string | null,
  ): Promise<PageConfig> {
    this.assertExistingPublicationEnabled(workspaceRootPath);

    const config = this.requirePage(workspaceRootPath, pageSlug);
    const share = this.requireShare(config);
    const token = await this.requireToken(workspaceId, config.id);

    const form = new FormData();
    form.set('passwordAction', password === null ? 'clear' : 'set');
    if (password !== null) form.set('password', password);

    const response = await this.request(this.requireStoredApiBaseUrl(share), 'PUT', `/publications/${encodeURIComponent(share.publicationId)}`, {
      body: form,
      adminToken: token,
    });
    const dto = await this.parsePublication(response, 200);

    const updated = setPageShareState(workspaceRootPath, pageSlug, {
      ...share,
      passwordProtected: dto.passwordProtected,
      updatedAt: Date.now(),
      lastPublishError: undefined,
    });
    this.log(`Updated publication password for ${pageSlug} (${password === null ? 'cleared' : 'set'})`);
    return updated;
  }

  /**
   * Unpublish a page. Clears local state after remote 2xx or an idempotent
   * 404. When the vault token is missing, local state is still cleared but
   * the result carries a warning that the remote copy may remain.
   */
  unpublish(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
  ): Promise<UnpublishResult> {
    return withPageLifecycleLock(workspaceRootPath, pageSlug, () =>
      this.unpublishLocked(workspaceRootPath, workspaceId, pageSlug));
  }

  private async unpublishLocked(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
  ): Promise<UnpublishResult> {
    const config = this.requirePage(workspaceRootPath, pageSlug);
    const share = this.requireShare(config);

    const token = await this.tokenStore.get(workspaceId, config.id);
    if (!token) {
      // We cannot claim logical revocation without the capability. Keep the
      // share pointer so a restored vault token can retry the real remote call.
      this.log(`Unpublish not attempted for ${pageSlug}: admin token missing from vault`);
      return { config, warning: 'remote-copy-may-remain' };
    }

    const response = await this.request(
      this.requireStoredApiBaseUrl(share),
      'DELETE',
      `/publications/${encodeURIComponent(share.publicationId)}`,
      { adminToken: token },
    );
    if (!response.ok && response.status !== 404) {
      throw new PageShareError(
        'PAGE_SHARE_REMOTE_ERROR',
        `Unpublish failed with status ${response.status}: ${await safeBodyExcerpt(response)}`,
      );
    }

    // Logical revocation is already complete when this flag is true: public
    // routes 404, but the Worker recorded a physical-object cleanup retry.
    // Reuse the existing conservative UI warning rather than hiding an
    // operator-visible retention failure behind a successful HTTP status.
    if (await hasPendingRemoteCleanup(response)) {
      // Keep the ID, token, and state reachable so the same user-visible
      // Unpublish action retries physical cleanup. Public routes are already 404.
      const updated = setPageShareState(workspaceRootPath, pageSlug, { ...share, cleanupPending: true, updatedAt: Date.now() });
      this.log(`Logical unpublish complete; remote cleanup pending for ${pageSlug} (${share.publicationId})`);
      return { config: updated, warning: 'remote-cleanup-pending' };
    }
    const updated = setPageShareState(workspaceRootPath, pageSlug, undefined);
    await this.tokenStore.delete(workspaceId, config.id);
    this.log(`Unpublished page ${pageSlug} (${share.publicationId})`);
    return { config: updated };
  }

  /**
   * Whether local-only recovery applies to this page right now, and which
   * publication it would forget.
   *
   * Recovery exists for exactly one situation: a *retained* share pointer whose
   * public copy can no longer be reached through the normal path, because the
   * admin capability is gone from the vault or the stored origin is not one we
   * will talk to. The two refusals are the point of the method. A page with no
   * share pointer has nothing to forget, and a page that is still fully
   * manageable must go through unpublish — offering the destructive local path
   * there lets a user strand a live public copy that one ordinary request would
   * have revoked, which is the opposite of what the escape hatch is for.
   *
   * Callers must snapshot the returned `publicationId` and pass it to
   * `forgetLocalPublication`, so the publication a human approved forgetting is
   * the only one that can be forgotten.
   */
  async describeLocalPublicationRecovery(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
  ): Promise<LocalPublicationRecovery> {
    return this.evaluateLocalPublicationRecovery(this.requirePage(workspaceRootPath, pageSlug), workspaceId);
  }

  /**
   * The eligibility question itself, asked against an already-loaded config so
   * the locked path can re-ask it without a second read of `page.json`.
   */
  private async evaluateLocalPublicationRecovery(
    config: PageConfig,
    workspaceId: string,
  ): Promise<LocalPublicationRecovery> {
    const share = config.share;
    if (!share) {
      throw new PageShareError(
        'PAGE_SHARE_NOT_PUBLISHED',
        `Page has no publication state to forget: ${config.slug}`,
      );
    }
    const token = await this.tokenStore.get(workspaceId, config.id);
    if (!token) return { publicationId: share.publicationId, reason: 'token-missing' };
    if (!resolveStoredPagesShareApiBaseUrl(share.url, this.publishApiBaseUrl)) {
      return { publicationId: share.publicationId, reason: 'origin-unusable' };
    }
    throw new PageShareError(
      'PAGE_SHARE_FORGET_NOT_ELIGIBLE',
      'This page can still be unpublished normally. Unpublish it so the public copy is actually revoked.',
    );
  }

  /**
   * Deliberately local-only escape hatch for a lost admin capability or stale
   * development origin. The caller must obtain explicit human confirmation:
   * this never contacts the remote service and the public copy may remain.
   *
   * `expectedPublicationId` is the publication that confirmation was about.
   * Asking a human is slow and the page stays live underneath the question, so
   * by the time approval arrives an ordinary unpublish and republish may have
   * replaced the pointer and minted a NEW admin token under the same vault key.
   * Deleting it then would strand a publication that was perfectly manageable a
   * moment ago. So the pointer is re-read *inside* the lock and must still name
   * the approved publication before either the token or the pointer is touched —
   * one check covering both writes, which is only sound because the lock is what
   * stops anything landing between them.
   */
  forgetLocalPublication(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
    expectedPublicationId: string,
  ): Promise<PageConfig> {
    return withPageLifecycleLock(workspaceRootPath, pageSlug, async () => {
      const config = this.requirePage(workspaceRootPath, pageSlug);
      if (config.share?.publicationId !== expectedPublicationId) {
        throw new PageShareError(
          'PAGE_SHARE_FORGET_STALE',
          'This page\'s public copy changed while the confirmation was open, so that approval no longer applies. Review sharing again.',
        );
      }
      // Re-ask eligibility, not just identity. The same publication can become
      // revocable again while the confirmation is open — an unlocked keychain is
      // enough — and destroying the local state then would strand a public copy
      // that one ordinary request could have taken down. Refusing here sends the
      // user to the path that actually revokes, which is never the worse outcome.
      await this.evaluateLocalPublicationRecovery(config, workspaceId);
      await this.tokenStore.delete(workspaceId, config.id);
      return setPageShareState(workspaceRootPath, pageSlug, undefined);
    });
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  private async uploadRevision(
    workspaceRootPath: string,
    pageSlug: string,
    config: PageConfig,
    share: PageShareInfo,
    token: string,
    bundle: ReturnType<typeof buildPageShareBundle>,
  ): Promise<PageConfig> {
    const form = new FormData();
    form.set('manifest', JSON.stringify(bundle.manifest));
    form.set('content', new Blob([bundle.content], { type: 'text/html' }), 'index.html');
    if (bundle.snapshotJson !== undefined) {
      form.set('snapshot', new Blob([bundle.snapshotJson], { type: 'application/json' }), 'snapshot.json');
    }

    let dto: WorkerPublicationResponse;
    try {
      const response = await this.request(
        this.requireStoredApiBaseUrl(share),
        'PUT',
        `/publications/${encodeURIComponent(share.publicationId)}`,
        { body: form, adminToken: token },
      );
      dto = await this.parsePublication(response, 200);
    } catch (err) {
      // Record the failure on the share pointer so the UI can surface it.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      setPageShareState(workspaceRootPath, pageSlug, { ...share, lastPublishError: message });
      throw err;
    }

    const updated = setPageShareState(workspaceRootPath, pageSlug, {
      ...share,
      publishedRevision: dto.revision,
      publishedContentDigest: bundle.contentDigest,
      includesData: bundle.manifest.includesData,
      updatedAt: Date.now(),
      passwordProtected: dto.passwordProtected,
      lastPublishError: undefined,
    });
    this.log(`Republished page ${pageSlug} (${share.publicationId} → ${dto.revision})`);
    return updated;
  }

  private assertExistingPublicationEnabled(workspaceRootPath: string): void {
    if (!isPagesEnabled(workspaceRootPath) || !isPagesSharingEnabled()) {
      throw new PageShareError(
        'PAGE_SHARING_DISABLED',
        'Pages sharing is unavailable until this workspace has a verified Vorno publication capability.',
      );
    }
  }

  private assertFreshPublishingAvailable(workspaceRootPath: string): void {
    if (!isPagesSharingAvailable(workspaceRootPath, this.publishApiBaseUrl)) {
      throw new PageShareError(
        'PAGE_SHARING_DISABLED',
        'Pages sharing is unavailable until this workspace has a verified Vorno publication capability.',
      );
    }
  }

  private requirePage(workspaceRootPath: string, pageSlug: string): PageConfig {
    const config = loadPageConfig(workspaceRootPath, pageSlug);
    if (!config) throw new PageShareError('PAGE_NOT_FOUND', `Page not found: ${pageSlug}`);
    return config;
  }

  private requireShare(config: PageConfig): PageShareInfo {
    if (!config.share) {
      throw new PageShareError('PAGE_SHARE_NOT_PUBLISHED', `Page is not published: ${config.slug}`);
    }
    return config.share;
  }

  private requirePublishApiBaseUrl(): string {
    if (!this.publishApiBaseUrl) {
      throw new PageShareError('PAGE_SHARING_DISABLED', 'Pages sharing has no configured publication endpoint.');
    }
    return this.publishApiBaseUrl;
  }

  private requireStoredApiBaseUrl(share: PageShareInfo): string {
    const apiBaseUrl = resolveStoredPagesShareApiBaseUrl(share.url, this.publishApiBaseUrl);
    if (!apiBaseUrl) {
      throw new PageShareError('PAGE_SHARE_REMOTE_ERROR', 'Published page has no valid HTTPS origin for cleanup.');
    }
    return apiBaseUrl;
  }

  /**
   * Unpublish (when published) and then delete the local page, with BOTH halves
   * inside ONE acquisition of the per-page lock.
   *
   * Splitting them is what made this dangerous. Unpublish ends by clearing the
   * share pointer and the vault token, and if the lock is released there, a
   * queued publish runs next: it mints a live public copy and a fresh token, and
   * then the local delete removes the folder that held the only pointer to it.
   * The result is a public page with no local trace and a token nobody will ever
   * look up — the exact unrevocable copy the rest of this file exists to prevent.
   *
   * Holding the lock across both halves means a concurrent publish can only run
   * strictly before (its publication is then unpublished normally) or strictly
   * after (it finds no page and fails), never inside.
   */
  deleteWithUnpublish(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
  ): Promise<DeletePageOutcome> {
    return withPageLifecycleLock(workspaceRootPath, pageSlug, () =>
      this.deleteWithUnpublishLocked(workspaceRootPath, workspaceId, pageSlug));
  }

  private async deleteWithUnpublishLocked(
    workspaceRootPath: string,
    workspaceId: string,
    pageSlug: string,
  ): Promise<DeletePageOutcome> {
    const wasShared = Boolean(loadPageConfig(workspaceRootPath, pageSlug)?.share);
    if (wasShared) {
      let result: UnpublishResult;
      try {
        // The private body, not the public method: the public one would try to
        // take a lock this call already holds and wait for itself forever.
        result = await this.unpublishLocked(workspaceRootPath, workspaceId, pageSlug);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`Unpublish before delete failed for ${pageSlug}: ${detail}`);
        throw new Error(`Could not confirm remote revocation; retry unpublish before deleting the local page: ${detail}`);
      }
      if (result.warning) {
        throw new Error(
          result.warning === 'remote-cleanup-pending'
            ? 'The page is no longer public, but remote data cleanup is pending. Retry unpublish before deleting the local page.'
            : 'The page may still be public because its admin token is missing. Restore the token or republish before deleting the local page.',
        );
      }
    }

    // Re-read the pointer immediately before the irreversible part. Nothing can
    // have published under the lock, so this should be unreachable — which is
    // the reason to check it rather than assume it: the pointer is the only
    // thing that makes a remote copy findable, and deleting the folder while one
    // exists cannot be undone or even noticed afterwards.
    if (loadPageConfig(workspaceRootPath, pageSlug)?.share) {
      throw new Error('The page still has a public copy recorded locally; retry unpublish before deleting the local page.');
    }

    try {
      deletePage(workspaceRootPath, pageSlug);
    } catch (error) {
      // The unpublish (if any) already happened by now — a bare fs error would
      // misreport that state and send the user retrying the remote half too.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        wasShared
          ? `The page was unpublished, but deleting the local folder failed: ${detail}`
          : `Deleting the local page folder failed: ${detail}`,
      );
    }
    return { publicCopyMayRemain: false };
  }

  private async requireToken(workspaceId: string, pageId: string): Promise<string> {
    const token = await this.tokenStore.get(workspaceId, pageId);
    if (!token) {
      throw new PageShareError(
        'PAGE_SHARE_TOKEN_MISSING',
        'The key for managing this page\'s public copy is missing from secure storage. Unpublish the page, then publish it again.',
      );
    }
    return token;
  }

  private async request(
    apiBaseUrl: string,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: FormData; adminToken?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.adminToken) headers['Authorization'] = `Bearer ${options.adminToken}`;
    try {
      return await this.fetchFn(`${apiBaseUrl}${path}`, {
        method,
        headers,
        body: options.body,
      });
    } catch (err) {
      throw new PageShareError(
        'PAGE_SHARE_REMOTE_ERROR',
        `Could not reach the publication service: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async parsePublication(response: Response, expectedStatus: number): Promise<WorkerPublicationResponse> {
    if (response.status !== expectedStatus) {
      throw new PageShareError(
        'PAGE_SHARE_REMOTE_ERROR',
        `Publication service returned ${response.status}: ${await safeBodyExcerpt(response)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new PageShareError('PAGE_SHARE_REMOTE_ERROR', 'Publication service returned invalid JSON');
    }
    const dto = parsed as Partial<WorkerPublicationResponse>;
    if (
      typeof dto.id !== 'string' ||
      typeof dto.url !== 'string' ||
      typeof dto.revision !== 'string' ||
      typeof dto.passwordProtected !== 'boolean'
    ) {
      throw new PageShareError('PAGE_SHARE_REMOTE_ERROR', 'Publication service response is missing fields');
    }
    return dto as WorkerPublicationResponse;
  }
}

async function safeBodyExcerpt(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_MAX_CHARS);
  } catch {
    return '<unreadable body>';
  }
}

/** Best-effort compatibility read: legacy delete endpoints may return an empty 204. */
async function hasPendingRemoteCleanup(response: Response): Promise<boolean> {
  if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) return false;
  try {
    const body = await response.clone().json() as { cleanupPending?: unknown };
    return body.cleanupPending === true;
  } catch {
    return false;
  }
}

// ============================================================================
// Delete with best-effort unpublish (shared flow)
// ============================================================================

export interface DeletePageOutcome {
  /** Always false when returned: unconfirmed revocation throws and blocks deletion. */
  publicCopyMayRemain: boolean;
}

/**
 * Delete a page, unpublishing it first when it has a share pointer.
 *
 * The single entry point behind BOTH the `pages:delete` RPC and the
 * `delete_page` session tool — keep it that way so the two paths cannot
 * drift (unpublish-before-delete is a policy, not a handler detail).
 * Unpublish failures block the local delete; callers must retry revocation or,
 * in Electron only, explicitly approve forgetting the local recovery state.
 *
 * The flow itself lives in `PagePublisher.deleteWithUnpublish` because it has to
 * run under that class's per-page lock — a free function could only call the
 * public `unpublish`, which releases the lock before the folder is removed.
 */
export async function deletePageWithUnpublish(
  workspaceRootPath: string,
  workspaceId: string,
  pageSlug: string,
  options?: { log?: (message: string) => void; tokenStore?: PagePublishTokenStore; fetchFn?: typeof fetch },
): Promise<DeletePageOutcome> {
  const publisher = new PagePublisher({
    tokenStore: options?.tokenStore ?? createCredentialPagePublishTokenStore(),
    fetchFn: options?.fetchFn,
    log: options?.log,
  });
  return publisher.deleteWithUnpublish(workspaceRootPath, workspaceId, pageSlug);
}
