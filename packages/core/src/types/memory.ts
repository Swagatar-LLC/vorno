/**
 * Memory configuration (fork: PLAN-040 / SUV-0029, decided by ADR-0031).
 *
 * Deliberately a **sibling** of `headroom.ts`, not a section inside it. Memory
 * is a capability with providers; Headroom is one provider. If this shape lived
 * under `HeadroomConfig`, then "memory off because Headroom off" would be an
 * architectural fact rather than a configuration, and swapping engines would be
 * a migration through the Headroom settings surface. See ADR-0031 alternative A.
 *
 * Same four constraints as `headroom.ts`, for the same reasons:
 *
 * - **Plain serializable data.** No classes, no functions, no `Date`.
 * - **No I/O.** This file imports nothing. Storage lives in
 *   `@craft-agent/shared`; resolution is pure.
 * - **Flat.** Precedence is field-level, so "workspace wins where set" is
 *   unambiguous without a replace-vs-deep-merge question.
 * - **Disabled by default, everywhere.** PLAN-040 §I0 requires the rollout to
 *   be flag-gated per workspace and reversible, and Vorno must be fully
 *   functional with the feature off.
 *
 * Note what is *not* here: no store path, no Python interpreter, no database
 * file, no embedder model. Provider-specific plumbing belongs to the provider.
 * Every field below is a behaviour a user can reason about regardless of which
 * engine is answering — which is what ADR-0029 meant by relocating ADR-0027's
 * file-first alignment to the interface, and what keeps this schema honest as
 * the provider list grows.
 */

/**
 * The providers a workspace can select, as a closed set.
 *
 * Closed rather than an opaque string (which is what `compressionEngines` had
 * to be, because its catalogue lives in a vendor's package). Here the registry
 * is ours and in-tree, so a typo in a config file should be a rejected layer,
 * not a silent fallthrough to a provider that does not exist.
 */
export type MemoryProviderChoice = 'builtin-markdown' | 'headroom-mcp';

export const MEMORY_PROVIDER_CHOICES: readonly MemoryProviderChoice[] = [
  'builtin-markdown',
  'headroom-mcp',
];

/** Effective memory configuration — every field resolved, nothing optional. */
export interface MemoryConfig {
  /** Master switch. Nothing else in this object has any effect while false. */
  enabled: boolean;

  /**
   * Which provider answers `search`/`save`.
   *
   * Changing this is the whole point of the seam: it is a config change, and no
   * call site anywhere in the codebase names a provider.
   */
  provider: MemoryProviderChoice;

  /** Maximum memories spliced into context per search. Clamped to 1..50. */
  topK: number;

  /**
   * Whether the host searches memory as part of assembling context.
   *
   * Concretely: **once per turn, using the user's message as the query** — not
   * once per session. The host cannot know what a turn will need before the
   * turn runs, so the message is the honest signal available at that point.
   *
   * This is the host-invoked half of ADR-0029 commitment 1. Off means memory
   * exists but nothing reads it automatically — useful for a workspace that
   * wants to accumulate memories before trusting them in prompts.
   */
  autoLoad: boolean;

  /** Whether the host writes memories at save points. */
  autoSave: boolean;

  /**
   * Half-life in days for recency weighting, where a provider supports decay.
   *
   * At exactly one half-life a memory's decay score is 0.5. Providers that do
   * not implement decay ignore this and say so in `describe()`. Clamped to
   * 1..3650; the 60-day default is the `WORK` class half-life from the
   * agentic-memory engine this behaviour is modelled on.
   */
  decayHalfLifeDays: number;

  /**
   * Whether searches reach into cold storage.
   *
   * Default **false**, and that default is load-bearing rather than
   * conservative: an archive that still loads is not an archive, it is a
   * rename. Archived memories are reachable on purpose, never by accident.
   */
  includeArchived: boolean;
}

/**
 * A partial layer as stored on disk: instance base config, or per-workspace
 * overrides. An absent field falls through to the next layer down, ending at
 * {@link MEMORY_CONFIG_DEFAULTS}.
 */
