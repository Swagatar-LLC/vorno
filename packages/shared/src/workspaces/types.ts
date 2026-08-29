/**
 * Workspace Types
 *
 * Workspaces are the top-level organizational unit. Everything (sources, sessions)
 * is scoped to a workspace.
 *
 * Directory structure:
 * ~/.craft-agent/workspaces/{slug}/
 *   ├── config.json      - Workspace settings
 *   ├── sources/         - Data sources (MCP, API, local)
 *   └── sessions/        - Conversation sessions
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type {
  RootBindingConfig,
  HeadroomConfigOverrides,
  MemoryConfigOverrides,
} from '@craft-agent/core/types';

/**
 * Local MCP server configuration
 * Controls whether stdio-based (local subprocess) MCP servers can be spawned.
 */
export interface LocalMcpConfig {
  /**
   * Whether local (stdio) MCP servers are enabled for this workspace.
   * When false, only HTTP-based MCP servers will be used.
   * Default: true (can be overridden by CRAFT_LOCAL_MCP_ENABLED env var)
   */
  enabled: boolean;
}

/**
 * Token-usage threshold pair for the context-window indicator (PLAN-003).
 *
 * Both values are fractions in the open interval (0, 1).
 *   - `warn`   — green→yellow boundary (e.g. 0.6)
 *   - `danger` — yellow→burnt-orange boundary (e.g. 0.8)
 *
 * Invariant: 0 < warn < danger < 1. The settings UI enforces this on
 * input; the indicator's resolver also drops invalid pairs defensively.
 */
export interface TokenUsageThresholds {
  warn: number;
  danger: number;
}

/**
 * Workspace configuration (stored in config.json)
 */
export interface WorkspaceConfig {
  id: string;
  name: string;
  slug: string; // Folder name (URL-safe)

  /**
   * Default settings for new sessions in this workspace
   */
  defaults?: {
    model?: string;
    /** Default LLM connection for new sessions (slug). Overrides global default. */
    defaultLlmConnection?: string;
    enabledSourceSlugs?: string[]; // Sources to enable by default
    permissionMode?: PermissionMode; // Default permission mode ('safe', 'ask', 'allow-all')
    cyclablePermissionModes?: PermissionMode[]; // Which modes can be cycled with SHIFT+TAB (min 2, default: all 3)
    workingDirectory?: string;
    thinkingLevel?: ThinkingLevel; // Default thinking level for new sessions (default: 'medium')
    colorTheme?: string; // Color theme override for this workspace (preset ID). Undefined = inherit from app default.

    /**
     * Per-provider token-usage threshold defaults (PLAN-003).
     * Keyed by `LlmConnection.providerType` (e.g. 'anthropic', 'pi', 'pi_compat').
     * Missing/invalid entries fall back to the built-in defaults (60% / 80%).
     */
    tokenUsageThresholds?: Record<string, TokenUsageThresholds>;

    /**
     * Per-model token-usage threshold overrides (PLAN-003).
     * Keyed by model ID. Takes precedence over the per-provider default.
     */
    tokenUsageModelOverrides?: Record<string, TokenUsageThresholds>;

    /**
     * Minutes an idle session keeps its warm agent runtime before
     * SessionManager disposes it (PLAN-038). The runtime restarts
     * transparently on the next message. 0 disables eviction (agents stay
     * alive until quit). Default: 60.
     */
    idleAgentTtlMinutes?: number;

    /** Feature flag for the Workbench surface (ADR-0014, PLAN-024). Default off. */
    workbenchEnabled?: boolean;

    /** Feature flag for the Artifact Home surface (ADR-0016, PLAN-025). Default off. */
    artifactsEnabled?: boolean;

    /**
     * Named artifact root bindings (ADR-0016 §2). Advanced override;
     * 'workspace' is reserved and implicit. Value widens additively
     * (ADR-0019 §1): a bare `string` is the filesystem shorthand (absolute
     * path), or a `RootBindingConfig` object keyed by `kind`. Existing
     * string-map configs parse unchanged.
     */
    artifactRoots?: Record<string, string | RootBindingConfig>;

    /**
     * Per-workspace Headroom overrides (fork: PLAN-040, SUV-0016).
     *
     * Same shape as the instance-level base config in the config-root
     * `config.json`, and every field is optional: a field set here wins, a
     * field left unset inherits the instance base, and a field set nowhere
     * takes the disabled default. Merge only via `resolveHeadroomConfig()`
     * from `@craft-agent/core/types` — never read this raw.
     */
    headroom?: HeadroomConfigOverrides;

    /**
     * Per-workspace memory overrides (fork: PLAN-040, SUV-0029; ADR-0031).
     *
     * A **sibling** of `headroom`, not a section inside it — memory is a
     * capability with providers, and Headroom is one of them. Same precedence
     * rules as above; merge only via `resolveMemoryConfig()`.
     */
    memory?: MemoryConfigOverrides;
  };

  /**
   * Local MCP server configuration.
   * Controls whether stdio-based MCP servers can be spawned in this workspace.
   * Resolution order: ENV (CRAFT_LOCAL_MCP_ENABLED) > workspace config > default (true)
   */
  localMcpServers?: LocalMcpConfig;

  createdAt: number;
  updatedAt: number;
}

/**
 * Workspace creation input
 */
export interface CreateWorkspaceInput {
  name: string;
  defaults?: WorkspaceConfig['defaults'];
}

/**
 * Loaded workspace with resolved sources
 */
export interface LoadedWorkspace {
  config: WorkspaceConfig;
  sourceSlugs: string[]; // Available source slugs (not fully loaded to save memory)
  sessionCount: number; // Number of sessions
}

/**
 * Workspace summary for listing (lightweight)
 */
export interface WorkspaceSummary {
  slug: string;
  name: string;
  sourceCount: number;
  sessionCount: number;
  createdAt: number;
  updatedAt: number;
}
