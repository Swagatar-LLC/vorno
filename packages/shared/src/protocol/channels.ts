/**
 * RPC channel names — organized by domain namespace.
 * Wire-format strings (values) are the stable API contract.
 * Key paths are internal and may be reorganized freely.
 */
export const RPC_CHANNELS = {
  remote: {
    TEST_CONNECTION: 'remote:testConnection',
  },
  server: {
    GET_WORKSPACES: 'server:getWorkspaces',
    CREATE_WORKSPACE: 'server:createWorkspace',
    GET_STATUS: 'server:getStatus',
    GET_HEALTH: 'server:getHealth',
    GET_ACTIVE_SESSIONS: 'server:getActiveSessions',
    SHUTTING_DOWN: 'server:shuttingDown',
    STATUS_CHANGED: 'server:statusChanged',
    HOME_DIR: 'server:homeDir',
  },
  sessions: {
    GET: 'sessions:get',
    GET_UNREAD_SUMMARY: 'sessions:getUnreadSummary',
    MARK_ALL_READ: 'sessions:markAllRead',
    UNREAD_SUMMARY_CHANGED: 'sessions:unreadSummaryChanged',
    CREATE: 'sessions:create',
    DELETE: 'sessions:delete',
    GET_MESSAGES: 'sessions:getMessages',
    SEND_MESSAGE: 'sessions:sendMessage',
    CANCEL: 'sessions:cancel',
    KILL_SHELL: 'sessions:killShell',
    RESPOND_TO_PERMISSION: 'sessions:respondToPermission',
    RESPOND_TO_CREDENTIAL: 'sessions:respondToCredential',
    COMMAND: 'sessions:command',
    GET_PENDING_PLAN_EXECUTION: 'sessions:getPendingPlanExecution',
    GET_PERMISSION_MODE_STATE: 'sessions:getPermissionModeState',
    EVENT: 'session:event',
    GET_MODEL: 'session:getModel',
    SET_MODEL: 'session:setModel',
    GET_FILES: 'sessions:getFiles',
    GET_NOTES: 'sessions:getNotes',
    // fork: PLAN-040 / SUV-0026 — redeem a Headroom handle for a compressed
    // tool output's byte-identical original.
    RETRIEVE_HEADROOM_ORIGINAL: 'sessions:retrieveHeadroomOriginal',
    SET_NOTES: 'sessions:setNotes',
    WATCH_FILES: 'sessions:watchFiles',
    UNWATCH_FILES: 'sessions:unwatchFiles',
    FILES_CHANGED: 'sessions:filesChanged',
    SEARCH_CONTENT: 'sessions:searchContent',
    EXPORT: 'sessions:export',
    IMPORT: 'sessions:import',
    EXPORT_REMOTE_TRANSFER: 'sessions:exportRemoteTransfer',
    IMPORT_REMOTE_TRANSFER: 'sessions:importRemoteTransfer',
  },
  transfer: {
    START: 'transfer:start',
    CHUNK: 'transfer:chunk',
    COMMIT: 'transfer:commit',
    ABORT: 'transfer:abort',
  },
  tasks: {
    // Legacy: background-task output (disabled-feature remnant). Kept for back-compat; retire later.
    GET_OUTPUT: 'tasks:getOutput',
    // Conductor — the Tasks DAG runner.
    VALIDATE: 'tasks:validate',
    CREATE: 'tasks:create',
    GENERATE: 'tasks:generate',
    // Push: the authored spec (or an error) for an async tasks:generate, keyed by orchestratorSessionId.
    GENERATED: 'tasks:generated',
    RUN: 'tasks:run',
    PAUSE: 'tasks:pause',
    RESUME: 'tasks:resume',
    STOP: 'tasks:stop',
    GET: 'tasks:get',
    LIST: 'tasks:list',
    // Storage-backed read of a run's outcome (verdict + per-node output). Survives restart.
    GET_RESULTS: 'tasks:getResults',
  },
  workspaces: {
    GET: 'workspaces:get',
    CREATE: 'workspaces:create',
    CHECK_SLUG: 'workspaces:checkSlug',
    UPDATE_REMOTE: 'workspaces:updateRemote',
  },
  window: {
    GET_WORKSPACE: 'window:getWorkspace',
    GET_MODE: 'window:getMode',
    OPEN_WORKSPACE: 'window:openWorkspace',
    OPEN_SESSION_IN_NEW_WINDOW: 'window:openSessionInNewWindow',
    SWITCH_WORKSPACE: 'window:switchWorkspace',
    CLOSE: 'window:close',
    CLOSE_REQUESTED: 'window:closeRequested',
    CONFIRM_CLOSE: 'window:confirmClose',
    CANCEL_CLOSE: 'window:cancelClose',
    SET_TRAFFIC_LIGHTS: 'window:setTrafficLights',
    FOCUS_STATE: 'window:focusState',
    GET_FOCUS_STATE: 'window:getFocusState',
  },
  file: {
    READ: 'file:read',
    READ_DATA_URL: 'file:readDataUrl',
    READ_PREVIEW_DATA_URL: 'file:readPreviewDataUrl',
    READ_BINARY: 'file:readBinary',
    OPEN_DIALOG: 'file:openDialog',
    READ_ATTACHMENT: 'file:readAttachment',
    READ_USER_ATTACHMENT: 'file:readUserAttachment',
    STORE_ATTACHMENT: 'file:storeAttachment',
    GENERATE_THUMBNAIL: 'file:generateThumbnail',
  },
  fs: {
    SEARCH: 'fs:search',
    LIST_DIRECTORY: 'fs:listDirectory',
  },
  debug: {
    LOG: 'debug:log',
  },
  theme: {
    GET_SYSTEM_PREFERENCE: 'theme:getSystemPreference',
    SYSTEM_CHANGED: 'theme:systemChanged',
    APP_CHANGED: 'theme:appChanged',
    GET_APP: 'theme:getApp',
    GET_PRESETS: 'theme:getPresets',
    LOAD_PRESET: 'theme:loadPreset',
    GET_COLOR_THEME: 'theme:getColorTheme',
    SET_COLOR_THEME: 'theme:setColorTheme',
    BROADCAST_PREFERENCES: 'theme:broadcastPreferences',
    PREFERENCES_CHANGED: 'theme:preferencesChanged',
    GET_WORKSPACE_COLOR_THEME: 'theme:getWorkspaceColorTheme',
    SET_WORKSPACE_COLOR_THEME: 'theme:setWorkspaceColorTheme',
    GET_ALL_WORKSPACE_THEMES: 'theme:getAllWorkspaceThemes',
    BROADCAST_WORKSPACE_THEME: 'theme:broadcastWorkspaceTheme',
    WORKSPACE_THEME_CHANGED: 'theme:workspaceThemeChanged',
  },
  system: {
    VERSIONS: 'system:versions',
    HOME_DIR: 'system:homeDir',
    IS_DEBUG_MODE: 'system:isDebugMode',
  },
  update: {
    CHECK: 'update:check',
    GET_INFO: 'update:getInfo',
    INSTALL: 'update:install',
    DISMISS: 'update:dismiss',
    GET_DISMISSED: 'update:getDismissed',
    AVAILABLE: 'update:available',
    DOWNLOAD_PROGRESS: 'update:downloadProgress',
  },
  shell: {
    OPEN_URL: 'shell:openUrl',
    OPEN_FILE: 'shell:openFile',
    SHOW_IN_FOLDER: 'shell:showInFolder',
  },
  menu: {
    NEW_CHAT: 'menu:newChat',
    NEW_WINDOW: 'menu:newWindow',
    OPEN_SETTINGS: 'menu:openSettings',
    KEYBOARD_SHORTCUTS: 'menu:keyboardShortcuts',
    TOGGLE_FOCUS_MODE: 'menu:toggleFocusMode',
    TOGGLE_SIDEBAR: 'menu:toggleSidebar',
    QUIT: 'menu:quit',
    MINIMIZE: 'menu:minimize',
    MAXIMIZE: 'menu:maximize',
    ZOOM_IN: 'menu:zoomIn',
    ZOOM_OUT: 'menu:zoomOut',
    ZOOM_RESET: 'menu:zoomReset',
    TOGGLE_DEV_TOOLS: 'menu:toggleDevTools',
    UNDO: 'menu:undo',
    REDO: 'menu:redo',
    CUT: 'menu:cut',
    COPY: 'menu:copy',
    PASTE: 'menu:paste',
    SELECT_ALL: 'menu:selectAll',
  },
  deeplink: {
    NAVIGATE: 'deeplink:navigate',
  },
  auth: {
    LOGOUT: 'auth:logout',
    SHOW_LOGOUT_CONFIRMATION: 'auth:showLogoutConfirmation',
    SHOW_DELETE_SESSION_CONFIRMATION: 'auth:showDeleteSessionConfirmation',
  },
  credentials: {
    HEALTH_CHECK: 'credentials:healthCheck',
  },
  onboarding: {
    GET_AUTH_STATE: 'onboarding:getAuthState',
    VALIDATE_MCP: 'onboarding:validateMcp',
    START_MCP_OAUTH: 'onboarding:startMcpOAuth',
    START_CLAUDE_OAUTH: 'onboarding:startClaudeOAuth',
    EXCHANGE_CLAUDE_CODE: 'onboarding:exchangeClaudeCode',
    HAS_CLAUDE_OAUTH_STATE: 'onboarding:hasClaudeOAuthState',
    CLEAR_CLAUDE_OAUTH_STATE: 'onboarding:clearClaudeOAuthState',
    DEFER_SETUP: 'onboarding:deferSetup',
  },
  llmConnections: {
    LIST: 'LLM_Connection:list',
    LIST_WITH_STATUS: 'LLM_Connection:listWithStatus',
    GET: 'LLM_Connection:get',
    GET_API_KEY: 'LLM_Connection:getApiKey',
    SAVE: 'LLM_Connection:save',
    DELETE: 'LLM_Connection:delete',
    TEST: 'LLM_Connection:test',
    SET_DEFAULT: 'LLM_Connection:setDefault',
    SET_WORKSPACE_DEFAULT: 'LLM_Connection:setWorkspaceDefault',
    REFRESH_MODELS: 'LLM_Connection:refreshModels',
    CHANGED: 'LLM_Connection:changed',
  },
  chatgpt: {
    START_OAUTH: 'chatgpt:startOAuth',
    COMPLETE_OAUTH: 'chatgpt:completeOAuth',
    CANCEL_OAUTH: 'chatgpt:cancelOAuth',
    GET_AUTH_STATUS: 'chatgpt:getAuthStatus',
    LOGOUT: 'chatgpt:logout',
  },
  copilot: {
    START_OAUTH: 'copilot:startOAuth',
    CANCEL_OAUTH: 'copilot:cancelOAuth',
    GET_AUTH_STATUS: 'copilot:getAuthStatus',
    LOGOUT: 'copilot:logout',
    DEVICE_CODE: 'copilot:deviceCode',
  },
  settings: {
    SETUP_LLM_CONNECTION: 'settings:setupLlmConnection',
    TEST_LLM_CONNECTION_SETUP: 'settings:testLlmConnectionSetup',
    GET_DEFAULT_THINKING_LEVEL: 'settings:getDefaultThinkingLevel',
    SET_DEFAULT_THINKING_LEVEL: 'settings:setDefaultThinkingLevel',
    GET_NETWORK_PROXY: 'settings:getNetworkProxy',
    SET_NETWORK_PROXY: 'settings:setNetworkProxy',
    GET_SERVER_CONFIG: 'settings:getServerConfig',
    SET_SERVER_CONFIG: 'settings:setServerConfig',
    GET_SERVER_STATUS: 'settings:getServerStatus',
  },
  pi: {
    GET_API_KEY_PROVIDERS: 'pi:getApiKeyProviders',
    GET_PROVIDER_BASE_URL: 'pi:getProviderBaseUrl',
    GET_PROVIDER_MODELS: 'pi:getProviderModels',
  },
  dialog: {
    OPEN_FOLDER: 'dialog:openFolder',
  },
  preferences: {
    READ: 'preferences:read',
    WRITE: 'preferences:write',
  },
  drafts: {
    GET: 'drafts:get',
    SET: 'drafts:set',
    DELETE: 'drafts:delete',
    GET_ALL: 'drafts:getAll',
  },
  sources: {
    GET: 'sources:get',
    CREATE: 'sources:create',
    DELETE: 'sources:delete',
    START_OAUTH: 'sources:startOAuth',
    SAVE_CREDENTIALS: 'sources:saveCredentials',
    CHANGED: 'sources:changed',
    GET_PERMISSIONS: 'sources:getPermissions',
    GET_MCP_TOOLS: 'sources:getMcpTools',
  },
  oauth: {
    START: 'oauth:start',
    COMPLETE: 'oauth:complete',
    CANCEL: 'oauth:cancel',
    REVOKE: 'oauth:revoke',
  },
  workspace: {
    GET_PERMISSIONS: 'workspace:getPermissions',
    READ_IMAGE: 'workspace:readImage',
    WRITE_IMAGE: 'workspace:writeImage',
    SETTINGS_GET: 'workspaceSettings:get',
    SETTINGS_UPDATE: 'workspaceSettings:update',
  },
  permissions: {
    GET_DEFAULTS: 'permissions:getDefaults',
    DEFAULTS_CHANGED: 'permissions:defaultsChanged',
  },
  skills: {
    GET: 'skills:get',
    GET_FILES: 'skills:getFiles',
    DELETE: 'skills:delete',
    OPEN_EDITOR: 'skills:openEditor',
    OPEN_FINDER: 'skills:openFinder',
    CHANGED: 'skills:changed',
  },
  statuses: {
    LIST: 'statuses:list',
    REORDER: 'statuses:reorder',
    CHANGED: 'statuses:changed',
  },
  labels: {
    LIST: 'labels:list',
    CREATE: 'labels:create',
    DELETE: 'labels:delete',
    CHANGED: 'labels:changed',
  },
  views: {
    LIST: 'views:list',
    SAVE: 'views:save',
  },
  toolIcons: {
    GET_MAPPINGS: 'toolIcons:getMappings',
  },
  logo: {
    GET_URL: 'logo:getUrl',
  },
  notification: {
    SHOW: 'notification:show',
    NAVIGATE: 'notification:navigate',
    GET_ENABLED: 'notification:getEnabled',
    SET_ENABLED: 'notification:setEnabled',
  },
  input: {
    GET_AUTO_CAPITALISATION: 'input:getAutoCapitalisation',
    SET_AUTO_CAPITALISATION: 'input:setAutoCapitalisation',
    GET_SEND_MESSAGE_KEY: 'input:getSendMessageKey',
    SET_SEND_MESSAGE_KEY: 'input:setSendMessageKey',
    GET_SPELL_CHECK: 'input:getSpellCheck',
    SET_SPELL_CHECK: 'input:setSpellCheck',
  },
  power: {
    GET_KEEP_AWAKE: 'power:getKeepAwake',
    SET_KEEP_AWAKE: 'power:setKeepAwake',
  },
  appearance: {
    GET_RICH_TOOL_DESCRIPTIONS: 'appearance:getRichToolDescriptions',
    SET_RICH_TOOL_DESCRIPTIONS: 'appearance:setRichToolDescriptions',
  },
  tools: {
    GET_BROWSER_TOOL_ENABLED: 'tools:getBrowserToolEnabled',
    SET_BROWSER_TOOL_ENABLED: 'tools:setBrowserToolEnabled',
  },
  caching: {
    GET_EXTENDED_PROMPT_CACHE: 'caching:getExtendedPromptCache',
    SET_EXTENDED_PROMPT_CACHE: 'caching:setExtendedPromptCache',
    GET_ENABLE_1M_CONTEXT: 'caching:getEnable1MContext',
    SET_ENABLE_1M_CONTEXT: 'caching:setEnable1MContext',
  },
  rtk: {
    GET_ENABLED: 'rtk:getEnabled',
    SET_ENABLED: 'rtk:setEnabled',
    GET_STATUS: 'rtk:getStatus',
    GET_GAIN: 'rtk:getGain',
  },
  // fork(PLAN-011): namespaced under craft-fork:* per roadmap/upstream/compatibility.md
  // so a future upstream keep-alive setting can't collide.
  bgAgents: {
    GET_KEEP_ALIVE: 'craft-fork:bgAgents:getKeepAlive',
    SET_KEEP_ALIVE: 'craft-fork:bgAgents:setKeepAlive',
  },
  // fork(PLAN-015): production logging control. LOCAL_ONLY — the log level and
  // log files live on the local machine's main process. Namespaced under
  // craft-fork:* per roadmap/upstream/compatibility.md.
  logging: {
    GET_STATE: 'craft-fork:logging:getState',
    SET_LEVEL: 'craft-fork:logging:setLevel',
    OPEN_LOG_FOLDER: 'craft-fork:logging:openLogFolder',
    REVEAL_LOG_FILE: 'craft-fork:logging:revealLogFile',
  },
  // fork(PLAN-012): embedded HTTP trigger-server supervision. LOCAL_ONLY — the
  // supervisor is main-process state. Namespaced under craft-fork:* per
  // roadmap/upstream/compatibility.md.
  triggerServer: {
    GET_CONFIG: 'craft-fork:triggerServer:getConfig',
    UPDATE_CONFIG: 'craft-fork:triggerServer:updateConfig',
    GET_STATUS: 'craft-fork:triggerServer:getStatus',
    START: 'craft-fork:triggerServer:start',
    STOP: 'craft-fork:triggerServer:stop',
    CREATE_API_KEY: 'craft-fork:triggerServer:createApiKey',
    REVOKE_API_KEY: 'craft-fork:triggerServer:revokeApiKey',
  },
  // fork(PLAN-014): per-workspace webhook management. LOCAL_ONLY — hook CRUD is
  // main-process-side against the workspace's automations.json, mirroring the
  // trigger-server it feeds. Namespaced under craft-fork:* per
  // roadmap/upstream/compatibility.md. Token plaintext is returned exactly once
  // from UPSERT/REVOKE(rotate) and never persisted.
  webhooks: {
    LIST: 'craft-fork:webhooks:list',
    UPSERT: 'craft-fork:webhooks:upsert',
    REVOKE: 'craft-fork:webhooks:revoke',
    DELIVERIES: 'craft-fork:webhooks:deliveries',
  },
  // fork(PLAN-020): desktop WebUI listener supervision. LOCAL_ONLY — the
  // supervisor is main-process state (own port, own lifecycle, independent of
  // the trigger-server). Namespaced under craft-fork:* per
  // roadmap/upstream/compatibility.md.
  webui: {
    GET_CONFIG: 'craft-fork:webui:getConfig',
    UPDATE_CONFIG: 'craft-fork:webui:updateConfig',
    GET_STATUS: 'craft-fork:webui:getStatus',
    START: 'craft-fork:webui:start',
    STOP: 'craft-fork:webui:stop',
    REGENERATE_PASSWORD: 'craft-fork:webui:regeneratePassword',
    SET_PASSWORD: 'craft-fork:webui:setPassword',
  },
  // fork(PLAN-018 / ADR-0009): runtime-configurable auto-update feed. LOCAL_ONLY
  // — the feed override lives in the local machine's main process and is applied
  // to electron-updater before any check. Namespaced under craft-fork:* per
  // roadmap/upstream/compatibility.md so upstream's `update:*` group is untouched.
  updater: {
    GET_FEED_CONFIG: 'craft-fork:updates:getFeedConfig',
    SET_FEED_CONFIG: 'craft-fork:updates:setFeedConfig',
  },
  badge: {
    REFRESH: 'badge:refresh',
    SET_ICON: 'badge:setIcon',
    DRAW: 'badge:draw',
    DRAW_WINDOWS: 'badge:draw-windows',
  },
  releaseNotes: {
    GET: 'releaseNotes:get',
    GET_LATEST_VERSION: 'releaseNotes:getLatestVersion',
  },
  git: {
    GET_BRANCH: 'git:getBranch',
  },
  gitbash: {
    CHECK: 'gitbash:check',
    BROWSE: 'gitbash:browse',
    SET_PATH: 'gitbash:setPath',
  },
  browserPane: {
    CREATE: 'browser-pane:create',
    DESTROY: 'browser-pane:destroy',
    LIST: 'browser-pane:list',
    NAVIGATE: 'browser-pane:navigate',
    GO_BACK: 'browser-pane:go-back',
    GO_FORWARD: 'browser-pane:go-forward',
    RELOAD: 'browser-pane:reload',
    STOP: 'browser-pane:stop',
    FOCUS: 'browser-pane:focus',
    SNAPSHOT: 'browser-pane:snapshot',
    CLICK: 'browser-pane:click',
    FILL: 'browser-pane:fill',
    SELECT: 'browser-pane:select',
    SCREENSHOT: 'browser-pane:screenshot',
    EVALUATE: 'browser-pane:evaluate',
    SCROLL: 'browser-pane:scroll',
    LAUNCH: 'browser-empty-state:launch',
    STATE_CHANGED: 'browser-pane:state-changed',
    REMOVED: 'browser-pane:removed',
    INTERACTED: 'browser-pane:interacted',
  },
  automations: {
    GET: 'automations:get',
    TEST: 'automations:test',
    SET_ENABLED: 'automations:setEnabled',
    DUPLICATE: 'automations:duplicate',
    DELETE: 'automations:delete',
    GET_HISTORY: 'automations:getHistory',
    GET_LAST_EXECUTED: 'automations:getLastExecuted',
    REPLAY: 'automations:replay',
    CHANGED: 'automations:changed',
  },
  resources: {
    EXPORT: 'resources:export',
    IMPORT: 'resources:import',
  },
  projects: {
    GET: 'projects:get',
    GET_ONE: 'projects:getOne',
    CREATE: 'projects:create',
    UPDATE: 'projects:update',
    DELETE: 'projects:delete',
    LIST_ASSETS: 'projects:listAssets',
    UPLOAD_ASSET: 'projects:uploadAsset',
    DELETE_ASSET: 'projects:deleteAsset',
    CHANGED: 'projects:changed',
  },
  messaging: {
    // WhatsApp subprocess → Gateway (subprocess invokes on server)
    WA_REGISTER: 'messaging:wa:register',
    WA_INCOMING: 'messaging:wa:incoming',
    WA_BUTTON_PRESS: 'messaging:wa:buttonPress',
    WA_STATUS: 'messaging:wa:status',
    WA_QR: 'messaging:wa:qr',
    // Gateway → WhatsApp subprocess (server invokes on client)
    WA_SEND: 'messaging:wa:send',
    WA_SEND_BUTTONS: 'messaging:wa:sendButtons',
    WA_SEND_TYPING: 'messaging:wa:sendTyping',
    WA_SEND_FILE: 'messaging:wa:sendFile',
    WA_CONNECT: 'messaging:wa:connect',
    WA_DISCONNECT: 'messaging:wa:disconnect',
    // Gateway → UI clients (broadcast)
    BINDING_CHANGED: 'messaging:bindingChanged',
    PLATFORM_STATUS: 'messaging:platformStatus',
    /** Broadcast when the workspace's pending-senders list mutates. */
    PENDING_CHANGED: 'messaging:pendingChanged',
    // UI ↔ Server (config/binding CRUD)
    GET_CONFIG: 'messaging:getConfig',
    UPDATE_CONFIG: 'messaging:updateConfig',
    TEST_TELEGRAM: 'messaging:testTelegram',
    SAVE_TELEGRAM: 'messaging:saveTelegram',
    TEST_LARK: 'messaging:testLark',
    SAVE_LARK: 'messaging:saveLark',
    DISCONNECT: 'messaging:disconnect',
    FORGET: 'messaging:forget',
    GET_BINDINGS: 'messaging:getBindings',
    GENERATE_CODE: 'messaging:generateCode',
    UNBIND: 'messaging:unbind',
    UNBIND_BINDING: 'messaging:unbindBinding',
    /** Workspace-supergroup pairing (Telegram forum support). UI ↔ Server. */
    GENERATE_SUPERGROUP_CODE: 'messaging:generateSupergroupCode',
    GET_SUPERGROUP: 'messaging:getSupergroup',
    UNBIND_SUPERGROUP: 'messaging:unbindSupergroup',
    // UI ↔ Server — WhatsApp pairing/connection flow (Baileys subprocess adapter)
    WA_START_CONNECT: 'messaging:wa:startConnect',
    WA_SUBMIT_PHONE: 'messaging:wa:submitPhone',
    /** Broadcast to UI clients: QR string, pairing code, status, unavailable, error. */
    WA_UI_EVENT: 'messaging:wa:uiEvent',
    // UI ↔ Server — Access control (per-platform owners + per-binding allow-list)
    GET_PLATFORM_OWNERS: 'messaging:access:getOwners',
    SET_PLATFORM_OWNERS: 'messaging:access:setOwners',
    GET_PLATFORM_ACCESS_MODE: 'messaging:access:getMode',
    SET_PLATFORM_ACCESS_MODE: 'messaging:access:setMode',
    GET_PENDING_SENDERS: 'messaging:access:getPending',
    DISMISS_PENDING_SENDER: 'messaging:access:dismissPending',
    ALLOW_PENDING_SENDER: 'messaging:access:allowPending',
    SET_BINDING_ACCESS: 'messaging:access:setBindingAccess',
  },

  /**
   * Workbench — dynamic workspace surfaces (ADR-0012 vorno:* additive
   * namespace; ADR-0014). Wire shape: vorno:workbench:<type>:<action>.
   * Workbench *instances* are addressed by workbenchId in payloads, never
   * in channel names (the channel set stays static and auditable).
   */
  workbench: {
    REVIEW_INSTANCES_LIST: 'vorno:workbench:review:instances:list',
    REVIEW_INSTANCES_CREATE: 'vorno:workbench:review:instances:create',
    REVIEW_INSTANCES_UPDATE: 'vorno:workbench:review:instances:update',
    REVIEW_ARTIFACTS_INDEX: 'vorno:workbench:review:artifacts:index',
    REVIEW_ARTIFACTS_READ: 'vorno:workbench:review:artifacts:read',
    REVIEW_THREADS_LIST: 'vorno:workbench:review:threads:list',
    REVIEW_THREADS_MUTATE: 'vorno:workbench:review:threads:mutate',
  },

  /**
   * Artifact plane — the generalized workspace artifact surface (ADR-0016,
   * ADR-0015 / DIR-04, PLAN-025 C1; ADR-0012 vorno:* additive namespace).
   * Wire payloads carry only `vorno-artifact://` URIs — never absolute paths
   * (ADR-0016 §2). The channel set stays static and auditable; artifacts are
   * addressed by URI in payloads, never in channel names.
   */
  artifacts: {
    INDEX: 'vorno:artifacts:index',
    READ: 'vorno:artifacts:read',
    RELATIONS_LIST: 'vorno:artifacts:relations:list',
    RELATIONS_MUTATE: 'vorno:artifacts:relations:mutate',
    LIFECYCLE_SET: 'vorno:artifacts:lifecycle:set',
    ROOTS_LIST: 'vorno:artifacts:roots:list',
    TYPES_LIST: 'vorno:artifacts:types:list',
  },

  /**
   * Headroom savings report (fork: PLAN-040 / SUV-0027).
   *
   * `STATS_GET` answers with a `HeadroomStatsReport` — measurements taken by the
   * scope-counting adapters, never a computed figure. `STATS_CHANGED` is a
   * signal with no payload: it says "ask again", which is what keeps the view
   * live after a session completes without pushing numbers at a client that may
   * have navigated away.
   */
  headroom: {
    STATS_GET: 'vorno:headroom:stats:get',
    STATS_CHANGED: 'vorno:headroom:stats:changed',
  },

  /**
   * Memory provider capabilities (fork: PLAN-040 / SUV-0029 + SUV-0040).
   *
   * One read channel, answering with a `MemoryProviderCapabilities` — the
   * provider's own `describe()`, not a table this layer keeps about providers.
   * That is the whole reason the channel exists: a settings surface that wants
   * to say "lexical, not semantic" or "needs a one-time model download" must ask
   * the provider, because ADR-0031 forbids branching on a provider id anywhere
   * outside the registry.
   *
   * Read-only and unpaired: the *configuration* is written through
   * `workspaceSettings:update` like every other workspace setting, so there is
   * no memory-specific write channel to keep in sync with it.
   */
  memory: {
    CAPABILITIES_GET: 'vorno:memory:capabilities:get',
  },
} as const

// IPC_CHANNELS compat alias removed — all consumers now use RPC_CHANNELS

/**
 * Flatten all channel string values from the nested RPC_CHANNELS object.
 * Used by the exhaustive routing test to ensure every channel is classified.
 */
export function getAllChannelValues(): string[] {
  const values: string[] = []
  for (const namespace of Object.values(RPC_CHANNELS)) {
    for (const channel of Object.values(namespace)) {
      values.push(channel)
    }
  }
  return values
}
