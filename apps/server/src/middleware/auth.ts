import { validateApiKey, type ServerConfig, type StoredApiKey } from '../config.ts';

/**
 * Validated API key context attached to authenticated requests.
 */
export interface AuthContext {
  apiKey: StoredApiKey;
}

/**
 * Rate limiter using a sliding window per API key.
 */
class RateLimiter {
  private windows: Map<string, number[]> = new Map();

  /**
   * Check if a request is within rate limits.
   * @returns true if allowed, false if rate limited
   */
  check(keyId: string, maxPerMinute: number): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;

    let timestamps = this.windows.get(keyId) ?? [];
    // Remove expired entries
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= maxPerMinute) {
      this.windows.set(keyId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.windows.set(keyId, timestamps);
    return true;
  }

  /**
   * Get remaining requests in the current window.
   */
  remaining(keyId: string, maxPerMinute: number): number {
    const now = Date.now();
    const windowStart = now - 60_000;
    const timestamps = (this.windows.get(keyId) ?? []).filter(t => t > windowStart);
    return Math.max(0, maxPerMinute - timestamps.length);
  }
}

const rateLimiter = new RateLimiter();

/**
 * Authenticate a request using the Authorization header.
 * Returns AuthContext if valid, or a Response to send back.
 */
export function authenticate(
  request: Request,
  config: ServerConfig
): { auth: AuthContext } | { error: Response } {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return {
      error: new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return {
      error: new Response(JSON.stringify({ error: 'Invalid Authorization format. Use: Bearer <api_key>' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  const key = authHeader.slice(7); // Remove "Bearer " prefix

  if (!key.startsWith('craft_sk_')) {
    return {
      error: new Response(JSON.stringify({ error: 'Invalid API key format' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  const apiKey = validateApiKey(key, config);
  if (!apiKey) {
    return {
      error: new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  // Check rate limits
  if (!rateLimiter.check(apiKey.id, config.rateLimits.requestsPerMinute)) {
    const remaining = rateLimiter.remaining(apiKey.id, config.rateLimits.requestsPerMinute);
    return {
      error: new Response(JSON.stringify({
        error: 'Rate limit exceeded',
        retryAfterSeconds: 60,
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'X-RateLimit-Remaining': String(remaining),
        },
      }),
    };
  }

  return { auth: { apiKey } };
}

/**
 * Check if an API key has access to a specific workspace.
 */
export function hasWorkspaceAccess(auth: AuthContext, workspaceId: string): boolean {
  const { workspaceIds } = auth.apiKey.permissions;
  // Empty array means access to all workspaces
  return workspaceIds.length === 0 || workspaceIds.includes(workspaceId);
}

/**
 * Get the effective permission policy (capped by API key's max).
 */
export function getEffectivePolicy(
  auth: AuthContext,
  requested?: 'deny-all' | 'allow-safe' | 'allow-all'
): 'deny-all' | 'allow-safe' | 'allow-all' {
  const policyOrder = ['deny-all', 'allow-safe', 'allow-all'] as const;
  const maxIndex = policyOrder.indexOf(auth.apiKey.permissions.permissionPolicy);
  const requestedIndex = requested ? policyOrder.indexOf(requested) : 0;
  return policyOrder[Math.min(maxIndex, requestedIndex)];
}
