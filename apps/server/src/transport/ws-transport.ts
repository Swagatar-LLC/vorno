/**
 * WsTransport — WebSocket transport for Bun.serve().
 *
 * Speaks the upstream MessageEnvelope protocol (handshake, request/response,
 * push events, heartbeat) using Bun's native ServerWebSocket API.
 *
 * Clients authenticate via API key in the handshake token field, using
 * the same auth backend as the HTTP/SSE transport.
 */

import type { ServerWebSocket } from 'bun';
import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  type MessageEnvelope,
  type ErrorCode,
} from '@craft-agent/shared/protocol';
import { serializeEnvelope, deserializeEnvelope } from '@craft-agent/server-core/transport/codec';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import type { AgentEvent } from '@craft-agent/core/types';

import { validateApiKey, loadServerConfig, type ServerConfig, type StoredApiKey } from '../config.ts';
import type { SessionPool } from '../services/session-pool.ts';
import type { EventBus } from '../services/event-bus.ts';
import { hasWorkspaceAccess, getEffectivePolicy, type AuthContext } from '../middleware/auth.ts';
import { ClientRegistry } from './client-registry.ts';
import type { TransportClient, WsClientData } from './types.ts';

// ---------------------------------------------------------------------------
// RPC channel names (matching upstream's conventions)
// ---------------------------------------------------------------------------

const RPC = {
  sessions: {
    CREATE: 'sessions:create',
    LIST: 'sessions:get',
    DELETE: 'sessions:delete',
    SEND_MESSAGE: 'sessions:sendMessage',
    CANCEL: 'sessions:cancel',
    RESPOND_PERMISSION: 'sessions:respondToPermission',
    EVENT: 'sessions:event',
  },
} as const;

// ---------------------------------------------------------------------------
// WsTransport
// ---------------------------------------------------------------------------

export class WsTransport {
  private pool: SessionPool;
  private eventBus: EventBus;
  private registry: ClientRegistry;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wsClients = new Map<string, ServerWebSocket<WsClientData>>();
  /** Track EventBus subscriptions per client so we can clean up on disconnect */
  private clientSubscriptions = new Map<string, Array<{ sessionId: string; unsubscribe: () => void }>>();

  constructor(pool: SessionPool, eventBus: EventBus, registry: ClientRegistry) {
    this.pool = pool;
    this.eventBus = eventBus;
    this.registry = registry;
  }

  // -------------------------------------------------------------------------
  // Bun.serve() websocket handler interface
  // -------------------------------------------------------------------------

  /**
   * Returns the websocket handler config for Bun.serve().
   * Wire this into Bun.serve({ websocket: transport.websocketHandler() }).
   */
  websocketHandler() {
    return {
      open: (ws: ServerWebSocket<WsClientData>) => this.onOpen(ws),
      message: (ws: ServerWebSocket<WsClientData>, message: string | Buffer) =>
        this.onMessage(ws, message),
      close: (ws: ServerWebSocket<WsClientData>, code: number, reason: string) =>
        this.onClose(ws, code, reason),
      // Bun calls drain when the send buffer empties; no-op for us
      drain: (_ws: ServerWebSocket<WsClientData>) => {},
    };
  }

  /**
   * Attempt to upgrade an HTTP request to WebSocket.
   * Returns true if the upgrade was initiated, false if it's not a WS request.
   */
  tryUpgrade(request: Request, server: ReturnType<typeof Bun.serve>): boolean {
    const url = new URL(request.url);

    // Only upgrade requests to /ws or /rpc
    if (url.pathname !== '/ws' && url.pathname !== '/rpc') {
      return false;
    }

    // Check for WebSocket upgrade header
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return false;
    }

    // Pre-create client data; actual auth happens during handshake
    const data: WsClientData = {
      clientId: randomUUID(),
      apiKey: null as any, // Set during handshake
      workspaceId: null,
      capabilities: new Set(),
      handshakeCompleted: false,
      handshakeEnvelopeId: null,
      missedPongs: 0,
      alive: true,
    };

