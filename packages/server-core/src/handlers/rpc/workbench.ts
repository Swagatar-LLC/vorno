/**
 * Review Workbench RPC handlers (ADR-0014, PLAN-024)
 *
 * Maps the seven `vorno:workbench:review:*` channels onto the workspace review
 * store (`@craft-agent/shared/workbench`). Workbench instances are addressed by
 * `workbenchId` in payloads; the workspace itself is resolved from the request
 * context (the sessions.ts idiom), never carried in the channel name.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  WorkbenchInstanceCreateRequest,
  WorkbenchInstanceUpdateRequest,
  WorkbenchArtifactIndexRequest,
  WorkbenchArtifactIndexResult,
  WorkbenchArtifactReadRequest,
  WorkbenchArtifactReadResult,
  WorkbenchThreadsListRequest,
  WorkbenchThreadsMutateRequest,
  WorkbenchThreadMutationResult,
} from '@craft-agent/shared/protocol'
import type {
  ReviewThreadV1,
  WorkbenchInstanceV1,
} from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { RpcServer, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workbench.REVIEW_INSTANCES_LIST,
  RPC_CHANNELS.workbench.REVIEW_INSTANCES_CREATE,
  RPC_CHANNELS.workbench.REVIEW_INSTANCES_UPDATE,
  RPC_CHANNELS.workbench.REVIEW_ARTIFACTS_INDEX,
  RPC_CHANNELS.workbench.REVIEW_ARTIFACTS_READ,
  RPC_CHANNELS.workbench.REVIEW_THREADS_LIST,
  RPC_CHANNELS.workbench.REVIEW_THREADS_MUTATE,
] as const

export function registerWorkbenchHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  /**
   * Resolve the request context to a workspace root path. Returns null when no
   * workspace is in context or the id does not resolve to a workspace.
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

  // List all workbench instances in the workspace.
  server.handle(
    RPC_CHANNELS.workbench.REVIEW_INSTANCES_LIST,
    async (ctx): Promise<WorkbenchInstanceV1[]> => {
      const root = resolveWorkspaceRoot(ctx)
      if (!root) {
        log.error('WORKBENCH_INSTANCES_LIST: no workspace in context')
        return []
      }
      const { listWorkbenchInstances } = await import('@craft-agent/shared/workbench')
      return listWorkbenchInstances(root)
    },
  )

  // Create a new review workbench instance.
  server.handle(
    RPC_CHANNELS.workbench.REVIEW_INSTANCES_CREATE,
    async (ctx, req: WorkbenchInstanceCreateRequest): Promise<WorkbenchInstanceV1> => {
      const root = resolveWorkspaceRoot(ctx)
      if (!root) throw new Error('No workspace context')
      const { createWorkbenchInstance } = await import('@craft-agent/shared/workbench')
      const instance = createWorkbenchInstance(root, {
        title: req.title?.trim() || 'New Review',
        corpusRoots: req.corpusRoots,
        artifactUris: req.artifactUris,
        boundSessionId: req.boundSessionId,
      })
      log.info(`Created review workbench: ${instance.id}`)
      return instance
    },
  )

  // Update a workbench instance (additive patch; arrays replace wholesale).
  server.handle(
    RPC_CHANNELS.workbench.REVIEW_INSTANCES_UPDATE,
    async (ctx, req: WorkbenchInstanceUpdateRequest): Promise<WorkbenchInstanceV1 | null> => {
      const root = resolveWorkspaceRoot(ctx)
      if (!root) throw new Error('No workspace context')
      const { updateWorkbenchInstance } = await import('@craft-agent/shared/workbench')
      const updated = updateWorkbenchInstance(root, req.workbenchId, req.patch)
      if (!updated) log.warn(`WORKBENCH_INSTANCES_UPDATE: not found ${req.workbenchId}`)
      return updated
    },
  )

  // Index artifacts visible to a workbench (corpus roots + session outputs + pins).
  server.handle(
    RPC_CHANNELS.workbench.REVIEW_ARTIFACTS_INDEX,
    async (ctx, req: WorkbenchArtifactIndexRequest): Promise<WorkbenchArtifactIndexResult> => {
      const root = resolveWorkspaceRoot(ctx)
      if (!root) return { artifacts: [], skippedRoots: [] }
      const { loadWorkbenchInstance, indexArtifacts } = await import(
        '@craft-agent/shared/workbench'
      )
      const instance = loadWorkbenchInstance(root, req.workbenchId)
      if (!instance) {
        log.warn(`WORKBENCH_ARTIFACTS_INDEX: workbench not found ${req.workbenchId}`)
        return { artifacts: [], skippedRoots: [] }
      }
      return indexArtifacts(root, instance)
    },
  )

  // Read one artifact (containment-enforced). Returns null for not-found/denied.
  server.handle(
    RPC_CHANNELS.workbench.REVIEW_ARTIFACTS_READ,
    async (ctx, req: WorkbenchArtifactReadRequest): Promise<WorkbenchArtifactReadResult | null> => {
      const root = resolveWorkspaceRoot(ctx)
      if (!root) return null
      const { loadWorkbenchInstance, readArtifact } = await import(
        '@craft-agent/shared/workbench'
      )
      const instance = loadWorkbenchInstance(root, req.workbenchId)
      if (!instance) {
        log.warn(`WORKBENCH_ARTIFACTS_READ: workbench not found ${req.workbenchId}`)
        return null
      }
      const result = await readArtifact(root, instance, req.uri)
      if (!result) return null
      return { ref: result.ref, content: result.content, version: result.version }
    },
  )

  // List review threads for a workbench (optionally filtered to one artifact).
  server.handle(
    RPC_CHANNELS.workbench.REVIEW_THREADS_LIST,
    async (ctx, req: WorkbenchThreadsListRequest): Promise<ReviewThreadV1[]> => {
      const root = resolveWorkspaceRoot(ctx)
      if (!root) return []
      const { listThreads } = await import('@craft-agent/shared/workbench')
      return listThreads(root, req.workbenchId, req.artifactUri)
    },
  )

  // Mutate a review thread (add / update / remove).
  server.handle(
    RPC_CHANNELS.workbench.REVIEW_THREADS_MUTATE,
    async (
      ctx,
      req: WorkbenchThreadsMutateRequest,
    ): Promise<WorkbenchThreadMutationResult> => {
      const root = resolveWorkspaceRoot(ctx)
      if (!root) return { ok: false, reason: 'workbench-not-found' }

      const { workbenchId, command } = req ?? ({} as WorkbenchThreadsMutateRequest)
      if (!workbenchId || typeof workbenchId !== 'string' || !command || typeof command !== 'object') {
        return { ok: false, reason: 'invalid-payload' }
      }

      const {
        loadWorkbenchInstance,
        addThread,
        updateThread,
        removeThread,
      } = await import('@craft-agent/shared/workbench')

      const instance = loadWorkbenchInstance(root, workbenchId)
      if (!instance) return { ok: false, reason: 'workbench-not-found' }

      try {
        switch (command.type) {
          case 'add': {
            const thread = command.thread
            if (!thread || typeof thread.id !== 'string' || !thread.id) {
              return { ok: false, reason: 'invalid-payload' }
            }
            // Bind the thread to this workbench (server is authoritative on scope).
            const added = addThread(root, { ...thread, workbenchId })
            if (!added) return { ok: false, reason: 'duplicate-id' }
            return { ok: true, thread: added }
          }
          case 'update': {
            if (typeof command.threadId !== 'string' || !command.threadId || !command.patch) {
              return { ok: false, reason: 'invalid-payload' }
            }
            const updated = updateThread(root, workbenchId, command.threadId, command.patch)
            if (!updated) return { ok: false, reason: 'thread-not-found' }
            return { ok: true, thread: updated }
          }
          case 'remove': {
            if (typeof command.threadId !== 'string' || !command.threadId) {
              return { ok: false, reason: 'invalid-payload' }
            }
            const removed = removeThread(root, workbenchId, command.threadId)
            if (!removed) return { ok: false, reason: 'thread-not-found' }
            return { ok: true }
          }
          default:
            return { ok: false, reason: 'invalid-payload' }
        }
      } catch (error) {
        log.error('WORKBENCH_THREADS_MUTATE: write failed', error)
        return { ok: false, reason: 'write-failed' }
      }
    },
  )
}
