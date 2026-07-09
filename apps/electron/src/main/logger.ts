import log from 'electron-log/main'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
// fork(PLAN-015): production file logging
import {
  dailyLogFileName,
  formatLogLine,
  nextArchiveFileName,
  pruneDailyLogs,
  redactSecrets,
  resolveLogLevel,
  type LogLevel,
} from '@craft-agent/shared/logging'
import { getLogLevel, setLogLevel } from '@craft-agent/shared/config/storage'
import type {
  MessagingLogContext,
  MessagingLogMeta,
  MessagingLogger,
} from '@craft-agent/messaging-gateway'

/**
 * Resolve debug mode deterministically across runtimes.
 *
 * Priority:
 * 1) --debug flag always enables debug mode
 * 2) CRAFT_IS_PACKAGED env (when explicitly set)
 * 3) Electron runtime heuristic (defaultApp => dev, otherwise packaged)
 * 4) Non-Electron runtimes default to debug mode (headless Bun / node --check)
 */
function resolveDebugMode(): boolean {
  if (process.argv.includes('--debug')) return true

  const packagedEnv = process.env.CRAFT_IS_PACKAGED
  if (packagedEnv === 'true') return false
  if (packagedEnv === 'false') return true

  const isElectronRuntime = typeof process.versions?.electron === 'string'
  if (isElectronRuntime) {
    if (process.defaultApp) return true
    return false
  }

  return true
}

export const isDebugMode = resolveDebugMode()

// fork(PLAN-015): production log location and retention policy.
// CONFIG_DIR/logs (ADR-0005) — same folder as the messaging-gateway and
// auto-update dedicated logs, so all field diagnostics live in one place.
const PROD_LOG_DIR = join(CONFIG_DIR, 'logs')
const PROD_LOG_PREFIX = 'main'
const PROD_LOG_MAX_BYTES = 10 * 1024 * 1024 // 10 MiB per-file safety valve
const PROD_LOG_MAX_AGE_DAYS = 14

// Configure transports based on debug mode
if (isDebugMode) {
  // JSON format for file (agent-parseable)
  // Note: format expects (params: FormatParams) => any[], where params.message has the LogMessage fields
  log.transports.file.format = ({ message }) => [
    JSON.stringify({
      timestamp: message.date.toISOString(),
      level: message.level,
      scope: message.scope,
      message: message.data,
    }),
  ]

  log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB

  // Console output in debug mode with readable format
  // Note: format must return an array - electron-log's transformStyles calls .reduce() on it
  log.transports.console.format = ({ message }) => {
    const scope = message.scope ? `[${message.scope}]` : ''
    const level = message.level.toUpperCase().padEnd(5)
    const data = message.data
      .map((d: unknown) => (typeof d === 'object' ? JSON.stringify(d) : String(d)))
      .join(' ')
    return [`${message.date.toISOString()} ${level} ${scope} ${data}`]
  }
  log.transports.console.level = 'debug'
} else {
  // fork(PLAN-015): production file logging. Packaged builds used to disable
  // every transport, which left field failures — trigger-server autostart,
  // port conflicts, update errors — undiagnosable (LEARNING-015). The file
  // transport now stays ON: plain single-line text (grep/lnav-friendly) under
  // CONFIG_DIR/logs/, one file per day (resolvePathFn is consulted per
  // message, so the date rolls over naturally at midnight) with a size cap as
  // a safety valve and startup pruning by age. Level comes from the app
  // config (Settings -> Advanced; craft-fork:logging:* IPC changes it live)
  // with CRAFT_LOG_LEVEL taking precedence. Console stays off in production.
  log.transports.file.format = ({ message }) => {
    const text = message.data
      .map((d: unknown) => (typeof d === 'object' ? JSON.stringify(normalizeLogValue(d)) : String(d)))
      .join(' ')
    return [
      redactSecrets(
        formatLogLine({ date: message.date, level: message.level, scope: message.scope || undefined, text }),
      ),
    ]
  }
  log.transports.file.resolvePathFn = () =>
    join(PROD_LOG_DIR, dailyLogFileName(PROD_LOG_PREFIX, new Date()))
  log.transports.file.maxSize = PROD_LOG_MAX_BYTES
  // Size-cap archive: main-2026-07-09.log -> main-2026-07-09.1.log (never
  // clobbers an existing archive). Falls back to cropping like upstream's
  // default archiveLogFn if the rename fails.
  log.transports.file.archiveLogFn = (file) => {
    const oldPath = file.path
    const dir = dirname(oldPath)
    try {
      renameSync(oldPath, join(dir, nextArchiveFileName(dir, basename(oldPath))))
    } catch {
      // crop() exists at runtime but isn't in electron-log's LogFile typings
      try { (file as unknown as { crop?: (bytes: number) => void }).crop?.(256 * 1024) }
      catch { /* keep logging into the oversized file */ }
    }
  }
  log.transports.file.level = resolveLogLevel(process.env, getLogLevel).level
  log.transports.console.level = false

  try {
    pruneDailyLogs(PROD_LOG_DIR, { prefix: PROD_LOG_PREFIX, maxAgeDays: PROD_LOG_MAX_AGE_DAYS })
  } catch { /* housekeeping only — never block startup */ }
}

