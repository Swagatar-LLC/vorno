import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import type { AgentEvent } from '@craft-agent/core/types';
import { jsonResponse, errorResponse, sseResponse } from '../middleware/error.ts';
import { hasWorkspaceAccess, getEffectivePolicy, type AuthContext } from '../middleware/auth.ts';
import type { SessionPool } from '../services/session-pool.ts';
import type { ServerConfig } from '../config.ts';

/**
 * POST /api/sessions — Create a new session
 */
export async function handleCreateSession(
  request: Request,
  auth: AuthContext,
  pool: SessionPool,
  config: ServerConfig
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

  try {
    const session = await pool.create({
      workspace,
      permissionPolicy: effectivePolicy,
      model: body.model,
      enabledSourceSlugs: body.enabledSources,
      workingDirectory: body.workingDirectory,
      isHeadless: true,
      log: (msg) => console.log(`[session:${session.sessionId}] ${msg}`),
    }, auth.apiKey.id);

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
  const session = pool.get(sessionId);
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
export function handleDeleteSession(
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Response {
  if (!pool.has(sessionId)) {
    return errorResponse(404, `Session '${sessionId}' not found`);
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
  const session = pool.get(sessionId);
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
export function handleAbort(
  sessionId: string,
  auth: AuthContext,
  pool: SessionPool
): Response {
  const session = pool.get(sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  session.abort();
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
  const session = pool.get(sessionId);
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
  const session = pool.get(sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }

  // TODO: Track pending permission requests in AgentSession
  return jsonResponse({ pending: [] });
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
  const session = pool.get(sessionId);
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

  session.respondToPermission(body.requestId, body.decision === 'allow');
  return jsonResponse({ responded: true });
}