export type MemoryConfigOverrides = Partial<MemoryConfig>;

/**
 * The rollout default: memory off, built-in provider selected, sane weights.
 *
 * `enabled: false` follows the Headroom rollout posture — a context feature
 * ships gated and is turned on deliberately. `provider: 'builtin-markdown'`
 * is the default *selection* underneath that gate because it is the only
 * provider with zero provisioning burden: no Python, no model fetch, no
 * provider key, no egress. A user who flips `enabled` should get working
 * memory, not a setup errand (ADR-0031 commitment 4).
 *
 * `autoLoad` and `autoSave` both default on *within* the gate. A memory
 * feature whose reads and writes are separately off by default would be
 * enabled-but-inert, and "enabled did nothing" is a worse first experience
 * than "enabled did something you can turn off".
 */
export const MEMORY_CONFIG_DEFAULTS: Readonly<MemoryConfig> = Object.freeze({
  enabled: false,
  provider: 'builtin-markdown' as MemoryProviderChoice,
  topK: 5,
  autoLoad: true,
  autoSave: true,
  decayHalfLifeDays: 60,
  includeArchived: false,
});

/** Inclusive bounds for the two numeric fields, exported so the UI can reuse them. */
export const MEMORY_TOP_K_MIN = 1;
export const MEMORY_TOP_K_MAX = 50;
export const MEMORY_HALF_LIFE_MIN_DAYS = 1;
export const MEMORY_HALF_LIFE_MAX_DAYS = 3650;

/** Every field of {@link MemoryConfig}, as a value. */
export type MemoryConfigField = keyof MemoryConfig;

/**
 * The fields an editor iterates over, in display order.
 *
 * Kept beside the interface so a new option cannot be added to the shape
 * without the settings UI noticing it — the UI renders this list rather than
 * hardcoding its own.
 */
export const MEMORY_CONFIG_FIELDS: readonly MemoryConfigField[] = [
  'enabled',
  'provider',
  'topK',
  'autoLoad',
  'autoSave',
  'decayHalfLifeDays',
  'includeArchived',
];

/** Which layer supplied a field's effective value. */
export type MemoryConfigSource = 'workspace' | 'instance' | 'default';

/** Per-field provenance, parallel to {@link MemoryConfig}. */
export type MemoryConfigSources = Record<MemoryConfigField, MemoryConfigSource>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Validate one stored layer.
 *
 * Returns the layer's recognised fields, or `null` if the layer is unusable.
 * The rules are identical to {@link sanitizeHeadroomConfigLayer}'s, deliberately
 * — two config schemas in the same product that disagree about what a corrupt
 * file means is a bug waiting for a support ticket:
 *
 * - **Absent / not an object** → `null` (layer ignored).
 * - **A known field with the wrong type or out of range** → the whole layer is
 *   rejected. Half-trusting a file we know is corrupt is the subtler bug, and
 *   "disabled" is the declared safe state.
 * - **An unknown key** → ignored, layer still usable. A key written by a newer
 *   build must not disable the feature on an older one.
 * - **A known field explicitly `null`/`undefined`** → treated as unset, falling
 *   through to the layer below.
 *
 * Note that out-of-range numbers are *rejected*, not clamped. Clamping here
 * would make the stored file and the effective value silently disagree, and the
 * settings UI would show a number the user never typed.
 *
 * Never throws.
 */
