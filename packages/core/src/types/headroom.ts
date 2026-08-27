/**
 * Headroom integration configuration (fork: PLAN-040 / SUV-0016).
 *
 * Headroom (https://github.com/headroomlabs-ai/headroom) is an external,
 * Apache-2.0 context-management library we *integrate*; we do not fork it and
 * we do not build a competing one. This module defines the configuration data
 * model only — nothing here consumes it yet. The boundary adapter that accepts
 * these options arrives in SUV-0015/SUV-0018; any UI arrives in SUV-0017.
 *
 * Deliberate constraints (SUV-0016 scope):
 *
 * - **Plain serializable data.** No classes, no functions, no `undefined`-only
 *   sentinels, no `Date`. A fully-populated `HeadroomConfig` survives
 *   `JSON.parse(JSON.stringify(...))` unchanged, so a future server-hosted
 *   instance can supply the identical shape over the wire.
 * - **No I/O.** This file imports nothing — not Electron, not `node:fs`, not
 *   `node:path`. Storage lives in `@craft-agent/shared`; resolution is pure.
 * - **Flat.** Precedence is specified as field-level, and a flat shape makes
 *   "workspace wins where set" unambiguous. Nested objects would raise a
 *   replace-vs-deep-merge question the SUV does not answer.
 * - **Disabled by default, everywhere.** Rollout defaults are set by the
 *   benchmark work (plan I0 / SUV-0025), not here.
 */

/**
 * Verbosity steering hint handed to Headroom.
 *
 * PROVISIONAL: the concrete vocabulary the adapter accepts is fixed once the
 * SDK is vetted and pinned (SUV-0014) and the boundary module lands
 * (SUV-0015). These three coarse levels are deliberately engine-agnostic —
 * the plan is explicit that adapter surface is verified at integration time,
 * not from README claims, so this models intent rather than a vendor enum.
 */
export type HeadroomVerbosity = 'terse' | 'balanced' | 'verbose';

export const HEADROOM_VERBOSITY_VALUES: readonly HeadroomVerbosity[] = [
  'terse',
  'balanced',
  'verbose',
];

/**
 * Effective Headroom configuration — every field resolved, nothing optional.
 *
 * The same shape is used at instance level and at workspace level (as a
 * `HeadroomConfigOverrides` partial), so one editor/serializer serves both.
 */
export interface HeadroomConfig {
  /** Master switch. Nothing else in this object has any effect while false. */
  enabled: boolean;

  /**
   * Ordered ids of the compression engines the adapter should enable, most
   * preferred first. Empty means "no compression" even when `enabled` is true.
   *
   * PROVISIONAL: engine ids are opaque strings here on purpose — the real
   * catalogue is whatever the pinned SDK exposes (SUV-0014). Modelling them as
   * an enum now would be inventing a contract we cannot check.
   */
  compressionEngines: string[];

  /** Verbosity steering level passed to the adapter. */
  verbosity: HeadroomVerbosity;

  /**
   * Whether Headroom's context/token statistics are exposed to the rest of the
   * app (token surfaces read them in SUV-0028). Off keeps the integration
   * invisible.
   */
  exposeStats: boolean;
}

/**
 * A partial layer as stored on disk: instance base config, or per-workspace
 * overrides. Every field is optional; an absent field falls through to the
 * next layer down, ending at {@link HEADROOM_CONFIG_DEFAULTS}.
 */
export type HeadroomConfigOverrides = Partial<HeadroomConfig>;

/**
 * The safe default: Headroom off, no engines, neutral verbosity, no stats.
 *
 * This is what a fresh install resolves to, and what any layer that fails
 * validation falls back to. Kept as a factory-style frozen literal; callers
 * that mutate must copy (`resolveHeadroomConfig` always returns a fresh
 * object).
 */
