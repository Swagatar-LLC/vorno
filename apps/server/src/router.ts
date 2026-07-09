import { authenticate, type AuthContext } from './middleware/auth.ts';
import { handlePreflight, corsHeaders } from './middleware/cors.ts';
import { errorResponse } from './middleware/error.ts';
import { loadServerConfig, type ServerConfig } from './config.ts';
import type { SessionPool } from './services/session-pool.ts';
import type { ClientRegistry } from './transport/client-registry.ts';

// Route handlers
import { handleHealth } from './routes/health.ts';
import { handleWebhookRoute } from './routes/hooks.ts'; // fork(PLAN-014)
import type { WebhooksHandle } from './webhooks/init.ts'; // fork(PLAN-014)
import { handleListWorkspaces, handleListSources } from './routes/workspaces.ts';
import {
  handleCreateSession,
  handleListSessions,
  handleGetSession,
  handleDeleteSession,
  handleSendMessage,
  handleAbort,
  handleSessionEvents,
  handleGetPending,
  handleRespondPermission,
} from './routes/sessions.ts';

/**
 * Parse a URL path and extract route parameters.
 */
function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  if (pathParts.length !== patternParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return params;
}

/**
 * Create the request router.
 */
export function createRouter(pool: SessionPool, registry?: ClientRegistry, webhooks?: WebhooksHandle) {
  return async function router(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return handlePreflight();
    }

    // Health check (no auth required)
    if (method === 'GET' && path === '/health') {
      return handleHealth(pool, registry);
    }

    // fork(PLAN-014): inbound webhook receiver — an unauthenticated route class
    // (providers can't send our craft_sk_ bearer). Security = capability URL +
    // optional HMAC. Registered BEFORE the auth gate, like /health.
    if (method === 'POST' && webhooks) {
      const hookParams = matchRoute(path, '/hooks/:workspace/:hookSlug/:token');
      if (hookParams) {
        return handleWebhookRoute(
          request,
          { workspace: hookParams.workspace, hookSlug: hookParams.hookSlug, token: hookParams.token },
          webhooks,
        );
      }
    }

    // All other routes require authentication
    const config = loadServerConfig();
    const authResult = authenticate(request, config);
    if ('error' in authResult) {
      return authResult.error;
    }
    const auth: AuthContext = authResult.auth;

    // --- Workspace routes ---
    if (method === 'GET' && path === '/api/workspaces') {
      return handleListWorkspaces(auth);
    }

    let params = matchRoute(path, '/api/workspaces/:id/sources');
    if (method === 'GET' && params) {
      return handleListSources(params.id, auth);
    }

    // --- Session routes ---
    if (method === 'POST' && path === '/api/sessions') {
      return handleCreateSession(request, auth, pool, config);
    }

    if (method === 'GET' && path === '/api/sessions') {
      return handleListSessions(auth, pool, url.searchParams);
    }

    params = matchRoute(path, '/api/sessions/:id');
    if (params) {
      if (method === 'GET') return handleGetSession(params.id, auth, pool);
      if (method === 'DELETE') return handleDeleteSession(params.id, auth, pool);
    }

    params = matchRoute(path, '/api/sessions/:id/messages');
    if (method === 'POST' && params) {
      return handleSendMessage(request, params.id, auth, pool);
    }

    params = matchRoute(path, '/api/sessions/:id/abort');
    if (method === 'POST' && params) {
      return handleAbort(params.id, auth, pool);
    }

    params = matchRoute(path, '/api/sessions/:id/events');
    if (method === 'GET' && params) {
      return handleSessionEvents(params.id, auth, pool);
    }

    params = matchRoute(path, '/api/sessions/:id/pending');
    if (method === 'GET' && params) {
      return handleGetPending(params.id, auth, pool);
    }

    params = matchRoute(path, '/api/sessions/:id/permissions');
    if (method === 'POST' && params) {
      return handleRespondPermission(request, params.id, auth, pool);
    }

    // 404
    return errorResponse(404, `Route not found: ${method} ${path}`);
  };
}
