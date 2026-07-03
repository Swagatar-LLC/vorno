/**
 * OpenAI live model enumeration helpers (pure).
 *
 * The Pi driver enumerates OpenAI's `GET /v1/models` live so new model drops appear
 * in the selector without an SDK/dependency upgrade. These helpers — filtering,
 * reasoning classification, and ModelDefinition shaping — are kept SDK-free and
 * side-effect-free so they unit-test in isolation and stay safe to import anywhere
 * (including the renderer), unlike `models-pi.ts` which pulls in `@earendil-works/pi-ai`.
 *
 * Catalog enrichment (context windows, display names) comes from the Pi SDK catalog
 * and is injected by the driver as plain `OpenAiCatalogEntry` data — this module never
 * imports the SDK itself.
 */

import { BACKEND_DISPLAY_NAME } from '../branding.ts';
import type { ModelDefinition } from './models.ts';

/** Default OpenAI API root when a connection doesn't override `baseUrl`. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com';

/** Conservative context-window floor for an OpenAI model we have no catalog metadata for. */
const OPENAI_FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Substrings that mark a model as non-chat (embeddings, audio, image, moderation…).
 * Denylist rather than allowlist on purpose: a brand-new *chat* model with an
 * unforeseen name must still surface — that is the entire point of live enumeration.
 */
const OPENAI_NON_CHAT_SUBSTRINGS = [
  'embedding',
  'moderation',
  'whisper',
  'tts',
  'audio',
  'realtime',
  'transcribe',
  'dall-e',
  'image',
  'search-preview', // retrieval-only chat variants that reject ordinary completions
  'computer-use',
];

/**
 * Legacy / non-chat prefixes intentionally hidden from the selector. The `gpt-4`
 * and `gpt-3.5` exclusions mirror the existing Pi catalog cleanup
 * (`PI_EXCLUDED_MODEL_PREFIXES = ['gpt-4']` in `models-pi.ts`).
 */
const OPENAI_EXCLUDED_PREFIXES = [
  'gpt-3.5',
  'gpt-4',
  'text-', // legacy completion models (text-davinci-* …)
  'davinci',
  'babbage',
  'curie',
  'ada',
  'omni-moderation',
  'codex-mini', // stale alias that fails at runtime in the OpenAI API-key flow (see models-pi.ts)
  'sora', // video-generation family; rejects at /v1/chat/completions
];

/** True when an OpenAI `/v1/models` id should appear in the model selector. */
export function isSelectableOpenAiModel(rawId: string): boolean {
  if (!rawId) return false;
  const id = rawId.toLowerCase();
  if (id.startsWith('ft:')) return false; // fine-tuned models
  if (OPENAI_EXCLUDED_PREFIXES.some(p => id.startsWith(p))) return false;
  if (OPENAI_NON_CHAT_SUBSTRINGS.some(s => id.includes(s))) return false;
  return true;
}

/**
 * Heuristic reasoning-effort support, used only when the SDK catalog has no entry
 * for this id. The o-series (o1, o3, o4, …) and the gpt-5+ families expose reasoning
 * effort; the numeric guard keeps future gpt-6/gpt-10 drops classified correctly.
 */
export function openAiModelSupportsReasoning(rawId: string): boolean {
  const id = rawId.toLowerCase();
  if (/^o\d/.test(id)) return true;
  const gptMatch = id.match(/^gpt-(\d+)/);
  return gptMatch ? Number(gptMatch[1]) >= 5 : false;
}

/**
 * Best-effort context window for an OpenAI id the SDK catalog doesn't know about
 * (i.e. a brand-new drop). Display/sizing only — the catalog value always wins when
 * present, and this never gates a request. Deliberately conservative: under-estimating
 * fills the context bar sooner (safe) rather than overflowing it.
 */
export function inferOpenAiContextWindow(rawId: string): number {
  const id = rawId.toLowerCase();
  if (/^o\d/.test(id)) return 200_000; // o-series reasoning models
  const gptMatch = id.match(/^gpt-(\d+)/);
  if (gptMatch && Number(gptMatch[1]) >= 5) return 400_000; // gpt-5+ large-context families
  return OPENAI_FALLBACK_CONTEXT_WINDOW;
}

/** Catalog metadata that may enrich a live id (from the Pi SDK's static OpenAI catalog). */
export interface OpenAiCatalogEntry {
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

function humanizeOpenAiId(rawId: string): string {
  // gpt-5.1 → GPT-5.1, chatgpt-4o-latest → ChatGPT-4o-latest, o3-pro → o3-pro
  if (rawId.startsWith('chatgpt')) return `ChatGPT${rawId.slice('chatgpt'.length)}`;
  if (rawId.startsWith('gpt')) return `GPT${rawId.slice('gpt'.length)}`;
  return rawId;
}

function deriveShortName(name: string): string {
  if (name.length <= 20) return name;
  return name.split(/[\s-]/).pop() ?? name;
}

/**
 * Shape a live OpenAI model id into a `ModelDefinition`, enriched by the SDK catalog
 * entry when present. The `pi/` prefix routes the model through the Pi backend, matching
 * how the static catalog (`getPiModelsForAuthProvider`) ids its models.
 */
export function deriveOpenAiModelDefinition(rawId: string, catalog?: OpenAiCatalogEntry): ModelDefinition {
  const name = catalog?.name ?? humanizeOpenAiId(rawId);
  const reasoning = catalog?.reasoning ?? openAiModelSupportsReasoning(rawId);
  return {
    id: `pi/${rawId}`,
    name,
    shortName: deriveShortName(name),
    description: `OpenAI model via ${BACKEND_DISPLAY_NAME}`,
    provider: 'pi',
    contextWindow: catalog?.contextWindow ?? inferOpenAiContextWindow(rawId),
    supportsThinking: reasoning,
  };
}

/**
 * Filter + enrich a raw OpenAI `/v1/models` id list into selectable `ModelDefinition`s.
 * Deduplicates and sorts by display name for deterministic output.
 */
export function buildOpenAiModelList(
  rawIds: string[],
  catalog?: Map<string, OpenAiCatalogEntry>,
): ModelDefinition[] {
  const seen = new Set<string>();
  const out: ModelDefinition[] = [];
  for (const rawId of rawIds) {
    if (!rawId || seen.has(rawId)) continue;
    if (!isSelectableOpenAiModel(rawId)) continue;
    seen.add(rawId);
    out.push(deriveOpenAiModelDefinition(rawId, catalog?.get(rawId)));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
