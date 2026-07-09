/**
 * webhook-ingest — fork(PLAN-014) fork-owned, HTTP-agnostic webhook ingest.
 *
 * Verify → dedup → rate-gate → durable queue → onWebhookEvent seam. Reusable by
 * any host (standalone apps/server today, embedded Electron later).
 */

export {
  resolveJsonPathLite,
  resolveJsonPathLiteString,
  isValidJsonPathLite,
} from './jsonpath-lite.ts';
export { generateHookToken, hashHookToken, tokensMatch, type MintedHookToken } from './tokens.ts';
export { verifyToken, withinBodyCap, verifyHmac } from './verify.ts';
export { extractIdempotencyKey, WebhookDedupStore } from './dedup.ts';
export { WebhookRateGate, type RateDecision } from './rate-gate.ts';
export { WebhookIngestQueue, type IngestQueueEntry } from './ingest-queue.ts';
export {
  createWebhookReceiver,
  type WebhookReceiver,
  type WebhookReceiverDeps,
  type WebhookRequest,
  type WebhookResult,
  type ResolvedWorkspace,
} from './receiver.ts';
