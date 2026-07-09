/**
 * Transport Module — Dual-Transport Server
 *
 * Provides a unified abstraction over WebSocket and HTTP/SSE transports.
 * Both transports share the same SessionPool, EventBus, and ClientRegistry.
 */
export { ClientRegistry, type PushCallback } from './client-registry.ts';
export { WsTransport, type WsTransportOptions } from './ws-transport.ts';
export { WsProtocol, type WsProtocolOptions } from './ws-protocol.ts';
export { createWsClientData, type WsSocketAdapter } from './ws-socket.ts';
export type {
  TransportKind,
  TransportClient,
  WsClientData,
} from './types.ts';
