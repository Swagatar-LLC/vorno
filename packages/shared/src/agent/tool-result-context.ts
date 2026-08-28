/**
 * The session loop's tool-result ingest step (fork: PLAN-040 / SUV-0023).
 *
 * Every tool result the backend produces passes through here on its way into
 * session context. Two things happen, in this order, and the order is the whole
 * design:
 *
 * 1. **The large-result guard** (`guardLargeResult`) — unchanged, pre-existing
 *    behaviour. Binary payloads are extracted to disk, oversized text is saved
 *    and summarized, and what comes back is a much smaller stand-in message.
 * 2. **Headroom compression** — applied to *whatever text is actually about to
 *    enter context*, i.e. the guard's replacement when it fired and the raw
 *    result when it did not.
 *
 * Compressing after the guard rather than before it is deliberate. The guard's
 * output is the thing the model will read, so it is the thing worth measuring
 * and shrinking; compressing the pre-guard text would spend a service call on
 * content that is about to be replaced by a file reference anyway. It also means
 * the dominant case — the many results that sit *below* the guard's threshold
 * and today enter context verbatim — is exactly the case compression now covers.
 *
 * Extracted from `claude-agent.ts` so that this step is callable, and therefore
 * testable, on its own. The loop's inline copy was a block that could only be
 * exercised by driving an entire SDK turn; the tests for this SUV run the real
 * function with a real adapter instead of simulating what it does.
 *
 * Returning `null` for "nothing changed" preserves the loop's control flow
 * precisely: the caller falls through to its remaining per-event handlers, which
 * is what it did before when the guard declined.
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
 * Prepare one tool result for session context.
 *
 * @returns The replacement event to yield, or `null` when the result should
 *   enter context exactly as it arrived.
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
  // returned at all, so the disabled path produces byte-identical context.
  return guarded === null ? null : { ...event, result: guarded };
}
