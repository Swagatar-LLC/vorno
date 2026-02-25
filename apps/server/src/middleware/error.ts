import { corsHeaders } from './cors.ts';

/**
 * Create a JSON error response with CORS headers.
 */
export function errorResponse(status: number, message: string, details?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ error: message, ...details }),
    {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    }
  );
}

/**
 * Create a JSON success response with CORS headers.
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    }
  );
}

/**
 * Create an SSE response with proper headers.
 */
export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(),
    },
  });
}
