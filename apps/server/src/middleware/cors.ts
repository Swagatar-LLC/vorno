/**
 * CORS headers for the HTTP server.
 * Since this is a local-first server, CORS is permissive by default.
 */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'X-RateLimit-Remaining',
  };
}

/**
 * Handle CORS preflight requests.
 */
export function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}