// fork(PLAN-015): runtime log-level control + state for the Settings UI.

export interface LoggingState {
  level: LogLevel
  /** True when CRAFT_LOG_LEVEL forces the level (selector disabled in UI). */
  envOverride: boolean
  /** Debug builds log everything to the dev location; the level applies to packaged builds. */
  debugMode: boolean
  logDirectory: string
  currentLogFile: string | undefined
}

export function getLoggingState(): LoggingState {
  const { level, envOverride } = resolveLogLevel(process.env, getLogLevel)
  return {
    level,
    envOverride,
    debugMode: isDebugMode,
    logDirectory: getLogDirectory(),
    currentLogFile: getLogFilePath(),
  }
}

/**
 * Persist the log level and apply it to the live file transport — no restart.
 * If CRAFT_LOG_LEVEL is set it keeps winning (the stored value still persists
 * for the next launch without the override).
 */
export function setRuntimeLogLevel(level: LogLevel): void {
  setLogLevel(level)
  if (!isDebugMode) {
    log.transports.file.level = resolveLogLevel(process.env, getLogLevel).level
  }
}

/** Directory containing the active log file (production: CONFIG_DIR/logs). */
export function getLogDirectory(): string {
  if (!isDebugMode) return PROD_LOG_DIR
  const devPath = log.transports.file.getFile()?.path
  return devPath ? dirname(devPath) : PROD_LOG_DIR
}

// Export scoped loggers for different modules
export const mainLog = log.scope('main')
export const sessionLog = log.scope('session')
export const handlerLog = log.scope('handler')
export const windowLog = log.scope('window')
export const agentLog = log.scope('agent')
export const searchLog = log.scope('search')

/**
 * Dedicated messaging gateway log.
 *
 * Kept outside the Electron-managed logs folder so messaging issues can be
 * inspected independently at a stable path across debug and production builds.
 */
export const messagingGatewayLogPath = join(CONFIG_DIR, 'logs', 'messaging-gateway.log')
const messagingGatewayBackupPath = `${messagingGatewayLogPath}.1`
const MESSAGING_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5MB

function ensureMessagingLogDir(): void {
  mkdirSync(dirname(messagingGatewayLogPath), { recursive: true })
}

function rotateMessagingLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(messagingGatewayLogPath)) return
  try {
    const currentSize = statSync(messagingGatewayLogPath).size
    if (currentSize + nextLineBytes <= MESSAGING_LOG_MAX_BYTES) return
    if (existsSync(messagingGatewayBackupPath)) {
      rmSync(messagingGatewayBackupPath, { force: true })
    }
    renameSync(messagingGatewayLogPath, messagingGatewayBackupPath)
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to rotate dedicated log file', normalizeLogValue(error))
  }
}

function normalizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = normalizeLogValue(cause, depth + 1)
    if (value.stack) out.stack = value.stack
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeLogValue(inner, depth + 1)
    }
    return out
  }
  return value
}

function normalizeMeta(meta?: MessagingLogMeta): Record<string, unknown> {
  if (!meta) return {}
  const normalized = normalizeLogValue(meta)
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { meta: normalized }
}

