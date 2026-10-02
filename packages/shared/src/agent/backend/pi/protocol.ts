/** Raw Pi SDK context metadata on JSONL events/responses. No runtime imports. */
export interface PiContextUsagePayload {
  contextUsage?: { tokens: number | null; contextWindow: number; percent?: number | null };
  compactionSettings?: { enabled: boolean; reserveTokens: number };
}

export interface PiCompactResult extends PiContextUsagePayload {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Fresh local estimate supplied by the SDK, not pre-compaction API usage. */
  estimatedTokensAfter?: number;
}

/**
 * Subprocess → main: should this large tool result be summarized? The decision
 * layer lives in the main process (decision model, toggle `largeResults`).
 */
export interface PiLargeResultGateRequest {
  type: 'large_result_gate_request';
  requestId: string;
  toolName: string;
  intent?: string;
  /** The start of the result; the gate reads less than this. */
  text: string;
  estimatedTokens: number;
}

/** Main → subprocess: `false` = the preview and saved file are enough; `true`/`null` = summarize. */
export interface PiLargeResultGateResponse {
  type: 'large_result_gate_response';
  requestId: string;
  summarize: boolean | null;
}
