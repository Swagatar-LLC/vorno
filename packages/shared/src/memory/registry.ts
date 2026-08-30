/**
 * The memory provider registry (fork: PLAN-040 / SUV-0029; ADR-0031).
 *
 * **This is the file that makes provider choice a config change.** Every
 * `MemoryProviderChoice` maps to a factory here, and nothing else in the
 * codebase names a provider — not the session loop, not the Conductor, not the
 * settings RPC. Swapping engines is a string in a JSON file.
 *
 * ## Static imports, deliberately
 *
 * ADR-0031 verified that Vorno has **no in-process plugin system** and does not
 * invent one: every `await import()` in the codebase uses a static specifier,
 * there is no `vm` and no runtime-resolved module path, and the closest prior
 * "provider seam" (`StorageProvider`) has exactly one hardcoded implementation.
 * Vorno's real extension mechanism is out-of-process MCP sources. So the
 * registry is a `switch`, and the one out-of-process provider rides the
 * existing stdio MCP machinery rather than a loader. A future third provider
 * clears the same bar — in-tree and statically imported, or out-of-process over
 * MCP. Neither route adds a plugin host.
 *
 * ## Never throws
 *
 * {@link createMemoryProvider} always returns a `MemoryProvider`. A missing
 * provider, a broken workspace path, or a constructor that blows up all
 * degrade to {@link createUnavailableMemoryProvider} with a reason. A session
 * must start whether or not memory can.
 */

import type { MemoryConfig, MemoryProvider, MemoryUnavailableReason } from '@craft-agent/core/types';

import { debug } from '../utils/debug.ts';
import {
  BUILTIN_MARKDOWN_PROVIDER_ID,
  createBuiltinMarkdownProvider,
} from './builtin-markdown-provider.ts';
import { HEADROOM_MCP_PROVIDER_ID, createHeadroomMcpProvider } from './headroom-mcp-provider.ts';
import { createUnavailableMemoryProvider } from './unavailable-provider.ts';

/** Everything a provider needs that is not configuration. */
export interface MemoryProviderContext {
  readonly workspaceRootPath: string;
  /** Scoping identity for providers that honour it. */
  readonly userId?: string;
  /** Test seams; ignored by providers that do not use them. */
  readonly now?: () => number;
  readonly randomSuffix?: () => string;
  readonly pythonPath?: string;
}

/** The provider ids this build knows how to construct. */
export const REGISTERED_MEMORY_PROVIDER_IDS: readonly string[] = [
  BUILTIN_MARKDOWN_PROVIDER_ID,
  HEADROOM_MCP_PROVIDER_ID,
];

/**
 * Resolve the configured provider.
 *
 * Order of decisions, and each one is a distinct outcome the user can act on:
 *
 * 1. `enabled === false` → `disabled`. A choice, not a fault.
 * 2. No workspace path → `not-configured`. Nothing can be stored anywhere.
 * 3. Unknown provider id → `not-configured`. Config names something this build
 *    does not have — an older app reading a newer workspace, most likely.
 * 4. Construction threw → `provider-absent`, with the error as detail.
 *
 * Note what this function does **not** do: probe. Construction is cheap and
 * synchronous for both providers; discovering whether Headroom's server
 * actually works costs a subprocess, so it happens lazily inside that provider
 * on first use (`describe()`/`search()`), not at every session start.
 */
export function createMemoryProvider(
  config: MemoryConfig,
  context: MemoryProviderContext,
): MemoryProvider {
  if (!config.enabled) return createUnavailableMemoryProvider('disabled');

  if (!context.workspaceRootPath) {
    return createUnavailableMemoryProvider(
      'not-configured',
      'No workspace path is available, so memory has nowhere to live.',
    );
  }

  try {
    switch (config.provider) {
      case BUILTIN_MARKDOWN_PROVIDER_ID:
        return createBuiltinMarkdownProvider({
          workspaceRootPath: context.workspaceRootPath,
          halfLifeDays: config.decayHalfLifeDays,
          topK: config.topK,
          includeArchived: config.includeArchived,
          ...(context.now ? { now: context.now } : {}),
          ...(context.randomSuffix ? { randomSuffix: context.randomSuffix } : {}),
        });

      case HEADROOM_MCP_PROVIDER_ID:
        return createHeadroomMcpProvider({
          workspaceRootPath: context.workspaceRootPath,
          topK: config.topK,
          ...(context.userId ? { userId: context.userId } : {}),
          ...(context.pythonPath ? { pythonPath: context.pythonPath } : {}),
        });

      default:
        return createUnavailableMemoryProvider(
          'not-configured',
          `Unknown memory provider "${String(config.provider)}".`,
        );
    }
  } catch (error) {
    debug('[memory] provider construction failed:', error);
    return createUnavailableMemoryProvider(
      'provider-absent' as MemoryUnavailableReason,
      String(error),
    );
  }
}