function writeMessagingGatewayLog(
  level: 'info' | 'warn' | 'error',
  context: MessagingLogContext,
  message: string,
  meta?: MessagingLogMeta,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'messaging-gateway',
    ...context,
    ...normalizeMeta(meta),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  try {
    ensureMessagingLogDir()
    rotateMessagingLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(messagingGatewayLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to write dedicated log entry', {
      error: normalizeLogValue(error),
      attemptedEntry: entry,
    })
  }

  if (level === 'error') {
    mainLog.error('[messaging-gateway]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[messaging-gateway]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[messaging-gateway]', message, entry)
  }
}

class StructuredMessagingGatewayLogger implements MessagingLogger {
  constructor(private readonly context: MessagingLogContext = {}) {}

  child(context: MessagingLogContext): MessagingLogger {
    return new StructuredMessagingGatewayLogger({
      ...this.context,
      ...context,
    })
  }

  info(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('info', this.context, message, meta)
  }

  warn(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('warn', this.context, message, meta)
  }

  error(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('error', this.context, message, meta)
  }
}

export const messagingGatewayLog: MessagingLogger = new StructuredMessagingGatewayLogger({
  component: 'root',
})

/**
 * Dedicated auto-update log.
 *
 * In packaged builds the Electron file/console transports are disabled (see
 * above), so every `[auto-update]` / `[update-flow]` diagnostic is dropped —
 * leaving update-install failures undiagnosable in the field (see #891). This
 * dedicated, always-on rotating log records the update lifecycle at a stable
 * path regardless of debug mode, mirroring the messaging-gateway log above.
 */
export const autoUpdateLogPath = join(CONFIG_DIR, 'logs', 'auto-update.log')
const autoUpdateBackupPath = `${autoUpdateLogPath}.1`
const AUTO_UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024 // 2MB

function rotateAutoUpdateLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(autoUpdateLogPath)) return
  try {
    const currentSize = statSync(autoUpdateLogPath).size
    if (currentSize + nextLineBytes <= AUTO_UPDATE_LOG_MAX_BYTES) return
    if (existsSync(autoUpdateBackupPath)) {
      rmSync(autoUpdateBackupPath, { force: true })
    }
    renameSync(autoUpdateLogPath, autoUpdateBackupPath)
  } catch (error) {
    mainLog.warn('[auto-update] failed to rotate dedicated log file', normalizeLogValue(error))
  }
}

function writeAutoUpdateLog(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'auto-update',
    ...(meta !== undefined ? { meta: normalizeLogValue(meta) } : {}),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  try {
    mkdirSync(dirname(autoUpdateLogPath), { recursive: true })
    rotateAutoUpdateLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(autoUpdateLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[auto-update] failed to write dedicated log entry', normalizeLogValue(error))
  }

  // Mirror to the Electron logger too (a no-op in production where transports
  // are disabled, but keeps --debug console/file output intact).
  if (level === 'error') {
    mainLog.error('[auto-update]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[auto-update]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[auto-update]', message, entry)
  }
}

/** Always-on structured logger for the auto-update lifecycle (see #891). */
export const autoUpdateLog = {
  info: (message: string, meta?: unknown) => writeAutoUpdateLog('info', message, meta),
  warn: (message: string, meta?: unknown) => writeAutoUpdateLog('warn', message, meta),
  error: (message: string, meta?: unknown) => writeAutoUpdateLog('error', message, meta),
}

export function getAutoUpdateLogFilePath(): string {
  return autoUpdateLogPath
}

/**
 * Get the path to the current Electron main log file.
 * fork(PLAN-015): production file logging is always on, so this now answers
 * in packaged builds too (today's daily file) instead of returning undefined.
 */
export function getLogFilePath(): string | undefined {
  // fork(PLAN-015): packaged builds write daily files under CONFIG_DIR/logs
  if (!isDebugMode) return join(PROD_LOG_DIR, dailyLogFileName(PROD_LOG_PREFIX, new Date()))
  return log.transports.file.getFile()?.path
}

export function getMessagingGatewayLogFilePath(): string {
  return messagingGatewayLogPath
}

export default log
