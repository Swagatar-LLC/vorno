/**
 * Resolved config → Headroom adapter, for one session (fork: PLAN-040 / SUV-0018).
 *
 * SUV-0015 built the boundary factory and SUV-0016 built the configuration that
 * should drive it; until now nothing joined them, so the settings toggle decided
 * nothing. This module is that joint, and it is deliberately the *only* one: a
 * session hands over an already-resolved {@link HeadroomConfig} and gets back an
 * adapter, so no call site anywhere gets to decide for itself whether Headroom
 * is on.
 *
 * Three choices worth stating, because each one is a place a future reader will
 * expect something else:
 *
 * - **Config in, not read here.** The caller resolves and passes the config
 *   rather than this module loading it. That is what makes "config is read at
 *   session start" a property of the code and not of timing: a session captures
 *   its config synchronously during construction, and the adapter is built from
 *   that captured snapshot on the next tick. A settings change that lands in
 *   between cannot leak into a session that already started.
 * - **Only `enabled` and `model` cross the seam.** `HeadroomConfig` also carries
 *   `compressionEngines`, `verbosity` and `exposeStats`, and
 *   `HeadroomAdapterOptions` has nowhere to put any of them — those three steer
 *   *calls* (I1) and *surfaces* (SUV-0028), neither of which exists yet.
 *   Widening either type to make them line up early would be inventing a
 *   contract against an SDK surface nobody has verified. They stay resolved and
 *   readable on the session; they do not get smuggled through as extra keys.
 * - **`baseUrl`/`apiKey` are not synthesized.** SUV-0015 pinned the base URL in
 *   the boundary and explicitly refused environment variables as a channel;
 *   SUV-0016's config supplies no endpoint or credential. So there is nothing
 *   truthful to pass, and this module passes nothing. Giving those options a
 *   configured source is its own SUV.
 *
 * Nothing here calls the adapter. Compressing a real turn is I1.
 */

import type {
  HeadroomAdapter,
  HeadroomAdapterOptions,
  HeadroomConfig,
} from '@craft-agent/core/types';
import { createHeadroomAdapter, type HeadroomAdapterDeps } from './index.ts';

/** Session-scoped inputs that are not part of the persisted config. */
export interface SessionHeadroomInput {
  /** The session's resolved model, used as the adapter's default model. */
  model?: string;
  /**
   * Where a degradation warning goes. Defaults to `console.warn`.
   *
   * Injectable because "did it warn?" is an acceptance criterion, and asserting
   * it by monkey-patching the console in every caller's test is worse than a
   * seam.
   */
  onWarn?: (message: string) => void;
}

/**
 * Project a resolved {@link HeadroomConfig} onto the boundary's option shape.
 *
 * Pure and total: every input produces an options object, and keys with no
 * truthful value are absent rather than explicitly `undefined`.
 */
export function headroomAdapterOptionsFor(
  config: HeadroomConfig,
  model?: string,
): HeadroomAdapterOptions {
  return {
    enabled: config.enabled,
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * Build the adapter a session will hold for its whole life.
 *
 * Never throws and never rejects — the factory's guarantee, preserved. When the
 * workspace asked for Headroom and it could not be provided, the session still
 * gets a working (no-op) adapter and the discrepancy is warned about exactly
 * once, at construction: silently running without a feature the user switched on
 * is the failure mode worth a log line. "Off" is not a degradation and is not
 * warned about.
 *
 * @param config Already-resolved effective config for the session's workspace.
 * @param input Session-scoped inputs (model, warning sink).
 * @param deps Test seam, forwarded to the boundary factory. Production passes nothing.
 */
export async function createSessionHeadroomAdapter(
  config: HeadroomConfig,
  input: SessionHeadroomInput = {},
  deps?: HeadroomAdapterDeps,
): Promise<HeadroomAdapter> {
  const options = headroomAdapterOptionsFor(config, input.model);
  const adapter = await createHeadroomAdapter(options, deps);

  if (options.enabled && adapter.kind !== 'sdk') {
    const warn = input.onWarn ?? ((message: string) => console.warn(message));
    warn(
      '[headroom] Headroom is enabled for this workspace but its SDK could not be loaded; ' +
        'this session runs without context compression. Vorno is otherwise unaffected.',
    );
  }

  return adapter;
}
