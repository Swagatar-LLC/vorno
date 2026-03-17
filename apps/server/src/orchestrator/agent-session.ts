import { CraftAgent, type CraftAgentConfig, AbortReason } from '@craft-agent/shared/agent';
import type { AgentEvent, Workspace } from '@craft-agent/core/types';
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types';
import type { FileAttachment } from '@craft-agent/shared/utils';
import { loadStoredConfig, DEFAULT_MODEL } from '@craft-agent/shared/config';
import { getSessionPath } from '@craft-agent/shared/sessions';
import { TokenRefreshManager, getSourceCredentialManager } from '@craft-agent/shared/sources';
import { SourceOrchestrator } from './source-orchestrator.ts';
import type {
  AgentSessionConfig,
  AgentSessionCallbacks,
  AgentSessionStatus,
} from './types.ts';
import { mkdirSync } from 'fs';

// Safe commands that can be auto-allowed with 'allow-safe' policy
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'pwd', 'echo', 'which',
  'wc', 'sort', 'uniq', 'diff', 'file', 'stat', 'tree', 'less', 'more',
]);

/**
 * Map permission policy to PermissionMode.
 */
function policyToPermissionMode(policy: AgentSessionConfig['permissionPolicy']): PermissionMode {
  switch (policy) {
    case 'allow-all':
      return 'allow-all';
    case 'allow-safe':
      return 'ask';
    case 'deny-all':
    default:
      return 'safe';
  }
}

/**
 * AgentSession manages a single agent session lifecycle.
 * Used by the HTTP trigger server for REST+SSE access.
 *
 * Responsibilities:
 * - Create and configure CraftAgent
 * - Load sources and apply server configs
 * - Handle the chat loop (send message → stream events)
 * - Abort and cleanup
 */
export class AgentSession {
  readonly sessionId: string;
  readonly workspace: Workspace;

  private agent: CraftAgent | null = null;
  private config: AgentSessionConfig;
  private callbacks: AgentSessionCallbacks = {};
  private orchestrator: SourceOrchestrator;
  private tokenRefreshManager: TokenRefreshManager;
  private status: AgentSessionStatus = 'idle';
  private log: (message: string) => void;
  private sdkSessionId?: string;
  private lastActivityAt: number;

  constructor(config: AgentSessionConfig) {
    this.config = config;
    this.workspace = config.workspace;
    this.sessionId = config.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sdkSessionId = config.sdkSessionId;
    this.log = config.log ?? (() => {});
    this.lastActivityAt = Date.now();

    this.orchestrator = new SourceOrchestrator({
      workspace: config.workspace,
      log: this.log,
    });

    this.tokenRefreshManager = this.orchestrator.createTokenRefreshManager();
  }

  /**
   * Set callbacks for session events.
   */
  setCallbacks(callbacks: AgentSessionCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Get the current session status.
   */
  getStatus(): AgentSessionStatus {
    return this.status;
  }

  /**
   * Get the SDK session ID (for conversation continuity).
   */
  getSdkSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  /**
   * Get the last activity timestamp.
   */
  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  /**
   * Initialize the agent with sources, skills, and credentials.
   * Must be called before chat().
   */
  async initialize(): Promise<void> {
    if (this.status === 'disposed') {
      throw new Error('Cannot initialize a disposed session');
    }

    const permissionMode = policyToPermissionMode(this.config.permissionPolicy);
    const config = loadStoredConfig();

    const agentConfig: CraftAgentConfig = {
      workspace: this.config.workspace,
      model: this.config.model || config?.model || DEFAULT_MODEL,
      thinkingLevel: this.config.thinkingLevel,
      isHeadless: this.config.isHeadless ?? true,
      systemPromptPreset: this.config.systemPromptPreset,
      session: {
        id: this.sessionId,
        workspaceRootPath: this.config.workspace.rootPath,
        sdkSessionId: this.sdkSessionId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        workingDirectory: this.config.workingDirectory,
        sdkCwd: this.config.sdkCwd,
        permissionMode,
      },
      onSdkSessionIdUpdate: (sdkSessionId: string) => {
        this.sdkSessionId = sdkSessionId;
        this.log(`SDK session ID captured: ${sdkSessionId}`);
        this.callbacks.onSdkSessionIdUpdate?.(sdkSessionId);
      },
      onSdkSessionIdCleared: () => {
        this.sdkSessionId = undefined;
        this.log('SDK session ID cleared (resume recovery)');
        this.callbacks.onSdkSessionIdCleared?.();
      },
    };

    // Ensure the session directory exists — the SDK subprocess uses it as cwd
    // for storing conversation transcripts. Without it, the subprocess hangs silently.
    const sessionDir = this.config.sdkCwd ??
      getSessionPath(this.config.workspace.rootPath, this.sessionId);
    mkdirSync(sessionDir, { recursive: true });

    this.agent = new CraftAgent(agentConfig);

    // Wire permission handler based on policy
    this.agent.onPermissionRequest = (request) => {
      const policy = this.config.permissionPolicy;
      this.log(`Permission request: ${request.command} (policy: ${policy})`);

      if (policy === 'allow-all') {
        this.agent!.respondToPermission(request.requestId, true, false);
        return;
      }

      if (policy === 'allow-safe') {
        const baseCommand = request.command.trim().split(/\s+/)[0] || '';
        const allowed = SAFE_COMMANDS.has(baseCommand);
        this.log(`Safe check: ${baseCommand} allowed=${allowed}`);
        this.agent!.respondToPermission(request.requestId, allowed, false);
        return;
      }

      // deny-all: forward to callback (or deny if no callback)
      if (this.callbacks.onPermissionRequest) {
        this.callbacks.onPermissionRequest({
          ...request,
          sessionId: this.sessionId,
        });
      } else {
        this.agent!.respondToPermission(request.requestId, false, false);
      }
    };

    // Wire permission mode change handler
    this.agent.onPermissionModeChange = (mode) => {
      this.callbacks.onPermissionModeChange?.(mode);
    };

    // Wire plan submitted handler
    this.agent.onPlanSubmitted = async (planPath) => {
      this.callbacks.onPlanSubmitted?.(planPath);
    };

    // Wire auth request handler
    this.agent.onAuthRequest = (request) => {
      this.callbacks.onAuthRequest?.({
        requestId: request.requestId,
        type: request.type,
        sourceSlug: request.sourceSlug,
        sourceName: request.sourceName,
      });
    };

    // Load all sources for context
    const allSources = this.orchestrator.loadAllSources();
    this.agent.setAllSources(allSources);

    // Build and apply source servers if any are enabled
    if (this.config.enabledSourceSlugs?.length) {
      const sessionPath = this.config.sessionPath ??
        getSessionPath(this.config.workspace.rootPath, this.sessionId);

      const { result, intendedSlugs } = await this.orchestrator.buildServersForSlugs(
        this.config.enabledSourceSlugs,
        sessionPath,
        this.tokenRefreshManager
      );

      if (result.errors.length > 0) {
        this.log(`Source build errors: ${JSON.stringify(result.errors)}`);
      }

      const mcpCount = Object.keys(result.mcpServers).length;
      const apiCount = Object.keys(result.apiServers).length;
      if (mcpCount > 0 || apiCount > 0 || this.config.enabledSourceSlugs.length > 0) {
        this.agent.setSourceServers(result.mcpServers, result.apiServers, intendedSlugs);
        this.log(`Applied ${mcpCount} MCP + ${apiCount} API sources`);
      }
    }

    this.log(`AgentSession initialized (sessionId: ${this.sessionId})`);
  }

  /**
   * Send a message and stream agent events.
   * Returns an AsyncGenerator that yields AgentEvent objects.
   *
   * @param message - The user message to send
   * @param attachments - Optional file attachments
   */
  async *chat(message: string, attachments?: FileAttachment[]): AsyncGenerator<AgentEvent> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Call initialize() first.');
    }
    if (this.status === 'disposed') {
      throw new Error('Cannot chat on a disposed session');
    }
    if (this.status === 'processing') {
      throw new Error('Session is already processing a message');
    }

