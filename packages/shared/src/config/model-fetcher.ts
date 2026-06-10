/**
 * Model Fetcher — Centralized Model Discovery
 *
 * Type-safe plugin interface for fetching available models from providers.
 * Each provider (Anthropic, Pi) implements ModelFetcher.
 * The ModelFetcherMap enforces at compile time that every fetchable provider
 * has a registered fetcher — adding a new LlmProviderType without a fetcher
 * causes a type error.
 *
 * Compat providers (pi_compat) are excluded —
 * they point to arbitrary endpoints where users configure models manually.
 */

import type { ModelDefinition } from './models';
import type { LlmProviderType, LlmConnection } from './llm-connections';

// ============================================================
// Types
// ============================================================

/**
 * Providers that support automatic model fetching.
 * Compat providers are excluded — they point to arbitrary endpoints
 * (Ollama, OpenRouter, etc.) where users configure models manually.
 *
 * Adding a new LlmProviderType without updating this type
 * will cause a compile error in the fetcher registry.
 */
export type FetchableProvider = Exclude<LlmProviderType,
  | 'pi_compat'
>;

/**
 * Result of a model fetch operation.
 */
export interface ModelFetchResult {
  models: ModelDefinition[];
  /** Which model the provider considers the default (optional) */
  serverDefault?: string;
}

/**
 * Credentials needed to fetch models from a provider.
 * The ModelRefreshService resolves these from the credential manager.
 */
export interface ModelFetcherCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

/**
 * Plugin interface for provider-specific model discovery.
 *
 * Implementations live in apps/electron/src/main/model-fetchers/.
 * Each provider implements fetchModels() with its own SDK/API call.
 */
export interface ModelFetcher {
  /**
   * Fetch models from the provider API/SDK.
   * Throws on failure — the ModelRefreshService handles fallback.
   */
  fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult>;

  /**
   * Refresh interval in milliseconds.
   * 0 = fetch on auth/startup only, no periodic refresh.
   */
  readonly refreshIntervalMs: number;
}

/**
 * Type-safe fetcher map. Every FetchableProvider MUST have a fetcher.
 * Adding a new LlmProviderType without registering a fetcher → compile error.
 */
export type ModelFetcherMap = Record<FetchableProvider, ModelFetcher>;

/**
 * Pi auth providers whose model list is fetched **live** from the provider API
 * (vs. the static `@mariozechner/pi-ai` SDK catalog).
 *
 * Live-fetch providers get two behaviours from the refresh service that static
 * catalog providers do not:
 *  1. a periodic refresh timer (the static catalog only changes on dependency bump);
 *  2. their live result is accepted even when `modelSelectionMode === 'userDefined3Tier'`,
 *     because the server/provider — not the user — owns which models exist.
 *
 * `github-copilot` is server-policy managed; `openai` enumerates `GET /v1/models`.
 */
export const LIVE_FETCH_PI_AUTH_PROVIDERS = ['github-copilot', 'openai'] as const;

/** True when a connection's Pi model list comes from a live provider fetch. */
export function isLiveFetchPiConnection(
  connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider'>,
): boolean {
  return (
    connection.providerType === 'pi'
    && !!connection.piAuthProvider
    && (LIVE_FETCH_PI_AUTH_PROVIDERS as readonly string[]).includes(connection.piAuthProvider)
  );
}
