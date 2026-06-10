import { describe, expect, it } from 'bun:test';
import {
  OPENAI_DEFAULT_BASE_URL,
  buildOpenAiModelList,
  deriveOpenAiModelDefinition,
  isSelectableOpenAiModel,
  openAiModelSupportsReasoning,
  type OpenAiCatalogEntry,
} from './models-openai.ts';

describe('isSelectableOpenAiModel', () => {
  it('keeps current chat + reasoning families', () => {
    for (const id of ['gpt-5', 'gpt-5.1', 'gpt-5-mini', 'o3', 'o3-pro', 'o1-mini', 'o4-mini', 'chatgpt-4o-latest']) {
      expect(isSelectableOpenAiModel(id)).toBe(true);
    }
  });

  it('drops non-chat modalities and legacy/fine-tuned families', () => {
    for (const id of [
      'text-embedding-3-large',
      'text-embedding-ada-002',
      'whisper-1',
      'tts-1',
      'tts-1-hd',
      'dall-e-3',
      'gpt-image-1',
      'omni-moderation-latest',
      'text-moderation-latest',
      'gpt-4o-realtime-preview',
      'gpt-4o-audio-preview',
      'gpt-4o-transcribe',
      'computer-use-preview',
      'gpt-4o', // legacy GPT-4 family (consistent with Pi catalog cleanup)
      'gpt-4.1',
      'gpt-3.5-turbo',
      'babbage-002',
      'davinci-002',
      'codex-mini-latest',
      'ft:gpt-4o:acme::abc123',
      '',
    ]) {
      expect(isSelectableOpenAiModel(id)).toBe(false);
    }
  });

  it('surfaces an unforeseen future chat model (denylist, not allowlist)', () => {
    // The whole point: a brand-new name we have never seen must still appear.
    expect(isSelectableOpenAiModel('gpt-6')).toBe(true);
    expect(isSelectableOpenAiModel('o5-preview')).toBe(true);
  });
});

describe('openAiModelSupportsReasoning', () => {
  it('flags o-series and gpt-5+ (including future numeric families)', () => {
    expect(openAiModelSupportsReasoning('o1')).toBe(true);
    expect(openAiModelSupportsReasoning('o3-pro')).toBe(true);
    expect(openAiModelSupportsReasoning('gpt-5')).toBe(true);
    expect(openAiModelSupportsReasoning('gpt-6')).toBe(true);
    expect(openAiModelSupportsReasoning('gpt-10')).toBe(true);
  });

  it('does not flag pre-5 gpt families', () => {
    expect(openAiModelSupportsReasoning('gpt-4o')).toBe(false);
    expect(openAiModelSupportsReasoning('chatgpt-4o-latest')).toBe(false);
  });
});

describe('deriveOpenAiModelDefinition', () => {
  it('prefixes ids with pi/, derives display name, and uses the fallback context window', () => {
    const def = deriveOpenAiModelDefinition('gpt-5.2');
    expect(def.id).toBe('pi/gpt-5.2');
    expect(def.name).toBe('GPT-5.2');
    expect(def.provider).toBe('pi');
    expect(def.contextWindow).toBe(128_000);
    expect(def.supportsThinking).toBe(true);
  });

  it('prefers catalog metadata when present', () => {
    const catalog: OpenAiCatalogEntry = { name: 'GPT-5', contextWindow: 400_000, reasoning: true };
    const def = deriveOpenAiModelDefinition('gpt-5', catalog);
    expect(def.id).toBe('pi/gpt-5');
    expect(def.name).toBe('GPT-5');
    expect(def.contextWindow).toBe(400_000);
    expect(def.supportsThinking).toBe(true);
  });

  it('humanizes chatgpt + o-series ids', () => {
    expect(deriveOpenAiModelDefinition('chatgpt-4o-latest').name).toBe('ChatGPT-4o-latest');
    expect(deriveOpenAiModelDefinition('o3-pro').name).toBe('o3-pro');
  });
});

describe('buildOpenAiModelList', () => {
  it('filters, enriches, dedupes, and sorts by name', () => {
    const catalog = new Map<string, OpenAiCatalogEntry>([
      ['o3', { name: 'o3', contextWindow: 200_000, reasoning: true }],
    ]);
    const list = buildOpenAiModelList(
      ['gpt-5', 'o3', 'o3', 'text-embedding-3-small', 'gpt-4o', 'whisper-1'],
      catalog,
    );
    expect(list.map(m => m.id)).toEqual(['pi/gpt-5', 'pi/o3']); // GPT-5 sorts before o3, embeddings/legacy/audio dropped
    const o3 = list.find(m => m.id === 'pi/o3')!;
    expect(o3.contextWindow).toBe(200_000); // catalog-enriched
    const gpt5 = list.find(m => m.id === 'pi/gpt-5')!;
    expect(gpt5.contextWindow).toBe(128_000); // not in catalog → fallback
  });

  it('returns [] when nothing is selectable (caller falls back to static catalog)', () => {
    expect(buildOpenAiModelList(['text-embedding-3-large', 'whisper-1', 'gpt-4o'])).toEqual([]);
  });
});

describe('OPENAI_DEFAULT_BASE_URL', () => {
  it('points at the public OpenAI API root', () => {
    expect(OPENAI_DEFAULT_BASE_URL).toBe('https://api.openai.com');
  });
});
