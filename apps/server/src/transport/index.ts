/**
 * Transport Module — Dual-Transport Server
 *
 * Provides a unified abstraction over WebSocket and HTTP/SSE transports.
 * Both transports share the same SessionPool, EventBus, and ClientRegistry.
 */
export { ClientRegistry, type PushCallback } from './client-registry.ts';
export { WsTransport } from './ws-transport.ts';
export type {
  TransportKind,
  TransportClient,
  WsClientData,
} from './types.ts';