    const upgraded = server.upgrade(request, { data });
    return !!upgraded;
  }

  /**
   * Start the heartbeat timer. Call once after server starts.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      for (const [clientId, ws] of this.wsClients) {
        const data = ws.data;
        if (!data.handshakeCompleted) continue;

        if (!data.alive) {
          data.missedPongs++;
          if (data.missedPongs >= HEARTBEAT_MAX_MISSED) {
            ws.close(4008, 'Heartbeat timeout');
            continue;
          }
        }

        data.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop heartbeat and close all WebSocket connections.
   */
  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const ws of this.wsClients.values()) {
      ws.close(1001, 'Server shutting down');
    }
    this.wsClients.clear();
  }

  /**
   * Number of connected WebSocket clients.
   */
  get clientCount(): number {
    return this.wsClients.size;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onOpen(ws: ServerWebSocket<WsClientData>): void {
    // Give client 5 seconds to complete handshake
    setTimeout(() => {
      if (!ws.data.handshakeCompleted) {
        ws.close(4001, 'Handshake timeout');
      }
    }, 5_000);
  }

  private async onMessage(ws: ServerWebSocket<WsClientData>, raw: string | Buffer): Promise<void> {
    let envelope: MessageEnvelope;
    try {
      envelope = deserializeEnvelope(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      ws.close(4002, 'Invalid message format');
      return;
    }

    if (!ws.data.handshakeCompleted) {
      await this.handleHandshake(ws, envelope);
      return;
    }

    if (envelope.type === 'request') {
      await this.handleRequest(ws, envelope);
    } else if (envelope.type === 'response') {
      // Client responses to server invocations (not implemented yet)
    }

    // Pong handling: Bun handles ws.pong() automatically,
    // but we reset alive on any message from the client
    ws.data.alive = true;
    ws.data.missedPongs = 0;
  }

  private onClose(ws: ServerWebSocket<WsClientData>, _code: number, _reason: string): void {
    const { clientId } = ws.data;

    // Clean up EventBus subscriptions
    const subs = this.clientSubscriptions.get(clientId);
    if (subs) {
      for (const sub of subs) {
        sub.unsubscribe();
      }
      this.clientSubscriptions.delete(clientId);
    }

    // Remove from registries
    this.wsClients.delete(clientId);
    this.registry.unregister(clientId);
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  private async handleHandshake(ws: ServerWebSocket<WsClientData>, envelope: MessageEnvelope): Promise<void> {
    if (envelope.type !== 'handshake') {
      ws.close(4003, 'Expected handshake');
      return;
    }

    // Protocol version check
    if (!envelope.protocolVersion) {
      this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
        `Missing protocolVersion. Server protocol ${PROTOCOL_VERSION}`);
      ws.close(4004, 'Protocol version unsupported');
      return;
    }

    const clientMajor = parseInt(envelope.protocolVersion.split('.')[0], 10);
    const serverMajor = parseInt(PROTOCOL_VERSION.split('.')[0], 10);
    if (clientMajor !== serverMajor) {
      this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
        `Server protocol ${PROTOCOL_VERSION}, client ${envelope.protocolVersion}`);
      ws.close(4004, 'Protocol version unsupported');
      return;
    }

    // Auth: validate API key from token field
    if (!envelope.token) {
      this.sendError(ws, envelope.id, 'AUTH_FAILED', 'API key required in token field');
      ws.close(4005, 'Auth failed');
      return;
    }

    const config = loadServerConfig();
    const apiKey = validateApiKey(envelope.token, config);
    if (!apiKey) {
      this.sendError(ws, envelope.id, 'AUTH_FAILED', 'Invalid API key');
      ws.close(4005, 'Auth failed');
      return;
    }

    // Complete handshake
    const data = ws.data;
    data.apiKey = apiKey;
    data.workspaceId = envelope.workspaceId ?? null;
    data.capabilities = new Set(envelope.clientCapabilities ?? []);
    data.handshakeCompleted = true;
    data.handshakeEnvelopeId = envelope.id;

    // Register in unified client registry
    this.wsClients.set(data.clientId, ws);

    const transportClient: TransportClient = {
      clientId: data.clientId,
      kind: 'websocket',
      apiKey,
      workspaceId: data.workspaceId,
      capabilities: data.capabilities,
      connectedAt: Date.now(),
      subscribedSessions: new Set(),
    };

    this.registry.register(transportClient, (channel: string, ...args: any[]) => {
      this.pushToWs(ws, channel, ...args);
    });

    // Send handshake_ack
    const ack: MessageEnvelope = {
      id: envelope.id,
      type: 'handshake_ack',
      protocolVersion: PROTOCOL_VERSION,
      clientId: data.clientId,
      registeredChannels: Object.values(RPC.sessions),
    };
    this.safeSend(ws, serializeEnvelope(ack));
  }

  // -------------------------------------------------------------------------
  // Request dispatching
  // -------------------------------------------------------------------------

  private async handleRequest(ws: ServerWebSocket<WsClientData>, envelope: MessageEnvelope): Promise<void> {
    const { channel, id, args } = envelope;
    const data = ws.data;

    if (!channel) {
      this.sendResponseError(ws, id, undefined, 'CHANNEL_NOT_FOUND', 'Missing channel');
      return;
    }

    const auth: AuthContext = { apiKey: data.apiKey };

    try {
      let result: any;

      switch (channel) {
        case RPC.sessions.CREATE:
          result = await this.rpcCreateSession(auth, args);
          // Auto-subscribe this WS client to the new session's events
          if (result?.sessionId) {
            this.subscribeClientToSession(data.clientId, result.sessionId);
          }
          break;

        case RPC.sessions.LIST:
          result = this.rpcListSessions(auth);
          break;

        case RPC.sessions.DELETE:
          result = this.rpcDeleteSession(auth, args);
          break;

        case RPC.sessions.SEND_MESSAGE:
          result = await this.rpcSendMessage(data.clientId, auth, args);
          break;

        case RPC.sessions.CANCEL:
          result = this.rpcCancel(auth, args);
          break;

        case RPC.sessions.RESPOND_PERMISSION:
          result = this.rpcRespondPermission(auth, args);
          break;

        default:
          this.sendResponseError(ws, id, channel, 'CHANNEL_NOT_FOUND', `No handler for: ${channel}`);
          return;
      }

      const response: MessageEnvelope = { id, type: 'response', channel, result };
      this.safeSend(ws, serializeEnvelope(response));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: ErrorCode = (err as any)?.code ?? 'HANDLER_ERROR';
      this.sendResponseError(ws, id, channel, code, message);
    }
  }

  // -------------------------------------------------------------------------
  // RPC handlers — thin wrappers over SessionPool
  // -------------------------------------------------------------------------

  private async rpcCreateSession(auth: AuthContext, args?: unknown[]): Promise<any> {
    const opts = (args?.[0] ?? {}) as {
      workspaceId?: string;
      model?: string;
      permissionPolicy?: 'deny-all' | 'allow-safe' | 'allow-all';
      enabledSources?: string[];
      workingDirectory?: string;
    };

    if (!opts.workspaceId) {
      throw Object.assign(new Error('workspaceId is required'), { code: 'HANDLER_ERROR' });
    }

    if (!hasWorkspaceAccess(auth, opts.workspaceId)) {
      throw Object.assign(new Error('Access denied to this workspace'), { code: 'AUTH_FAILED' });
    }

    const workspace = getWorkspaceByNameOrId(opts.workspaceId);
    if (!workspace) {
      throw Object.assign(new Error(`Workspace '${opts.workspaceId}' not found`), { code: 'HANDLER_ERROR' });
    }

    const config = loadServerConfig();
    const currentCount = this.pool.countByApiKey(auth.apiKey.id);
    const maxSessions = Math.min(
      auth.apiKey.permissions.maxConcurrentSessions,
      config.rateLimits.concurrentSessions,
    );
    if (currentCount >= maxSessions) {
      throw Object.assign(
        new Error(`Concurrent session limit reached (${currentCount}/${maxSessions})`),
        { code: 'HANDLER_ERROR' },
      );
    }

    const effectivePolicy = getEffectivePolicy(auth, opts.permissionPolicy);

    let sessionId = 'unknown';
    const session = await this.pool.create({
      workspace,
      permissionPolicy: effectivePolicy,
      model: opts.model,
      enabledSourceSlugs: opts.enabledSources,
      workingDirectory: opts.workingDirectory,
      isHeadless: true,
      log: (msg) => console.log(`[ws:session:${sessionId}] ${msg}`),
    }, auth.apiKey.id);
    sessionId = session.sessionId;

    return {
      sessionId: session.sessionId,
      workspaceId: opts.workspaceId,
      permissionPolicy: effectivePolicy,
      status: session.getStatus(),
    };
  }

  private rpcListSessions(auth: AuthContext): any {
    return this.pool.listSessions().filter(s => s.apiKeyId === auth.apiKey.id);
  }

  private rpcDeleteSession(auth: AuthContext, args?: unknown[]): any {
    const sessionId = args?.[0] as string;
    if (!sessionId) {
      throw Object.assign(new Error('sessionId is required'), { code: 'HANDLER_ERROR' });
    }

    if (!this.pool.has(sessionId)) {
      throw Object.assign(new Error(`Session '${sessionId}' not found`), { code: 'HANDLER_ERROR' });
    }

    this.pool.remove(sessionId);
    return { deleted: true };
  }

  private async rpcSendMessage(clientId: string, auth: AuthContext, args?: unknown[]): Promise<any> {
    const opts = (args?.[0] ?? {}) as {
      sessionId?: string;
      content?: string;
      attachments?: unknown[];
    };

    if (!opts.sessionId || !opts.content) {
      throw Object.assign(new Error('sessionId and content are required'), { code: 'HANDLER_ERROR' });
    }

    const session = this.pool.get(opts.sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session '${opts.sessionId}' not found`), { code: 'HANDLER_ERROR' });
    }

    if (session.getStatus() === 'processing') {
      throw Object.assign(new Error('Session is already processing a message'), { code: 'SESSION_NOT_IDLE' });
    }

    // Ensure client is subscribed to this session's events
    this.subscribeClientToSession(clientId, opts.sessionId);

    // Start chat in background — events stream via push
    const sessionId = opts.sessionId;
    (async () => {
      try {
        for await (const event of session.chat(opts.content!)) {
          this.eventBus.publish(sessionId, event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Chat error';
        this.eventBus.publish(sessionId, { type: 'error', message } as AgentEvent);
      }
    })();

    // Return immediately (events come via push)
    return { started: true };
  }

  private rpcCancel(auth: AuthContext, args?: unknown[]): any {
    const sessionId = args?.[0] as string;
    if (!sessionId) {
      throw Object.assign(new Error('sessionId is required'), { code: 'HANDLER_ERROR' });
    }

    const session = this.pool.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session '${sessionId}' not found`), { code: 'HANDLER_ERROR' });
    }

    session.abort();
    return { cancelled: true };
  }

  private rpcRespondPermission(auth: AuthContext, args?: unknown[]): any {
    const opts = (args?.[0] ?? {}) as {
      sessionId?: string;
      requestId?: string;
      allowed?: boolean;
    };

    if (!opts.sessionId || !opts.requestId || opts.allowed === undefined) {
      throw Object.assign(
        new Error('sessionId, requestId, and allowed are required'),
        { code: 'HANDLER_ERROR' },
      );
    }

    const session = this.pool.get(opts.sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session '${opts.sessionId}' not found`), { code: 'HANDLER_ERROR' });
    }

    session.respondToPermission(opts.requestId, opts.allowed);
    return { responded: true };
  }

  // -------------------------------------------------------------------------
  // Event subscription — bridge EventBus → WebSocket push
  // -------------------------------------------------------------------------

  private subscribeClientToSession(clientId: string, sessionId: string): void {
    // Check if already subscribed
    const client = this.registry.get(clientId);
    if (!client || client.subscribedSessions.has(sessionId)) return;

    client.subscribedSessions.add(sessionId);

    // Subscribe to EventBus and forward events as WS push
    const { unsubscribe } = this.eventBus.subscribe(sessionId, (event: AgentEvent) => {
      const ws = this.wsClients.get(clientId);
      if (ws) {
        this.pushToWs(ws, RPC.sessions.EVENT, sessionId, event);
      }
    });

    // Track for cleanup on disconnect
    const subs = this.clientSubscriptions.get(clientId) ?? [];
    subs.push({ sessionId, unsubscribe });
    this.clientSubscriptions.set(clientId, subs);
  }

  // -------------------------------------------------------------------------
  // Wire helpers
  // -------------------------------------------------------------------------

  private pushToWs(ws: ServerWebSocket<WsClientData>, channel: string, ...args: any[]): void {
    const envelope: MessageEnvelope = {
      id: randomUUID(),
      type: 'event',
      channel,
      args,
      serverId: 'http-trigger',
    };
    this.safeSend(ws, serializeEnvelope(envelope));
  }

  private sendError(ws: ServerWebSocket<WsClientData>, id: string, code: ErrorCode, message: string): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'error',
      error: { code, message },
    };
    this.safeSend(ws, serializeEnvelope(envelope));
  }

  private sendResponseError(
    ws: ServerWebSocket<WsClientData>,
    id: string,
    channel: string | undefined,
    code: ErrorCode,
    message: string,
  ): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'response',
      channel,
      error: { code, message },
    };
    this.safeSend(ws, serializeEnvelope(envelope));
  }

  private safeSend(ws: ServerWebSocket<WsClientData>, data: string): void {
    try {
      ws.send(data);
    } catch {
      // Connection may be closing
    }
  }
}
