/**
 * Trigger-server core — the runtime-neutral surface both hosts compose on.
 *
 * Standalone (Bun) and embedded (Electron node:http + ws) hosts import from here
 * (ADR-0007 / PLAN-012).
 */
export {
  createTriggerServer,
  type TriggerServerCore,
  type CreateTriggerServerOptions,
} from './create-trigger-server.ts';
export type {
  HostBridge,
  WebhookIngestEvent,
  HostCreateSessionOptions,
  HostCreatedSession,
  HostSessionStatus, // fork(PLAN-057)
  RestPermissionPolicy, // fork(PLAN-057)
} from './host-bridge.ts';
export { policyToPermissionMode } from './host-bridge.ts'; // fork(PLAN-057)

// Re-export the transport pieces the embedded host needs to build a node adapter.
export {
  WsProtocol,
  type WsProtocolOptions,
  type WsSocketAdapter,
  createWsClientData,
} from '../transport/index.ts';
export type { WsClientData } from '../transport/types.ts';
export {
  loadServerConfig,
  saveServerConfig,
  generateApiKey,
  addApiKey,
  revokeApiKey,
  type ServerConfig,
  type StoredApiKey,
  type ApiKeyPermissions,
  type RateLimits,
  type WebUiConfig, // fork(PLAN-020)
} from '../config.ts';