export const HEADROOM_CONFIG_DEFAULTS: Readonly<HeadroomConfig> = Object.freeze({
  enabled: false,
  compressionEngines: [] as string[],
  verbosity: 'balanced' as HeadroomVerbosity,
  exposeStats: false,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one stored layer.
 *
 * Returns the layer's recognised fields, or `null` if the layer is unusable.
 *
 * The fail-safe rule, stated explicitly because "malformed resolves to
 * disabled" and "partial configs merge" pull in opposite directions:
 *
 * - **Absent / not an object** → `null` (layer ignored).
 * - **A known field with the wrong type** → the whole layer is rejected
 *   (`null`). Half-trusting a file we know is corrupt is the subtler bug, and
 *   "disabled" is the declared safe state.
 * - **An unknown key** → ignored, layer still usable. A key written by a newer
 *   build must not disable the feature on an older one. Note the difference
 *   from Zod's non-strict `.strip()`: unknown keys are dropped *knowingly*
 *   here, not silently as a side effect of parsing.
 * - **A known field explicitly set to `null`/`undefined`** → treated as unset,
 *   falling through to the layer below. This is what makes a workspace layer
 *   able to override some fields and inherit the rest.
 *
 * Never throws.
 */
export function sanitizeHeadroomConfigLayer(
  value: unknown,
): HeadroomConfigOverrides | null {
  if (!isPlainObject(value)) return null;

  const out: HeadroomConfigOverrides = {};

  if (value.enabled !== undefined && value.enabled !== null) {
    if (typeof value.enabled !== 'boolean') return null;
    out.enabled = value.enabled;
  }

  if (value.compressionEngines !== undefined && value.compressionEngines !== null) {
    if (!Array.isArray(value.compressionEngines)) return null;
    if (!value.compressionEngines.every((e) => typeof e === 'string')) return null;
    out.compressionEngines = [...(value.compressionEngines as string[])];
  }

  if (value.verbosity !== undefined && value.verbosity !== null) {
    if (typeof value.verbosity !== 'string') return null;
    if (!HEADROOM_VERBOSITY_VALUES.includes(value.verbosity as HeadroomVerbosity)) {
      return null;
    }
    out.verbosity = value.verbosity as HeadroomVerbosity;
  }

  if (value.exposeStats !== undefined && value.exposeStats !== null) {
    if (typeof value.exposeStats !== 'boolean') return null;
    out.exposeStats = value.exposeStats;
  }

  return out;
}

/**
 * Resolve the effective Headroom configuration.
 *
 * Precedence, applied field by field:
 *
 *     workspace override → instance base → HEADROOM_CONFIG_DEFAULTS (disabled)
 *
 * A field the workspace layer leaves unset inherits the instance base; a field
 * neither layer sets takes the disabled default. This mirrors the shape of the
 * existing `resolveThresholds()` precedence (per-model → per-provider →
 * default) rather than reusing its machinery — the tiers are different.
 *
 * Both arguments are `unknown` because both come off disk. A layer that fails
 * {@link sanitizeHeadroomConfigLayer} is treated as absent; this function never
 * throws.
 *
 * @param instance Instance-level base config (config-root `config.json`).
 * @param workspace Per-workspace overrides (workspace `config.json`).
 * @returns A fresh, fully-populated, plain-serializable config.
 */
export function resolveHeadroomConfig(
  instance?: unknown,
  workspace?: unknown,
): HeadroomConfig {
  const base = sanitizeHeadroomConfigLayer(instance) ?? {};
  const over = sanitizeHeadroomConfigLayer(workspace) ?? {};

  return {
    enabled: over.enabled ?? base.enabled ?? HEADROOM_CONFIG_DEFAULTS.enabled,
    compressionEngines: [
      ...(over.compressionEngines ??
        base.compressionEngines ??
        HEADROOM_CONFIG_DEFAULTS.compressionEngines),
    ],
    verbosity: over.verbosity ?? base.verbosity ?? HEADROOM_CONFIG_DEFAULTS.verbosity,
    exposeStats:
      over.exposeStats ?? base.exposeStats ?? HEADROOM_CONFIG_DEFAULTS.exposeStats,
  };
}
