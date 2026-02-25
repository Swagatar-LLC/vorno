import { getWorkspaces, getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { loadAllSources, getSourcesNeedingAuth } from '@craft-agent/shared/sources';
import { jsonResponse, errorResponse } from '../middleware/error.ts';
import { hasWorkspaceAccess, type AuthContext } from '../middleware/auth.ts';

/**
 * GET /api/workspaces — List all workspaces
 */
export function handleListWorkspaces(auth: AuthContext): Response {
  const workspaces = getWorkspaces();
  const accessible = workspaces.filter(ws => hasWorkspaceAccess(auth, ws.id));

  return jsonResponse(accessible.map(ws => ({
    id: ws.id,
    name: ws.name,
    rootPath: ws.rootPath,
  })));
}

/**
 * GET /api/workspaces/:id/sources — List sources for a workspace
 */
export function handleListSources(workspaceId: string, auth: AuthContext): Response {
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return errorResponse(403, 'Access denied to this workspace');
  }

  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) {
    return errorResponse(404, `Workspace '${workspaceId}' not found`);
  }

  const sources = loadAllSources(workspace.rootPath);
  const needsAuth = getSourcesNeedingAuth(sources);
  const needsAuthSlugs = new Set(needsAuth.map(s => s.config.slug));

  return jsonResponse(sources.map(s => ({
    slug: s.config.slug,
    name: s.config.name,
    type: s.config.type,
    enabled: s.config.enabled,
    isAuthenticated: s.config.isAuthenticated,
    needsAuth: needsAuthSlugs.has(s.config.slug),
    provider: s.config.provider,
    tagline: s.config.tagline,
  })));
}
