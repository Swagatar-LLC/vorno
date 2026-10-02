/**
 * Prepare the host's tool-result event for persistence and display.
 * The large-result guard saves binary/oversized payloads, then Headroom compresses
 * the resulting event text and supplies retrieval handles. In Claude this runs
 * AFTER SDK ingestion, so changing this event does not shrink the model's input.
 * Claude's PostToolUse MCP guard owns its actual pre-model replacement and must
 * not be duplicated with a summarizer on this event path. Model-side Headroom
 * integration remains separate work under the accepted SUV-0023 goal.
 * Returning null leaves the host event unchanged.
 */

import type { AgentEvent, HeadroomAdapter } from '@craft-agent/core/types';
import { guardLargeResult } from '../utils/large-response.ts';
import { compressToolOutput } from '../headroom/tool-output.ts';

/** The one event variant this module handles. */
export type ToolResultEvent = Extract<AgentEvent, { type: 'tool_result' }>;

export interface ToolResultContextDeps {
  /** Session folder, where the guard saves oversized and binary results. */
  sessionPath: string;
  /** Summarizer for oversized text — typically `agent.runMiniCompletion`. */
  summarize?: (prompt: string) => Promise<string | null>;
  /** Active model's context window, which scales the guard's threshold. */
  contextWindow?: number;
  /**
   * The session's adapter, resolved lazily.
   *
   * A thunk rather than the adapter itself because the session holds it as a
   * promise built at construction (SUV-0018); awaiting it per call keeps the one
   * instance and adds no ordering requirement at the call site.
   */
  headroom: () => Promise<HeadroomAdapter>;
}

/**
 * Prepare one host tool-result event.
 *
 * @returns The replacement event to yield, or `null` when the result should
 *   remain exactly as it arrived.
 */
export async function prepareToolResultForContext(
  event: ToolResultEvent,
  deps: ToolResultContextDeps,
): Promise<ToolResultEvent | null> {
  const guarded = await guardLargeResult(event.result, {
    sessionPath: deps.sessionPath,
    toolName: event.toolName || 'unknown',
    ...(event.input === undefined ? {} : { input: event.input }),
    ...(deps.summarize === undefined ? {} : { summarize: deps.summarize }),
    ...(deps.contextWindow === undefined ? {} : { contextWindow: deps.contextWindow }),
  });

  const content = guarded ?? event.result;

  const adapter = await deps.headroom();
  const compression = await compressToolOutput(adapter, {
    toolCallId: event.toolUseId,
    ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
    content,
  });

  if (compression.handle !== undefined) {
    // The three Headroom fields travel as one set (SUV-0026): the sizes are
    // produced by the same branch that produces the handle, so a consumer that
    // sees a handle can always state what compression cost and saved.
    return {
      ...event,
      result: compression.content,
      headroomHandle: compression.handle,
      ...(compression.originalBytes === undefined ? {} : { headroomOriginalBytes: compression.originalBytes }),
      ...(compression.compressedBytes === undefined ? {} : { headroomCompressedBytes: compression.compressedBytes }),
    };
  }

  // No compression was accepted. The result is the guard's, or the original —
  // and in the latter case the event is returned unchanged by being not
  // returned at all, so the disabled path produces byte-identical host events.
  return guarded === null ? null : { ...event, result: guarded };
}
