/**
 * Memory provider capabilities RPC (fork: PLAN-040 / SUV-0029 + SUV-0040;
 * ADR-0031).
 *
 * One read channel, and the answer is always the provider's own `describe()`.
 * That indirection is the point rather than an implementation detail: ADR-0031
 * forbids any call site outside the registry from branching on a provider id,
 * so a settings surface that wants to warn "this one is lexical, not semantic"
 * or "this one needs an ~86 MB model download before it works" cannot hold a
 * lookup table — it has to ask. Every claim rendered downstream therefore comes
 * from the code that would have to honour it.
 *
 * Two things this handler deliberately does *not* do:
 *
 * - It does not cache. Capabilities are a live property of the host filesystem
 *   (store present? interpreter present? embedder provisioned?), and a cached
 *   "unprovisioned" that survives the user fixing the provisioning is worse
 *   than a cheap re-probe. The construct-describe-dispose cycle is short-lived
 *   by design.
 * - It does not persist anything. Memory *configuration* is written through
 *   `workspaceSettings:update` like every other workspace setting, which is why
 *   this namespace has exactly one channel and it is read-only.
 */

import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { MemoryProviderCapabilities } from '@craft-agent/core/types'

/**
 * The answer when we could not get as far as asking a provider.
 *
 * `state: 'absent'` rather than an error response, because the seam's contract
 * is that memory never takes a caller down (`memory-provider.ts`: "Memory is an
 * enrichment; a memory failure must never take down a session") — and a
 * settings screen that throws while explaining why memory is unavailable is the
 * same failure wearing a different hat.
 *
 * `absent` and not `unprovisioned` specifically: `unprovisioned` is a claim
 * about a provider we reached and found half-installed, which is exactly what
 * we did not manage to do here. Every capability flag is `false` and the reason
 * goes in `notes`, which is the field the UI already renders verbatim.
 */
function undescribable(providerId: string, reason: string): MemoryProviderCapabilities {
  return {
    providerId,
    state: 'absent',
    summary: 'Memory capabilities could not be determined.',
    search: 'none',
    scopeLayers: [],
    structuredReads: false,
    supersession: false,
    decay: false,
    archive: false,
    retrievalLog: false,
    requiresProvisioning: false,
    egress: 'none',
    notes: [reason],
  }
}

export function registerMemoryHandlers(server: RpcServer, _deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.memory.CAPABILITIES_GET,
    async (_ctx, workspaceId: string): Promise<MemoryProviderCapabilities> => {
      // Resolved the same way the settings handler resolves it, so the config
      // this describes is the config that screen is editing.
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) {
        return undescribable('unknown', `Workspace not found: ${workspaceId}`)
      }

      // Dynamic imports keep the memory + workspace-config subtrees (and the fs
      // work they do at module scope) out of every host that never asks.
      try {
        const { loadEffectiveMemoryConfig } = await import('@craft-agent/shared/workspaces')
        const { createMemoryProvider } = await import('@craft-agent/shared/memory')

        const config = loadEffectiveMemoryConfig(workspace.rootPath)
        const provider = createMemoryProvider(config, { workspaceRootPath: workspace.rootPath })
        try {
          // `describe()` is non-throwing by contract; the try/finally is here
          // for the dispose, not as a trust boundary. A provider that reneges
          // still lands in the outer catch rather than rejecting the RPC.
          return await provider.describe()
        } finally {
          // Swallowed separately: a failed teardown must not turn a successful
          // description into "absent". The subprocess leak is the lesser bug.
          try {
            await provider.dispose?.()
          } catch {
            /* dispose is documented idempotent + non-throwing; belt and braces */
          }
        }
      } catch (error) {
        return undescribable('unknown', String(error))
      }
    },
  )
}
