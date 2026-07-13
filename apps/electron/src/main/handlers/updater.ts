/**
 * fork(PLAN-018 / ADR-0009): craft-fork:updates:* IPC handlers.
 *
 * Main-process-only (LOCAL_ONLY) — the updater feed override lives on the local
 * machine and drives electron-updater directly. GET returns the resolved config
 * (defaults applied); SET validates, persists, and re-applies the feed to
 * electron-updater so the NEXT check uses it — no restart required.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { loadUpdaterConfig, saveUpdaterConfig, type UpdaterConfig } from '@craft-agent/shared/config'
import type { RpcServer } from '@craft-agent/server-core/transport'

export const UPDATER_HANDLED_CHANNELS = [
  RPC_CHANNELS.updater.GET_FEED_CONFIG,
  RPC_CHANNELS.updater.SET_FEED_CONFIG,
] as const

export function registerUpdaterHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.updater.GET_FEED_CONFIG, async (): Promise<UpdaterConfig> => {
    return loadUpdaterConfig()
  })

  server.handle(RPC_CHANNELS.updater.SET_FEED_CONFIG, async (_ctx, config: unknown): Promise<UpdaterConfig> => {
    // saveUpdaterConfig validates and throws on bad input — the rejection crosses
    // IPC to the renderer's client-side error handling.
    const saved = saveUpdaterConfig(config)
    // Re-apply to electron-updater so the next check uses the new feed. Lazy import
    // keeps this handler free of the electron-updater pull-in until it's needed.
    const { applyUpdaterFeedConfig } = await import('../auto-update')
    applyUpdaterFeedConfig()
    return saved
  })
}
