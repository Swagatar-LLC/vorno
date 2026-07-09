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
} from './host-bridge.ts';

// Re-export the transport pieces the embedded host needs to build a node adapter.
export {
  WsProtocol,
  type WsProtocolOptions,
  type WsSocketAdapter,
  createWsClientData,
} from '../transport/index.ts';
export type { WsClientData } from '../transport/types.ts';
export { loadServerConfig, saveServerConfig, type ServerConfig } from '../config.ts';
