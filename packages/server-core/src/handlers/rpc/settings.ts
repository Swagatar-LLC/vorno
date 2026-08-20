import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getPreferencesPath, getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts, getWorkspaceByNameOrId, getDefaultThinkingLevel, setDefaultThinkingLevel } from '@craft-agent/shared/config'
import { isValidThinkingLevel, normalizeThinkingLevel, THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { getWorkspaceOrThrow } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog } from '@craft-agent/server-core/transport'
import { isValidWorkingDirectory } from '../../utils/path-validation'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
  RPC_CHANNELS.rtk.GET_ENABLED,
  RPC_CHANNELS.rtk.SET_ENABLED,
  RPC_CHANNELS.rtk.GET_STATUS,
  RPC_CHANNELS.rtk.GET_GAIN,
  // fork(PLAN-011): background-agent keep-alive setting
  RPC_CHANNELS.bgAgents.GET_KEEP_ALIVE,
  RPC_CHANNELS.bgAgents.SET_KEEP_ALIVE,
] as const

export function registerSettingsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // ============================================================
  // Settings - Default Thinking Level (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL, async () => {
    return getDefaultThinkingLevel()
  })

  server.handle(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, async (_ctx, level: string) => {
    if (!isValidThinkingLevel(level)) {
      throw new Error(`Invalid thinking level: ${level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
    }
    const success = setDefaultThinkingLevel(level)
    if (!success) {
      throw new Error('Failed to persist default thinking level')
    }
    return { success: true }
  })

  // ============================================================
  // Settings - Model (Session-Specific)
  // ============================================================

  // Get session-specific model
  server.handle(RPC_CHANNELS.sessions.GET_MODEL, async (_ctx, sessionId: string, _workspaceId: string): Promise<string | null> => {
    const session = await deps.sessionManager.getSession(sessionId)
    return session?.model ?? null
  })

  // Set session-specific model (and optionally connection)
  server.handle(RPC_CHANNELS.sessions.SET_MODEL, async (_ctx, sessionId: string, workspaceId: string, model: string | null, connection?: string) => {
    await deps.sessionManager.updateSessionModel(sessionId, workspaceId, model, connection)
    deps.platform.logger.info(`Session ${sessionId} model updated to: ${model}${connection ? ` (connection: ${connection})` : ''}`)
  })

  // Open native folder dialog for selecting working directory (routed to client)
  server.handle(RPC_CHANNELS.dialog.OPEN_FOLDER, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ============================================================
  // Workspace Settings (per-workspace configuration)
  // ============================================================

  // Get workspace settings (model, permission mode, working directory, credential strategy)
  server.handle(RPC_CHANNELS.workspace.SETTINGS_GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger.error(`Workspace not found: ${workspaceId}`)
      return null
    }

    // Load workspace config
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)

    return {
      name: config?.name,
      model: config?.defaults?.model,
      permissionMode: config?.defaults?.permissionMode,
      cyclablePermissionModes: config?.defaults?.cyclablePermissionModes,
      thinkingLevel: normalizeThinkingLevel(config?.defaults?.thinkingLevel),
      workingDirectory: config?.defaults?.workingDirectory,
      localMcpEnabled: config?.localMcpServers?.enabled ?? true,
      defaultLlmConnection: config?.defaults?.defaultLlmConnection,
      enabledSourceSlugs: config?.defaults?.enabledSourceSlugs ?? [],
      tokenUsageThresholds: config?.defaults?.tokenUsageThresholds,
      tokenUsageModelOverrides: config?.defaults?.tokenUsageModelOverrides,
      idleAgentTtlMinutes: config?.defaults?.idleAgentTtlMinutes,
      workbenchEnabled: config?.defaults?.workbenchEnabled ?? false,
      artifactsEnabled: config?.defaults?.artifactsEnabled ?? false,
      artifactRoots: config?.defaults?.artifactRoots ?? {},
    }
  })

  // Update a workspace setting
  server.handle(RPC_CHANNELS.workspace.SETTINGS_UPDATE, async (_ctx, workspaceId: string, key: string, value: unknown) => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const normalizedValue = key === 'workingDirectory' && typeof value === 'string'
      ? value.trim()
      : value

    // Validate key is a known workspace setting
    const validKeys = ['name', 'model', 'enabledSourceSlugs', 'permissionMode', 'cyclablePermissionModes', 'thinkingLevel', 'workingDirectory', 'localMcpEnabled', 'defaultLlmConnection', 'tokenUsageThresholds', 'tokenUsageModelOverrides', 'idleAgentTtlMinutes', 'workbenchEnabled', 'artifactsEnabled', 'artifactRoots']
    if (!validKeys.includes(key)) {
      throw new Error(`Invalid workspace setting key: ${key}. Valid keys: ${validKeys.join(', ')}`)
    }

    // Validate artifactRoots (ADR-0016 §2, ADR-0019). The value is a map of
    // rootId → (absolute-path string | RootBindingConfig). Root ids must be
    // syntactically valid and not shadow the reserved 'workspace' id. A bare
    // string is the filesystem shorthand (absolute path). An object must carry
    // a string `kind`; only 'filesystem' (absolute `path`) is supported for
    // saving today — other kinds (object-store) arrive with the hosted track
    // and are rejected here so no interim config bakes in an inline secret
    // (ADR-0019 §4, door 4). Resolution itself stays tolerant (unknown kinds
    // are skipped, never thrown) so a newer config never bricks an older Vorno.
    if (key === 'artifactRoots' && normalizedValue !== undefined && normalizedValue !== null) {
      if (typeof normalizedValue !== 'object' || Array.isArray(normalizedValue)) {
        throw new Error('artifactRoots must be an object map of rootId → root binding')
      }
      const { isValidRootId, RESERVED_WORKSPACE_ROOT_ID } = await import('@craft-agent/shared/artifacts')
      for (const [rootId, rawValue] of Object.entries(normalizedValue as Record<string, unknown>)) {
        if (rootId === RESERVED_WORKSPACE_ROOT_ID) {
          throw new Error(`artifactRoots: '${RESERVED_WORKSPACE_ROOT_ID}' is a reserved, implicit root id`)
        }
        if (!isValidRootId(rootId)) {
          throw new Error(`artifactRoots: invalid root id "${rootId}" (must be lowercase kebab, 1–64 chars)`)
        }
        // Bare string = filesystem shorthand.
        if (typeof rawValue === 'string') {
          if (!isAbsolute(rawValue)) {
            throw new Error(`artifactRoots."${rootId}": value must be an absolute path`)
          }
          continue
        }
        // Object form: discriminated by `kind`.
        if (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue)) {
          throw new Error(`artifactRoots."${rootId}": value must be an absolute path or a { kind, … } binding`)
        }
        const kind = (rawValue as { kind?: unknown }).kind
        if (typeof kind !== 'string') {
          throw new Error(`artifactRoots."${rootId}": binding must have a string "kind"`)
        }
        if (kind === 'filesystem') {
          const path = (rawValue as { path?: unknown }).path
          if (typeof path !== 'string' || !isAbsolute(path)) {
            throw new Error(`artifactRoots."${rootId}": filesystem kind requires an absolute "path"`)
          }
          continue
        }
        throw new Error(
          `artifactRoots."${rootId}": kind "${kind}" is not supported yet. Object-store roots and their credentials arrive with hosted workspaces (via the vault, never inline).`,
        )
      }
    }

    // Validate threshold maps: each entry must be { warn, danger } with 0 < warn < danger < 1.
    if (key === 'tokenUsageThresholds' || key === 'tokenUsageModelOverrides') {
      if (normalizedValue !== undefined && normalizedValue !== null) {
        if (typeof normalizedValue !== 'object' || Array.isArray(normalizedValue)) {
          throw new Error(`${key} must be an object map`)
        }
        for (const [entryKey, raw] of Object.entries(normalizedValue as Record<string, unknown>)) {
          if (!raw || typeof raw !== 'object') {
            throw new Error(`${key}.${entryKey} must be an object with warn/danger`)
          }
          const pair = raw as { warn?: unknown; danger?: unknown }
          const warn = typeof pair.warn === 'number' ? pair.warn : NaN
          const danger = typeof pair.danger === 'number' ? pair.danger : NaN
          if (!Number.isFinite(warn) || !Number.isFinite(danger) || warn <= 0 || warn >= 1 || danger <= 0 || danger >= 1 || warn >= danger) {
            throw new Error(`${key}.${entryKey}: warn and danger must be numbers in (0, 1) with warn < danger`)
          }
        }
      }
    }

    // Validate idleAgentTtlMinutes (PLAN-038): whole minutes, 0 = eviction
    // disabled, capped at one week (10080). The generic defaults write below
    // persists it — no dedicated storage path.
    if (key === 'idleAgentTtlMinutes' && normalizedValue !== undefined && normalizedValue !== null) {
      const v = normalizedValue
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10080) {
        throw new Error('idleAgentTtlMinutes must be an integer between 0 (disabled) and 10080 (one week)')
      }
    }

    // Validate defaultLlmConnection exists before saving
    if (key === 'defaultLlmConnection' && normalizedValue !== undefined && normalizedValue !== null) {
      const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
      if (!getLlmConnection(normalizedValue as string)) {
        throw new Error(`LLM connection "${normalizedValue}" not found`)
      }
    }

    if (key === 'workingDirectory' && normalizedValue !== undefined && normalizedValue !== null) {
      const validation = isValidWorkingDirectory(String(normalizedValue))
      if (!validation.valid) {
        throw new Error(validation.reason!)
      }
    }

    const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      throw new Error(`Failed to load workspace config: ${workspaceId}`)
    }

    // Handle 'name' specially - it's a top-level config property, not in defaults
    if (key === 'name') {
      config.name = String(normalizedValue).trim()
    } else if (key === 'localMcpEnabled') {
      // Store in localMcpServers.enabled (top-level, not in defaults)
      config.localMcpServers = config.localMcpServers || { enabled: true }
      config.localMcpServers.enabled = Boolean(normalizedValue)
    } else {
      // Update the setting in defaults
      config.defaults = config.defaults || {}
      ;(config.defaults as Record<string, unknown>)[key] = normalizedValue
    }

    // Save the config
    saveWorkspaceConfig(workspace.rootPath, config)
    deps.platform.logger.info(`Workspace setting updated: ${key} = ${JSON.stringify(normalizedValue)}`)
  })

  // ============================================================
  // User Preferences
  // ============================================================

  // Read user preferences file
  server.handle(RPC_CHANNELS.preferences.READ, async () => {
    const path = getPreferencesPath()
    if (!existsSync(path)) {
      return { content: '{}', exists: false, path }
    }
    return { content: readFileSync(path, 'utf-8'), exists: true, path }
  })

  // Write user preferences file (validates JSON before saving)
  server.handle(RPC_CHANNELS.preferences.WRITE, async (_, content: string) => {
    try {
      JSON.parse(content) // Validate JSON
      const path = getPreferencesPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============================================================
  // Session Drafts (persisted input text)
  // ============================================================

  // Get draft for a session (text + attachment refs)
  server.handle(RPC_CHANNELS.drafts.GET, async (_ctx, sessionId: string) => {
    return getSessionDraft(sessionId)
  })

  // Set draft for a session (empty drafts are cleared)
  server.handle(RPC_CHANNELS.drafts.SET, async (_ctx, sessionId: string, draft: import('@craft-agent/shared/config').SessionDraft) => {
    setSessionDraft(sessionId, draft)
  })

  // Delete draft for a session
  server.handle(RPC_CHANNELS.drafts.DELETE, async (_ctx, sessionId: string) => {
    deleteSessionDraft(sessionId)
  })

  // Get all drafts (for loading on app start)
  server.handle(RPC_CHANNELS.drafts.GET_ALL, async () => {
    return getAllSessionDrafts()
  })

  // ============================================================
  // Input Settings
  // ============================================================

  // Get auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION, async () => {
    const { getAutoCapitalisation } = await import('@craft-agent/shared/config/storage')
    return getAutoCapitalisation()
  })

  // Set auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.SET_AUTO_CAPITALISATION, async (_ctx, enabled: boolean) => {
    const { setAutoCapitalisation } = await import('@craft-agent/shared/config/storage')
    setAutoCapitalisation(enabled)
  })

  // Get send message key setting
  server.handle(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY, async () => {
    const { getSendMessageKey } = await import('@craft-agent/shared/config/storage')
    return getSendMessageKey()
  })

  // Set send message key setting
  server.handle(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY, async (_ctx, key: 'enter' | 'cmd-enter') => {
    const { setSendMessageKey } = await import('@craft-agent/shared/config/storage')
    setSendMessageKey(key)
  })

  // Get spell check setting
  server.handle(RPC_CHANNELS.input.GET_SPELL_CHECK, async () => {
    const { getSpellCheck } = await import('@craft-agent/shared/config/storage')
    return getSpellCheck()
  })

  // Set spell check setting
  server.handle(RPC_CHANNELS.input.SET_SPELL_CHECK, async (_ctx, enabled: boolean) => {
    const { setSpellCheck } = await import('@craft-agent/shared/config/storage')
    setSpellCheck(enabled)
  })

  // ============================================================
  // Power Settings
  // ============================================================

  // Get keep awake while running setting
  server.handle(RPC_CHANNELS.power.GET_KEEP_AWAKE, async () => {
    const { getKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
    return getKeepAwakeWhileRunning()
  })

  // ============================================================
  // Appearance Settings
  // ============================================================

  // Get rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS, async () => {
    const { getRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    return getRichToolDescriptions()
  })

  // Set rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS, async (_ctx, enabled: boolean) => {
    const { setRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    setRichToolDescriptions(enabled)
  })

  // ============================================================
  // Prompt Caching Settings
  // ============================================================

  // Get extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE, async () => {
    const { getExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    return getExtendedPromptCache()
  })

  // Set extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE, async (_ctx, enabled: boolean) => {
    const { setExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    setExtendedPromptCache(enabled)
  })

  // Get 1M context window setting
  server.handle(RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT, async () => {
    const { getEnable1MContext } = await import('@craft-agent/shared/config/storage')
    return getEnable1MContext()
  })

  // Set 1M context window setting
  server.handle(RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT, async (_ctx, enabled: boolean) => {
    const { setEnable1MContext } = await import('@craft-agent/shared/config/storage')
    setEnable1MContext(enabled)
  })

  // ============================================================
  // fork(PLAN-011): Background-Agent Keep-Alive Setting
  // ============================================================

  // Get keep-alive state: { enabled, envOverride }. The env var wins when set,
  // in which case envOverride is true and the UI disables the toggle.
  server.handle(RPC_CHANNELS.bgAgents.GET_KEEP_ALIVE, async () => {
    const { getKeepBackgroundTasksAliveState } = await import('@craft-agent/shared/agent')
    return getKeepBackgroundTasksAliveState()
  })

  // Set the stored keep-alive setting. Consumers read live from storage, so the
  // change applies at each session's next message; no push/broadcast needed.
  server.handle(RPC_CHANNELS.bgAgents.SET_KEEP_ALIVE, async (_ctx, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    const { setKeepBackgroundAgentsAlive } = await import('@craft-agent/shared/config/storage')
    setKeepBackgroundAgentsAlive(enabled)
    deps.platform.logger.info(`Background-agent keep-alive set to: ${enabled}`)
  })

  // ============================================================
  // RTK Token-Optimization Settings
  // ============================================================

  // Get rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.GET_ENABLED, async () => {
    const { getRtkEnabled } = await import('@craft-agent/shared/config/storage')
    return getRtkEnabled()
  })

  // Set rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setRtkEnabled } = await import('@craft-agent/shared/config/storage')
    setRtkEnabled(enabled)
  })

  // Detect rtk installation (used by Settings UI to swap install prompt ↔ toggle)
  server.handle(RPC_CHANNELS.rtk.GET_STATUS, async (_ctx, opts?: { forceRecheck?: boolean }) => {
    const { getRtkStatus } = await import('@craft-agent/shared/agent')
    return getRtkStatus(opts)
  })

  // Token-savings summary from `rtk gain --format json` (efficiency meter)
  server.handle(RPC_CHANNELS.rtk.GET_GAIN, async () => {
    const { getRtkGain } = await import('@craft-agent/shared/agent')
    return getRtkGain()
  })

  // ============================================================
  // Tools Settings
  // ============================================================

  server.handle(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED, async () => {
    const { getBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    return getBrowserToolEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED, async (_ctx, enabled: boolean) => {
    const { setBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    setBrowserToolEnabled(enabled)
  })

  // ============================================================
  // Network Proxy Settings
  // ============================================================

  // Get network proxy settings
  server.handle(RPC_CHANNELS.settings.GET_NETWORK_PROXY, async () => {
    const { getNetworkProxySettings } = await import('@craft-agent/shared/config/storage')
    return getNetworkProxySettings()
  })
}