    this.status = 'processing';
    this.lastActivityAt = Date.now();

    try {
      // Refresh OAuth tokens before chat (handles mid-session token expiry)
      if (this.config.enabledSourceSlugs?.length) {
        const sessionPath = this.config.sessionPath ??
          getSessionPath(this.config.workspace.rootPath, this.sessionId);
        const sources = this.orchestrator.getSourcesBySlugs(this.config.enabledSourceSlugs);

        const refreshResult = await this.orchestrator.refreshTokensIfNeeded(
          this.agent,
          sources,
          sessionPath,
          this.tokenRefreshManager
        );

        if (refreshResult.tokensRefreshed) {
          this.log('OAuth tokens refreshed before chat');
        }
        for (const failed of refreshResult.failedSources) {
          yield { type: 'info', message: `Token refresh failed for "${failed.slug}" - source may need re-authentication` };
        }
      }

      // Refresh all sources for context
      const allSources = this.orchestrator.loadAllSources();
      this.agent.setAllSources(allSources);

      // Stream events from the agent
      for await (const event of this.agent.chat(message, attachments)) {
        this.lastActivityAt = Date.now();
        yield event;

        // Capture SDK session ID as fallback
        if (!this.sdkSessionId) {
          const sdkId = this.agent.getSessionId();
          if (sdkId) {
            this.sdkSessionId = sdkId;
            this.callbacks.onSdkSessionIdUpdate?.(sdkId);
          }
        }

        if (event.type === 'complete') {
          break;
        }
      }
    } finally {
      // Status may have been changed externally (e.g., dispose() called during chat)
      if ((this.status as AgentSessionStatus) !== 'disposed') {
        this.status = 'idle';
      }
    }
  }

  /**
   * Respond to a pending permission request.
   */
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow = false): void {
    this.agent?.respondToPermission(requestId, allowed, alwaysAllow);
  }

  /**
   * Abort the current generation.
   */
  abort(): void {
    if (this.agent && this.status === 'processing') {
      this.agent.forceAbort(AbortReason.UserStop);
    }
  }

  /**
   * Cleanup resources (MCP connections, agent state).
   */
  dispose(): void {
    if (this.status === 'disposed') return;

    if (this.agent) {
      if (this.status === 'processing') {
        this.agent.forceAbort(AbortReason.UserStop);
      }
      this.agent.dispose();
      this.agent = null;
    }

    this.status = 'disposed';
    this.log(`AgentSession disposed (sessionId: ${this.sessionId})`);
  }

  /**
   * Get the underlying CraftAgent (for advanced use cases).
   */
  getAgent(): CraftAgent | null {
    return this.agent;
  }

  /**
   * Get the SourceOrchestrator (for reloading sources).
   */
  getOrchestrator(): SourceOrchestrator {
    return this.orchestrator;
  }
}
