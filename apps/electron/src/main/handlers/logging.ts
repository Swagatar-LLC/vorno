/**
 * fork(PLAN-015): craft-fork:logging:* IPC handlers.
 *
 * Main-process-only (LOCAL_ONLY) because the log level and log files belong to
 * the local machine's main process. SET_LEVEL persists to the app config and
 * applies to the live file transport immediately — no restart. The reveal/open
 * actions use Electron shell so the user can hand a log file to support tools.
 */

import { shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { isLogLevel } from '@craft-agent/shared/logging'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { getLogDirectory, getLogFilePath, getLoggingState, mainLog, setRuntimeLogLevel } from '../logger'

export const LOGGING_HANDLED_CHANNELS = [
  RPC_CHANNELS.logging.GET_STATE,
  RPC_CHANNELS.logging.SET_LEVEL,
  RPC_CHANNELS.logging.OPEN_LOG_FOLDER,
  RPC_CHANNELS.logging.REVEAL_LOG_FILE,
] as const

export function registerLoggingHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.logging.GET_STATE, async () => {
    return getLoggingState()
  })

  server.handle(RPC_CHANNELS.logging.SET_LEVEL, async (_ctx, level: unknown) => {
    if (!isLogLevel(level)) {
      throw new Error(`Invalid log level: ${String(level)} (expected error | warn | info | debug)`)
    }
    setRuntimeLogLevel(level)
    // Written at info so the level change itself is visible in the log trail.
    mainLog.info(`[logging] log level set to ${level}`)
    return getLoggingState()
  })

  server.handle(RPC_CHANNELS.logging.OPEN_LOG_FOLDER, async () => {
    const dir = getLogDirectory()
    mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  })

  server.handle(RPC_CHANNELS.logging.REVEAL_LOG_FILE, async () => {
    const file = getLogFilePath()
    if (file && existsSync(file)) {
      shell.showItemInFolder(file)
      return
    }
    // No file yet today (nothing logged at/above the level) — open the folder.
    const dir = getLogDirectory()
    mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  })
}
