import type { Workspace } from '../config/storage.ts';
import type { LoadedSource } from '../sources/types.ts';
import {
  loadWorkspaceSources,
  loadAllSources,
  getSourcesBySlugs,
  getSourceCredentialManager,
  getSourceServerBuilder,
  isApiOAuthProvider,
  TokenRefreshManager,
  createTokenGetter,
  SERVER_BUILD_ERRORS,
} from '../sources/index.ts';
import type { SourceWithCredential } from '../sources/server-builder.ts';
import type { CraftAgent } from '../agent/craft-agent.ts';
import type { SourceOrchestratorConfig, BuildServersResult, TokenRefreshResult } from './types.ts';

/**
 * SourceOrchestrator handles the loading, credential injection, and server building
 * for workspace sources. Extracted from SessionManager to be reusable across
 * both the Electron app and the HTTP server.
 *
 * Responsibilities:
 * - Load all sources from a workspace
 * - Build MCP and API server configs with injected credentials
 * - Handle OAuth token refresh
 * - Mark sources needing re-auth when tokens expire
 */
export class SourceOrchestrator {
  private workspace: Workspace;
  private log: (message: string) => void;

  constructor(config: SourceOrchestratorConfig) {
    this.workspace = config.workspace;
    this.log = config.log ?? (() => {});
  }

  /**
   * Load all sources for the workspace (including built-ins like docs).
   */
  loadAllSources(): LoadedSource[] {
    return loadAllSources(this.workspace.rootPath);
  }

  /**
   * Load workspace-specific sources (excludes built-ins).
   */
  loadWorkspaceSources(): LoadedSource[] {
    return loadWorkspaceSources(this.workspace.rootPath);
  }

  /**
   * Get sources by their slugs, filtered to enabled and authenticated.
   */
  getSourcesBySlugs(slugs: string[]): LoadedSource[] {
    return getSourcesBySlugs(this.workspace.rootPath, slugs);
  }

  /**
   * Build MCP and API servers from sources.
   * Handles credential loading and server building in one step.
   * When auth errors occur, marks sources as needing re-auth.
   *
   * @param sources - Sources to build servers for
   * @param sessionPath - Optional path to session folder for saving large API responses
   * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
   */
  async buildServers(
    sources: LoadedSource[],
    sessionPath?: string,
    tokenRefreshManager?: TokenRefreshManager
  ): Promise<BuildServersResult> {
    const credManager = getSourceCredentialManager();
    const serverBuilder = getSourceServerBuilder();

    // Load credentials for all sources
    const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
      sources.map(async (source) => ({
        source,
        token: await credManager.getToken(source),
        credential: await credManager.getApiCredential(source),
      }))
    );

    // Build token getter for OAuth sources
    const getTokenForSource = (source: LoadedSource) => {
      const provider = source.config.provider;
      if (isApiOAuthProvider(provider)) {
        const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
          log: (msg) => this.log(msg),
        });
        return createTokenGetter(manager, source);
      }
      return undefined;
    };

    // Build all servers
    const result = await serverBuilder.buildAll(sourcesWithCreds, getTokenForSource, sessionPath);

    // Update source configs for auth errors so consumers can reflect actual state
    for (const error of result.errors) {
      if (error.error === SERVER_BUILD_ERRORS.AUTH_REQUIRED) {
        const source = sources.find(s => s.config.slug === error.sourceSlug);
        if (source) {
          credManager.markSourceNeedsReauth(source, 'Token missing or expired');
          this.log(`Marked source ${error.sourceSlug} as needing re-auth`);
        }
      }
    }

    return result;
  }

  /**
   * Build servers for enabled sources in the workspace.
   * Convenience method that loads sources by slug, filters to enabled/authenticated,
   * and builds server configs.
   *
   * @param enabledSlugs - Slugs of sources to enable
   * @param sessionPath - Optional path to session folder for saving large API responses
   * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
   */
  async buildServersForSlugs(
    enabledSlugs: string[],
    sessionPath?: string,
    tokenRefreshManager?: TokenRefreshManager
  ): Promise<{ result: BuildServersResult; sources: LoadedSource[]; intendedSlugs: string[] }> {
    const sources = this.getSourcesBySlugs(enabledSlugs);
    const result = await this.buildServers(sources, sessionPath, tokenRefreshManager);
    const intendedSlugs = sources
      .filter(s => s.config.enabled && s.config.isAuthenticated)
      .map(s => s.config.slug);
    return { result, sources, intendedSlugs };
  }

  /**
   * Refresh expired OAuth tokens and rebuild server configs if needed.
   * Uses TokenRefreshManager for unified refresh logic with rate limiting.
   *
   * @param agent - The agent to update server configs on
   * @param sources - All loaded sources for the session
   * @param sessionPath - Path to session folder for API response storage
   * @param tokenRefreshManager - TokenRefreshManager instance for this session
   */
  async refreshTokensIfNeeded(
    agent: CraftAgent,
    sources: LoadedSource[],
    sessionPath: string,
    tokenRefreshManager: TokenRefreshManager
  ): Promise<TokenRefreshResult> {
    this.log('[OAuth] Checking if any MCP OAuth tokens need refresh');

    const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources);

    if (needRefresh.length === 0) {
      return { tokensRefreshed: false, failedSources: [] };
    }

    this.log(`[OAuth] Found ${needRefresh.length} source(s) needing token refresh: ${needRefresh.map(s => s.config.slug).join(', ')}`);

    const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh);

    const failedSources = failed.map(({ source, reason }) => ({
      slug: source.config.slug,
      reason,
    }));

    if (refreshed.length > 0) {
      this.log(`[OAuth] Rebuilding servers after ${refreshed.length} token refresh(es)`);
      const enabledSources = sources.filter(s => s.config.enabled && s.config.isAuthenticated);
      const { mcpServers, apiServers } = await this.buildServers(
        enabledSources,
        sessionPath,
        tokenRefreshManager
      );
      const intendedSlugs = enabledSources.map(s => s.config.slug);
      agent.setSourceServers(mcpServers, apiServers, intendedSlugs);
      return { tokensRefreshed: true, failedSources };
    }

    return { tokensRefreshed: false, failedSources };
  }

  /**
   * Create a new TokenRefreshManager instance for a session.
   */
  createTokenRefreshManager(): TokenRefreshManager {
    const credManager = getSourceCredentialManager();
    return new TokenRefreshManager(credManager, {
      log: (msg) => this.log(msg),
    });
  }
}
