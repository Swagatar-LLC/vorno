/**
 * Artifact-plane RPC handlers (ADR-0016, ADR-0015 / DIR-04, PLAN-025 C1).
 *
 * Maps the seven `vorno:artifacts:*` channels onto the generalized artifact
 * plane (`@craft-agent/shared/artifacts`). Artifacts are addressed by
 * `vorno-artifact://` URI in payloads — never absolute paths (ADR-0016 §2).
 * The workspace is resolved from the request context (the workbench.ts idiom),
 * root bindings come from workspace config (`defaults.artifactRoots`), and all
 * validation is server-authoritative.
 *
 * Handlers are registered unconditionally like every other group; the
 * `artifactsEnabled` flag gates the UI only (established pattern, PR #104 A2).
 */

import { basename } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  ArtifactsIndexRequest,
  ArtifactsIndexResult,
  ArtifactsReadRequest,
  ArtifactsReadResult,
  ArtifactsRelationsListRequest,
  ArtifactsRelationsListResult,
  ArtifactsRelationsMutateRequest,
  ArtifactsRelationsMutateResult,
  ArtifactsLifecycleSetRequest,
  ArtifactsLifecycleSetResult,
  ArtifactsRootsListResult,
  ArtifactsTypesListResult,
} from '@craft-agent/shared/protocol'
import type { ArtifactEntry } from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { RpcServer, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.artifacts.INDEX,
  RPC_CHANNELS.artifacts.READ,
  RPC_CHANNELS.artifacts.RELATIONS_LIST,
  RPC_CHANNELS.artifacts.RELATIONS_MUTATE,
  RPC_CHANNELS.artifacts.LIFECYCLE_SET,
  RPC_CHANNELS.artifacts.ROOTS_LIST,
  RPC_CHANNELS.artifacts.TYPES_LIST,
] as const

