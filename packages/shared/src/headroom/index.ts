/**
 * Headroom boundary — public entry point (fork: PLAN-040 / SUV-0015).
 *
 * Import this, never `headroom-ai`. The factory below is the only supported way
 * to obtain a {@link HeadroomAdapter}; it decides between the SDK-backed
 * implementation and the no-op, and it cannot fail.
 *
 * Resolved configuration is wired into it by `session-adapter.ts` (SUV-0018),
 * which is what every session goes through; session-loop and Conductor call
 * sites are I1.
 */

import type { HeadroomAdapter, HeadroomAdapterOptions } from '@craft-agent/core/types';
import { createNoopHeadroomAdapter } from './noop-adapter.ts';
import {
  createSdkClient,
  loadHeadroomSdk,
  SdkHeadroomAdapter,
  type HeadroomSdkModule,
} from './sdk-adapter.ts';

export { createNoopHeadroomAdapter } from './noop-adapter.ts';
export {
  DEFAULT_HEADROOM_BASE_URL,
  SdkHeadroomAdapter,
  createSdkClient,
  loadHeadroomSdk,
} from './sdk-adapter.ts';
export type {
  HeadroomSdkClient,
  HeadroomSdkClientOptions,
  HeadroomSdkModule,
} from './sdk-adapter.ts';
// The session-level joint (SUV-0018). Re-exported after the factory it wraps;
// both are function declarations, so the module cycle resolves before any call.
export {
  createSessionHeadroomAdapter,
  headroomAdapterOptionsFor,
  type SessionHeadroomInput,
} from './session-adapter.ts';

/**
 * Seams for tests. Production callers pass nothing.
 *
 * The loader is injectable because the interesting failure — the SDK package
 * being absent — cannot be provoked in a repo that has it installed. A test
 * supplies a loader whose `import()` names a package that genuinely does not
 * resolve, so the absent-SDK path is exercised with a real module-resolution
 * error rather than a hand-thrown stand-in.
 */
export interface HeadroomAdapterDeps {
  loadSdk?: () => Promise<HeadroomSdkModule>;
}

/**
 * Build the Headroom adapter for a set of already-resolved options.
 *
 * Never throws and never rejects. Returns the no-op adapter — which keeps Vorno
 * fully functional — when Headroom is disabled, when the SDK cannot be loaded,
 * or when constructing the client fails for any reason. The returned adapter's
 * `kind` and the `reason` on its results say which happened.
 *
 * Async because loading the SDK is a dynamic import: keeping the resolution
 * inside the factory is what lets a *failed* load be answered with an adapter
 * instead of an exception at a call site.
 */
export async function createHeadroomAdapter(
  options: HeadroomAdapterOptions,
  deps: HeadroomAdapterDeps = {},
): Promise<HeadroomAdapter> {
  if (!options.enabled) return createNoopHeadroomAdapter('disabled');

  try {
    const sdk = await (deps.loadSdk ?? loadHeadroomSdk)();
    if (typeof sdk?.HeadroomClient !== 'function') {
      // Package resolved but does not export what this boundary needs — an SDK
      // upgrade that moved the entry point looks exactly like this at runtime.
      return createNoopHeadroomAdapter('sdk-unavailable');
    }

    const client = createSdkClient(sdk, {
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

    return new SdkHeadroomAdapter(client, options.model);
  } catch {
    return createNoopHeadroomAdapter('sdk-unavailable');
  }
}
