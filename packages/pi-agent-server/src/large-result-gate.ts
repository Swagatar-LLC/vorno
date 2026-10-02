/**
 * Large-result summary gate for the Pi subprocess (decision model, toggle
 * `largeResults`). The decision layer (settings, keys, recorder) lives in the
 * main process, so the gate asks it over the JSONL protocol, like pre-tool-use
 * checks. A reply that never comes counts as "no answer": summarize as before.
 */

import type { LargeResultSummaryGate } from '../../shared/src/utils/large-response.ts';
import type { PiLargeResultGateRequest } from '../../shared/src/agent/backend/pi/protocol.ts';
import { DECISION_MAX_DEADLINE_MS } from '../../shared/src/decisions/types.ts';

/** How much of the result is sent; more than the main-process gate reads. */
export const LARGE_RESULT_GATE_TEXT_CHARS = 8_000;
/** Safety net for a lost reply: the longest allowed decision deadline plus slack. */
export const LARGE_RESULT_GATE_TIMEOUT_MS = DECISION_MAX_DEADLINE_MS + 5_000;

export function createLargeResultGateClient(
  send: (request: PiLargeResultGateRequest) => void,
  timeoutMs: number = LARGE_RESULT_GATE_TIMEOUT_MS,
): { gate: LargeResultSummaryGate; handleResponse: (requestId: string, summarize: boolean | null) => void } {
  const pending = new Map<string, (summarize: boolean | null) => void>();
  // Unique per subprocess, so a late answer meant for a crashed predecessor never matches.
  const nonce = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  const gate: LargeResultSummaryGate = ({ text, context, estimatedTokens }) =>
    new Promise((resolve) => {
      const requestId = `pi-lrg-${nonce}-${++counter}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (summarize: boolean | null) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(summarize);
      };
      timer = setTimeout(() => settle(null), timeoutMs);
      pending.set(requestId, settle);
      send({
        type: 'large_result_gate_request',
        requestId,
        toolName: context.toolName,
        ...(context.intent ? { intent: context.intent } : {}),
        text: text.slice(0, LARGE_RESULT_GATE_TEXT_CHARS),
        estimatedTokens,
      });
    });

  return { gate, handleResponse: (requestId, summarize) => pending.get(requestId)?.(summarize) };
}
