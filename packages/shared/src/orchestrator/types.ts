import type { Workspace } from '@craft-agent/core/types';
import type { LoadedSource } from '../sources/types.ts';
import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { AgentEvent } from '@craft-agent/core/types';
import type { McpServerConfig, SourceWithCredential, BuiltServers } from '../sources/server-builder.ts';
import type { FileAttachment } from '../utils/files.ts';

/**
 * Configuration for SourceOrchestrator.
 */
export interface SourceOrchestratorConfig {
  workspace: Workspace;
  /** Optional logger for debug output */
  log?: (message: string) => void;
}

/**
 * Result of building servers from sources.
 */
export interface BuildServersResult {
  mcpServers: BuiltServers['mcpServers'];
  apiServers: BuiltServers['apiServers'];
  errors: BuiltServers['errors'];
}

/**
 * Result of refreshing OAuth tokens.
 */
export interface TokenRefreshResult {
  /** Whether any tokens were refreshed */
  tokensRefreshed: boolean;
  /** Sources that failed to refresh */
  failedSources: Array<{ slug: string; reason: string }>;
}

/**
 * Configuration for creating an AgentSession.
 */
export interface AgentSessionConfig {
  workspace: Workspace;
  /** Session ID (if resuming an existing session) */
  sessionId?: string;
  /** SDK session ID for conversation continuity */
  sdkSessionId?: string;
  /** Model override */
  model?: string;
  /** Thinking level */
  thinkingLevel?: ThinkingLevel;
  /** Permission policy for the session */
  permissionPolicy: 'deny-all' | 'allow-safe' | 'allow-all';
  /** Source slugs to enable */
  enabledSourceSlugs?: string[];
  /** Working directory for bash commands */
  workingDirectory?: string;
  /** SDK cwd for session storage */
  sdkCwd?: string;
  /** Whether running in headless mode */
  isHeadless?: boolean;
  /** System prompt preset */
  systemPromptPreset?: 'default' | 'mini' | string;
  /** Session path for saving large API responses */
  sessionPath?: string;
  /** Optional logger */
  log?: (message: string) => void;
}

/**
 * Callbacks for AgentSession events that require external handling.
 * The HTTP server and Electron app wire these differently.
 */
export interface AgentSessionCallbacks {
  /** Called when the agent requests permission for a tool operation */
  onPermissionRequest?: (request: {
    requestId: string;
    toolName: string;
    command: string;
    description: string;
    sessionId: string;
  }) => void;

  /** Called when permission mode changes */
  onPermissionModeChange?: (mode: PermissionMode) => void;

  /** Called when a plan is submitted */
  onPlanSubmitted?: (planPath: string) => void;

  /** Called when auth is requested */
  onAuthRequest?: (request: {
    requestId: string;
    type: string;
    sourceSlug: string;
    sourceName: string;
  }) => void;

  /** Called when SDK session ID is captured/updated */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;

  /** Called when SDK session ID is cleared (e.g., after failed resume) */
  onSdkSessionIdCleared?: () => void;

  /** Called when source activation is requested */
  onSourceActivationRequest?: (sourceSlug: string) => void;
}

/**
 * Status of an AgentSession.
 */
export type AgentSessionStatus = 'idle' | 'processing' | 'disposed';
