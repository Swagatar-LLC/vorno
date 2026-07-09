/**
 * Per-hook rate gate — sliding 60s window keyed `workspaceId:hookId`.
 *
 * fork(PLAN-014). Lifted from the API-key limiter in
 * `apps/server/src/middleware/auth.ts` (sliding window), with an added burst
 * allowance because webhooks arrive in clumps. This is the real limiter for
 * webhooks; the WorkspaceEventBus limit sits above any per-hook ceiling.
 */

const WINDOW_MS = 60_000;

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window frees a slot (only meaningful when !allowed). */
  retryAfterSeconds: number;
}

export class WebhookRateGate {
  private readonly windows = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Admit or reject a request under the given per-minute ceiling plus burst.
   * The effective cap within the window is `perMinute + burst`.
   */
  check(key: string, perMinute: number, burst = 0): RateDecision {
    const now = this.now();
    const windowStart = now - WINDOW_MS;
    const cap = Math.max(1, perMinute + Math.max(0, burst));

    let timestamps = (this.windows.get(key) ?? []).filter((t) => t > windowStart);

    if (timestamps.length >= cap) {
      this.windows.set(key, timestamps);
      // Oldest timestamp in the window frees a slot when it ages out.
      const oldest = timestamps[0]!;
      const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop all state (used by tests). */
  reset(): void {
    this.windows.clear();
  }
}