export function registerArtifactsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  /**
   * Resolve the request context to a workspace root path. Returns null when no
   * workspace is in context or the id does not resolve (workbench.ts idiom).
   */
  function resolveWorkspaceRoot(ctx: RequestContext): string | null {
    const workspaceId =
      ctx.workspaceId ??
      (ctx.webContentsId != null
        ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
        : undefined)
    if (!workspaceId) return null
    const workspace = getWorkspaceByNameOrId(workspaceId)
    return workspace?.rootPath ?? null
  }

  /** Load the configured (non-workspace) root bindings from workspace config. */
  async function loadConfiguredRoots(
    workspaceRoot: string,
  ): Promise<Record<string, string> | undefined> {
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspaceRoot)
    return config?.defaults?.artifactRoots
  }

  // Index artifacts visible to the workspace (zero-config sessions + configured
  // roots), applying server-side filters.
  server.handle(
    RPC_CHANNELS.artifacts.INDEX,
    async (ctx, req: ArtifactsIndexRequest): Promise<ArtifactsIndexResult> => {
      const workspaceRoot = resolveWorkspaceRoot(ctx)
      if (!workspaceRoot) {
        log.error('ARTIFACTS_INDEX: no workspace in context')
        return { artifacts: [], skippedRoots: [] }
      }
      const configuredRoots = await loadConfiguredRoots(workspaceRoot)
      const { indexArtifacts } = await import('@craft-agent/shared/artifacts')
      const filters = req?.filters
      const { artifacts, skippedRoots } = indexArtifacts({
        workspaceRootPath: workspaceRoot,
        configuredRoots,
        includeArchived: filters?.includeArchived,
      })

      const filtered = filters ? artifacts.filter((a) => matchesFilters(a, filters)) : artifacts
      return { artifacts: filtered, skippedRoots }
    },
  )

  // Read one artifact by URI (containment ∧ (indexed ∨ pinned) gate lives in the
  // shared module). Returns { ok: false, reason: 'not-found' } for denied/missing.
  server.handle(
    RPC_CHANNELS.artifacts.READ,
    async (ctx, req: ArtifactsReadRequest): Promise<ArtifactsReadResult> => {
      const workspaceRoot = resolveWorkspaceRoot(ctx)
      if (!workspaceRoot) return { ok: false, reason: 'not-found' }
      if (!req || typeof req.uri !== 'string' || !req.uri) return { ok: false, reason: 'not-found' }

      const configuredRoots = await loadConfiguredRoots(workspaceRoot)
      const { readArtifactByUri, getArtifactTypeForPath } = await import('@craft-agent/shared/artifacts')
      const result = await readArtifactByUri({
        workspaceRootPath: workspaceRoot,
        configuredRoots,
        uri: req.uri,
      })
      if (!result) return { ok: false, reason: 'not-found' }

      // Stamp type + title. Type resolves off the resolved path's extension;
      // title is the basename here.
      // ponytail: full title extraction (frontmatter/first-heading) lives in the
      // index — read serves the cheap basename to stay allocation-light.
      const type = getArtifactTypeForPath(result.absPath || req.uri)
      const title = basename(result.absPath || req.uri)
      return {
        ok: true,
        uri: result.uri,
        content: result.content,
        version: result.version,
        type,
        title,
      }
    },
  )

  // List relations, optionally filtered to those touching one URI.
  server.handle(
    RPC_CHANNELS.artifacts.RELATIONS_LIST,
    async (ctx, req: ArtifactsRelationsListRequest): Promise<ArtifactsRelationsListResult> => {
      const workspaceRoot = resolveWorkspaceRoot(ctx)
      if (!workspaceRoot) return { relations: [] }
      const { listRelations } = await import('@craft-agent/shared/artifacts')
      return { relations: listRelations(workspaceRoot, req?.uri) }
    },
  )

  // Mutate a relation edge (add / remove). Command shape is validated server-side.
  server.handle(
    RPC_CHANNELS.artifacts.RELATIONS_MUTATE,
    async (ctx, req: ArtifactsRelationsMutateRequest): Promise<ArtifactsRelationsMutateResult> => {
      const workspaceRoot = resolveWorkspaceRoot(ctx)
      if (!workspaceRoot) return { ok: false, reason: 'not-found' }

      const command = req?.command
      if (!command || typeof command !== 'object') return { ok: false, reason: 'invalid-payload' }

      const { addRelation, removeRelation, parseArtifactUri } = await import(
        '@craft-agent/shared/artifacts'
      )

      try {
        switch (command.type) {
          case 'add': {
            if (
              typeof command.from !== 'string' ||
              typeof command.to !== 'string' ||
              typeof command.kind !== 'string' ||
              !command.kind
            ) {
              return { ok: false, reason: 'invalid-payload' }
            }
            // Both endpoints must be well-formed `vorno-artifact://` URIs.
            if (!parseArtifactUri(command.from) || !parseArtifactUri(command.to)) {
              return { ok: false, reason: 'invalid-payload' }
            }
            const result = addRelation(workspaceRoot, {
              from: command.from,
              to: command.to,
              kind: command.kind,
              note: command.note,
            })
            if (result.ok) return { ok: true, relation: result.relation }
            return { ok: false, reason: result.reason }
          }
          case 'remove': {
            if (typeof command.relationId !== 'string' || !command.relationId) {
              return { ok: false, reason: 'invalid-payload' }
            }
            const removed = removeRelation(workspaceRoot, command.relationId)
            if (!removed) return { ok: false, reason: 'not-found' }
            return { ok: true }
          }
          default:
            return { ok: false, reason: 'invalid-payload' }
        }
      } catch (error) {
        log.error('ARTIFACTS_RELATIONS_MUTATE: write failed', error)
        return { ok: false, reason: 'write-failed' }
      }
    },
  )

  // Pin/archive a single artifact by URI.
  server.handle(
    RPC_CHANNELS.artifacts.LIFECYCLE_SET,
    async (ctx, req: ArtifactsLifecycleSetRequest): Promise<ArtifactsLifecycleSetResult> => {
      const workspaceRoot = resolveWorkspaceRoot(ctx)
      if (!workspaceRoot) return { ok: false, reason: 'write-failed' }

      const { parseArtifactUri, setArtifactState } = await import('@craft-agent/shared/artifacts')

      if (!req || typeof req.uri !== 'string' || !parseArtifactUri(req.uri)) {
        return { ok: false, reason: 'invalid-payload' }
      }
      const patch = req.patch
      if (!patch || typeof patch !== 'object') return { ok: false, reason: 'invalid-payload' }
      const hasPinned = typeof patch.pinned === 'boolean'
      const hasArchived = typeof patch.archived === 'boolean'
      if (!hasPinned && !hasArchived) return { ok: false, reason: 'invalid-payload' }

      try {
        setArtifactState(workspaceRoot, req.uri, {
          ...(hasPinned ? { pinned: patch.pinned } : {}),
          ...(hasArchived ? { archived: patch.archived } : {}),
        })
        return { ok: true }
      } catch (error) {
        log.error('ARTIFACTS_LIFECYCLE_SET: write failed', error)
        return { ok: false, reason: 'write-failed' }
      }
    },
  )

  // List root binding ids + kinds only — NEVER absolute paths (ADR-0016 §2).
  server.handle(
    RPC_CHANNELS.artifacts.ROOTS_LIST,
    async (ctx): Promise<ArtifactsRootsListResult> => {
      const workspaceRoot = resolveWorkspaceRoot(ctx)
      if (!workspaceRoot) return { roots: [] }
      const configuredRoots = await loadConfiguredRoots(workspaceRoot)
      const { resolveRootBindings } = await import('@craft-agent/shared/artifacts')
      const bindings = resolveRootBindings(workspaceRoot, configuredRoots)
      const roots = Array.from(bindings.entries()).map(([id, binding]) => ({
        id,
        kind: binding.kind,
      }))
      return { roots }
    },
  )

  // List the open type-registry descriptors.
  server.handle(
    RPC_CHANNELS.artifacts.TYPES_LIST,
    async (): Promise<ArtifactsTypesListResult> => {
      const { listArtifactTypes } = await import('@craft-agent/shared/artifacts')
      return { types: listArtifactTypes() }
    },
  )
}

/**
 * Apply the index filters server-side: type exact, projectId exact,
 * label ∈ origin.labels, sessionStatus exact, originKind exact. Missing filter
 * fields are ignored. `includeArchived` is honored inside `indexArtifacts`.
 */
function matchesFilters(
  a: ArtifactEntry,
  filters: NonNullable<ArtifactsIndexRequest['filters']>,
): boolean {
  if (filters.type !== undefined && a.type !== filters.type) return false
  if (filters.projectId !== undefined && a.origin.projectId !== filters.projectId) return false
  if (filters.originKind !== undefined && a.origin.kind !== filters.originKind) return false
  if (filters.sessionStatus !== undefined && a.origin.sessionStatus !== filters.sessionStatus) {
    return false
  }
  if (filters.label !== undefined) {
    const labels = a.origin.labels ?? []
    if (!labels.includes(filters.label)) return false
  }
  return true
}
