/**
 * Inbound webhook route adapter — fork(PLAN-014)
 *
 * The ONLY apps/server code that touches HTTP for webhooks: parse the URL +
 * body, hand a plain {@link WebhookRequest} to the fork-owned receiver, and map
 * the {@link WebhookResult} back to a Response. All security/ingest logic lives
 * in `packages/shared/src/automations/webhook-ingest/`.
 *
 * Response-code contract (the inbound backoff story):
 *   2xx = durably accepted (provider stops retrying)
 *   404 = uniform for unknown workspace / slug / bad token / disabled hook
 *   413 = body over cap · 429 = rate limited (+ Retry-After)
 */

import { jsonResponse } from '../middleware/error.ts';
import { corsHeaders } from '../middleware/cors.ts';
import type { WebhooksHandle } from '../webhooks/init.ts';
import type { WebhookRequest } from '@craft-agent/shared/automations';

function lowercaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * POST /hooks/:workspace/:hookSlug/:token
 */
export async function handleWebhookRoute(
  request: Request,
  params: { workspace: string; hookSlug: string; token: string },
  webhooks: WebhooksHandle,
): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());

  const req: WebhookRequest = {
    workspace: params.workspace,
    hookSlug: params.hookSlug,
    token: params.token,
    headers: lowercaseHeaders(request.headers),
    rawBody,
  };

  const result = await webhooks.handle(req);

  switch (result.status) {
    case 404:
      return jsonResponse({ error: 'not found' }, 404);
    case 413:
      return jsonResponse({ error: 'payload too large' }, 413);
    case 429:
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(result.retryAfterSeconds),
          ...corsHeaders(),
        },
      });
    case 200:
      return jsonResponse(result.body, 200);
    case 202:
      return jsonResponse(result.body, 202);
  }
}