export function sanitizeMemoryConfigLayer(value: unknown): MemoryConfigOverrides | null {
  if (!isPlainObject(value)) return null;

  const out: MemoryConfigOverrides = {};

  if (value.enabled !== undefined && value.enabled !== null) {
    if (typeof value.enabled !== 'boolean') return null;
    out.enabled = value.enabled;
  }

  if (value.provider !== undefined && value.provider !== null) {
    if (typeof value.provider !== 'string') return null;
    if (!MEMORY_PROVIDER_CHOICES.includes(value.provider as MemoryProviderChoice)) {
      return null;
    }
    out.provider = value.provider as MemoryProviderChoice;
  }

  if (value.topK !== undefined && value.topK !== null) {
    if (!isInteger(value.topK)) return null;
    if (value.topK < MEMORY_TOP_K_MIN || value.topK > MEMORY_TOP_K_MAX) return null;
    out.topK = value.topK;
  }

  if (value.autoLoad !== undefined && value.autoLoad !== null) {
    if (typeof value.autoLoad !== 'boolean') return null;
    out.autoLoad = value.autoLoad;
  }

  if (value.autoSave !== undefined && value.autoSave !== null) {
    if (typeof value.autoSave !== 'boolean') return null;
    out.autoSave = value.autoSave;
  }

  if (value.decayHalfLifeDays !== undefined && value.decayHalfLifeDays !== null) {
    if (typeof value.decayHalfLifeDays !== 'number') return null;
    if (!Number.isFinite(value.decayHalfLifeDays)) return null;
    if (
      value.decayHalfLifeDays < MEMORY_HALF_LIFE_MIN_DAYS ||
      value.decayHalfLifeDays > MEMORY_HALF_LIFE_MAX_DAYS
    ) {
      return null;
    }
    out.decayHalfLifeDays = value.decayHalfLifeDays;
  }

  if (value.includeArchived !== undefined && value.includeArchived !== null) {
    if (typeof value.includeArchived !== 'boolean') return null;
    out.includeArchived = value.includeArchived;
  }

  return out;
}

/**
 * Resolve the effective memory configuration.
 *
 * Precedence, applied field by field:
 *
 *     workspace override → instance base → MEMORY_CONFIG_DEFAULTS (disabled)
 *
 * Both arguments are `unknown` because both come off disk. A layer that fails
 * {@link sanitizeMemoryConfigLayer} is treated as absent; this never throws.
 */
export function resolveMemoryConfig(instance?: unknown, workspace?: unknown): MemoryConfig {
  const base = sanitizeMemoryConfigLayer(instance) ?? {};
  const over = sanitizeMemoryConfigLayer(workspace) ?? {};

  return {
    enabled: over.enabled ?? base.enabled ?? MEMORY_CONFIG_DEFAULTS.enabled,
    provider: over.provider ?? base.provider ?? MEMORY_CONFIG_DEFAULTS.provider,
    topK: over.topK ?? base.topK ?? MEMORY_CONFIG_DEFAULTS.topK,
    autoLoad: over.autoLoad ?? base.autoLoad ?? MEMORY_CONFIG_DEFAULTS.autoLoad,
    autoSave: over.autoSave ?? base.autoSave ?? MEMORY_CONFIG_DEFAULTS.autoSave,
    decayHalfLifeDays:
      over.decayHalfLifeDays ??
      base.decayHalfLifeDays ??
      MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays,
    includeArchived:
      over.includeArchived ?? base.includeArchived ?? MEMORY_CONFIG_DEFAULTS.includeArchived,
  };
}

/**
 * Report, field by field, which layer {@link resolveMemoryConfig} took the
 * effective value from — so a settings surface can say "workspace override"
 * without re-deriving precedence for itself.
 *
 * Never throws.
 */
export function resolveMemoryConfigSources(
  instance?: unknown,
  workspace?: unknown,
): MemoryConfigSources {
  const base = sanitizeMemoryConfigLayer(instance) ?? {};
  const over = sanitizeMemoryConfigLayer(workspace) ?? {};

  const sourceOf = (field: MemoryConfigField): MemoryConfigSource => {
    if (over[field] !== undefined) return 'workspace';
    if (base[field] !== undefined) return 'instance';
    return 'default';
  };

  return {
    enabled: sourceOf('enabled'),
    provider: sourceOf('provider'),
    topK: sourceOf('topK'),
    autoLoad: sourceOf('autoLoad'),
    autoSave: sourceOf('autoSave'),
    decayHalfLifeDays: sourceOf('decayHalfLifeDays'),
    includeArchived: sourceOf('includeArchived'),
  };
}
