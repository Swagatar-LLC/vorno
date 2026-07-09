/**
 * fork(PLAN-014): craft-fork:webhooks:* IPC handlers.
 *
 * Main-process-only (LOCAL_ONLY): hook CRUD is a read-modify-write against the
 * target workspace's automations.json. All the logic (validated single-writer,
 * token mint, delivery reads) lives in `@craft-agent/shared/automations`
 * (webhook-management); this handler is a thin adapter that resolves the
 * workspace, composes the ingest URL from the trigger-server config, and returns
 * token plaintext exactly once (create / rotate) — never persisting it.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  listWebhooks,
  upsertWebhook,
  revokeWebhookToken,
  readWebhookDeliveries,
  type WebhookSummary,
} from '@craft-agent/shared/automations'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type {
  WebhookView,
  WebhookMutationResult,
  WebhookUpsertRequest,
  WebhookRevokeAction,
} from '../../shared/types'

export const WEBHOOKS_HANDLED_CHANNELS = [
  RPC_CHANNELS.webhooks.LIST,
  RPC_CHANNELS.webhooks.UPSERT,
  RPC_CHANNELS.webhooks.REVOKE,
  RPC_CHANNELS.webhooks.DELIVERIES,
] as const

/** Injected accessor for the local trigger-server host/port (for URL display). */
export interface WebhooksHandlerDeps {
  getServerConfig(): { host: string; port: number }
}

function resolveWorkspaceOrThrow(workspaceId: string): { name: string; rootPath: string } {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
  return { name: workspace.name, rootPath: workspace.rootPath }
}

function baseUrl(deps: WebhooksHandlerDeps): string {
  const { host, port } = deps.getServerConfig()
  // 0.0.0.0 / :: bind-all addresses aren't dialable — show loopback for copy.
  const dialHost = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host
  return `http://${dialHost}:${port}`
}

function toView(summary: WebhookSummary, deps: WebhooksHandlerDeps): WebhookView {
  return { ...summary, ingestUrl: `${baseUrl(deps)}${summary.ingestPath}` }
}

export function registerWebhooksHandlers(server: RpcServer, deps: WebhooksHandlerDeps): void {
  server.handle(RPC_CHANNELS.webhooks.LIST, async (_ctx, workspaceId: string) => {
    const ws = resolveWorkspaceOrThrow(workspaceId)
    return listWebhooks(ws.rootPath, ws.name).map((s) => toView(s, deps))
  })

  server.handle(RPC_CHANNELS.webhooks.UPSERT, async (_ctx, request: WebhookUpsertRequest) => {
    if (!request?.workspaceId) throw new Error('workspaceId is required')
    if (!request.slug) throw new Error('slug is required')
    if (!request.name) throw new Error('name is required')
    const ws = resolveWorkspaceOrThrow(request.workspaceId)
    const { webhook, token } = await upsertWebhook(ws.rootPath, ws.name, {
      id: request.id,
      name: request.name,
      slug: request.slug,
      matcher: request.matcher,
      matchField: request.matchField,
      permissionMode: request.permissionMode,
      labels: request.labels,
      enabled: request.enabled,
      actions: request.actions,
    })
    return buildMutationResult(webhook, token, deps)
  })

  server.handle(
    RPC_CHANNELS.webhooks.REVOKE,
    async (_ctx, workspaceId: string, id: string, action: WebhookRevokeAction) => {
      if (action !== 'rotate' && action !== 'clear') {
        throw new Error(`Invalid revoke action: ${String(action)} (expected rotate | clear)`)
      }
      const ws = resolveWorkspaceOrThrow(workspaceId)
      const { webhook, token } = await revokeWebhookToken(ws.rootPath, ws.name, id, action)
      return buildMutationResult(webhook, token, deps)
    },
  )

  server.handle(
    RPC_CHANNELS.webhooks.DELIVERIES,
    async (_ctx, workspaceId: string, hookId: string, limit?: number) => {
      const ws = resolveWorkspaceOrThrow(workspaceId)
      return readWebhookDeliveries(ws.rootPath, hookId, limit)
    },
  )
}

function buildMutationResult(
  summary: WebhookSummary,
  token: string | undefined,
  deps: WebhooksHandlerDeps,
): WebhookMutationResult {
  const view = toView(summary, deps)
  const result: WebhookMutationResult = { webhook: view }
  if (token) {
    result.token = token
    result.tokenUrl = `${view.ingestUrl}/${token}`
  }
  return result
}
