import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import type { AgentEvent } from '@craft-agent/core/types';
import { jsonResponse, errorResponse, sseResponse } from '../middleware/error.ts';
import { hasWorkspaceAccess, getEffectivePolicy, type AuthContext } from '../middleware/auth.ts';
import type { SessionPool, PoolSession } from '../services/session-pool.ts';
import type { HostBridge } from '../core/host-bridge.ts'; // fork(PLAN-057)
import { RoutedSession } from '../services/routed-session.ts'; // fork(PLAN-057)
import type { ServerConfig } from '../config.ts';

/**
 * fork(PLAN-057): the session, only when it belongs to the calling key. A session
 * owned by another key is indistinguishable from a missing one (Session Isolation).
 */
function getOwnedSession(pool: SessionPool, auth: AuthContext, sessionId: string): PoolSession | undefined {
  if (pool.getOwner(sessionId) !== auth.apiKey.id) return undefined;
  return pool.get(sessionId);
}

/**
 * POST /api/sessions — Create a new session
 */
export async function handleCreateSession(
  request: Request,
  auth: AuthContext,
  pool: SessionPool,
  config: ServerConfig,
  hostBridge?: HostBridge // fork(PLAN-057)
): Promise<Response> {
  let body: {
    workspaceId: string;
    model?: string;
    permissionPolicy?: 'deny-all' | 'allow-safe' | 'allow-all';
    enabledSources?: string[];
    workingDirectory?: string;
  };

  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  if (!body.workspaceId) {
    return errorResponse(400, 'workspaceId is required');
  }

  if (!hasWorkspaceAccess(auth, body.workspaceId)) {
    return errorResponse(403, 'Access denied to this workspace');
  }

  const workspace = getWorkspaceByNameOrId(body.workspaceId);
  if (!workspace) {
    return errorResponse(404, `Workspace '${body.workspaceId}' not found`);
  }

  // Check concurrency limits
  const currentCount = pool.countByApiKey(auth.apiKey.id);
  const maxSessions = Math.min(
    auth.apiKey.permissions.maxConcurrentSessions,
    config.rateLimits.concurrentSessions
  );
  if (currentCount >= maxSessions) {
    return errorResponse(429, `Concurrent session limit reached (${currentCount}/${maxSessions})`);
  }

  const effectivePolicy = getEffectivePolicy(auth, body.permissionPolicy);

  // fork(PLAN-057): route through the desktop SessionManager when the host offers
  // it and the persisted setting is on. Everything above (auth, workspace, limits,
  // policy cap) already ran; the pool path below is untouched.
  if (config.routeSessionsToDesktop === true && hostBridge?.createSession) {
    try {
      const handle = await hostBridge.createSession({
        workspaceId: workspace.id,
        model: body.model,
        permissionPolicy: effectivePolicy,
        enabledSources: body.enabledSources,
        workingDirectory: body.workingDirectory,
        apiKeyName: auth.apiKey.name,
      });
      const routed = new RoutedSession(handle, effectivePolicy);
      pool.adopt(routed, auth.apiKey.id);
      return jsonResponse({
        sessionId: routed.sessionId,
        workspaceId: body.workspaceId,
        permissionPolicy: effectivePolicy,
        status: routed.getStatus(),
      }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      return errorResponse(500, message);
    }
  }

  try {
    let sessionId = 'unknown';
    const session = await pool.create({
      workspace,
      permissionPolicy: effectivePolicy,
      model: body.model,
      enabledSourceSlugs: body.enabledSources,
      workingDirectory: body.workingDirectory,
      isHeadless: true,
      log: (msg) => console.log(`[session:${sessionId}] ${msg}`),
    }, auth.apiKey.id);
    sessionId = session.sessionId;

    return jsonResponse({
      sessionId: session.sessionId,
      workspaceId: body.workspaceId,
      permissionPolicy: effectivePolicy,
      status: session.getStatus(),
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create session';
    return errorResponse(500, message);
  }
}

/**
 * GET /api/sessions — List active sessions
 */
export function handleListSessions(
  auth: AuthContext,
  pool: SessionPool,
  query: URLSearchParams
): Response {
  const workspaceFilter = query.get('workspaceId');

  let sessions = pool.listSessions()
    .filter(s => s.apiKeyId === auth.apiKey.id);

  if (workspaceFilter) {
    // Filter by workspace (we'd need workspace info on the session for this)
    // For now, return all sessions for this API key
  }

  return jsonResponse(sessions);
}

/**
 * GET /api/sessions/:id — Get session detail
 */
export function handleGetSession(
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Response {
  const session = getOwnedSession(pool, auth, sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  return jsonResponse({
    sessionId: session.sessionId,
    status: session.getStatus(),
    sdkSessionId: session.getSdkSessionId(),
    lastActivityAt: session.getLastActivityAt(),
  });
}

/**
 * DELETE /api/sessions/:id — Delete a session
 */
export async function handleDeleteSession(
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Promise<Response> {
  const session = getOwnedSession(pool, auth, sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  // fork(PLAN-057): routed sessions delete the desktop session too; remove() then
  // only detaches (dispose is a no-op after destroy).
  if (session.destroy) {
    try {
      await session.destroy();
    } catch (err) {
      return errorResponse(500, err instanceof Error ? err.message : 'Failed to delete session');
    }
  }
  pool.remove(sessionId);
  return jsonResponse({ deleted: true });
}

/**
 * POST /api/sessions/:id/messages — Send message, return SSE stream
 */
export async function handleSendMessage(
  request: Request,
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Promise<Response> {
  const session = getOwnedSession(pool, auth, sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  if (session.getStatus() === 'processing') {
    return errorResponse(409, 'Session is already processing a message');
  }

  let body: { content: string; attachments?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  if (!body.content) {
    return errorResponse(400, 'content is required');
  }

  const eventBus = pool.getEventBus();

  // Create SSE stream
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Subscribe to events
      const { unsubscribe } = eventBus.subscribe(sessionId, (event: AgentEvent) => {
        const sseData = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(sseData));

        if (event.type === 'complete' || event.type === 'error') {
          unsubscribe();
          controller.close();
        }
      });

      // Start the chat in the background
      (async () => {
        try {
          for await (const event of session.chat(body.content)) {
            eventBus.publish(sessionId, event);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Chat error';
          eventBus.publish(sessionId, { type: 'error', message });
        }
      })();
    },
  });

  return sseResponse(stream);
}

/**
 * POST /api/sessions/:id/abort — Abort current generation
 */
export async function handleAbort(
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Promise<Response> {
  const session = getOwnedSession(pool, auth, sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  await session.abort();
  return jsonResponse({ aborted: true });
}

/**
 * GET /api/sessions/:id/events — Persistent SSE stream for session
 */
export function handleSessionEvents(
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Response {
  const session = getOwnedSession(pool, auth, sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  const eventBus = pool.getEventBus();

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection event
      controller.enqueue(encoder.encode(`event: connected\ndata: {"sessionId":"${sessionId}"}\n\n`));

      // Subscribe to all session events
      const { unsubscribe } = eventBus.subscribe(sessionId, (event: AgentEvent) => {
        const sseData = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(sseData));
        } catch {
          // Stream closed
          unsubscribe();
        }
      });

      // Keep-alive ping every 30 seconds
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          clearInterval(keepAlive);
          unsubscribe();
        }
      }, 30_000);
    },
  });

  return sseResponse(stream);
}

/**
 * GET /api/sessions/:id/pending — Get pending permission requests
 */
export function handleGetPending(
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Response {
  const session = getOwnedSession(pool, auth, sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  // Pool (AgentSession) sessions do not track pending requests; routed ones do.
  return jsonResponse({ pending: session.getPending?.() ?? [] });
}

/**
 * POST /api/sessions/:id/permissions — Respond to permission request
 */
export async function handleRespondPermission(
  request: Request,
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Promise<Response> {
  const session = getOwnedSession(pool, auth, sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  let body: { requestId: string; decision: 'allow' | 'deny' };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  if (!body.requestId || !body.decision) {
    return errorResponse(400, 'requestId and decision are required');
  }

  const result = session.respondToPermission(body.requestId, body.decision === 'allow');
  // fork(PLAN-057): sessions that track pending requests 404 an unknown id.
  if (session.getPending && result === false) {
    return errorResponse(404, `Permission request '${body.requestId}' not found`);
  }
  return jsonResponse({ responded: true });
}
