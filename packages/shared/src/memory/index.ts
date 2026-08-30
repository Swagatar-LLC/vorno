/**
 * Memory — the vendor-neutral provider seam and its implementations
 * (fork: PLAN-040 / SUV-0029 + SUV-0040; ADR-0031).
 *
 * The public surface of `@craft-agent/shared/memory`. Callers want three things
 * from this module and should need nothing else:
 *
 * 1. {@link createMemoryProvider} — turn a resolved `MemoryConfig` into a
 *    provider. Never throws; "off" comes back as a provider that reports
 *    unavailable.
 * 2. {@link loadMemoryContext} — the host-invoked read at context load.
 * 3. {@link saveTurnMemory} — the host-invoked write at a save point.
 *
 * The provider classes are exported for tests and for the settings surface that
 * reports capabilities; ordinary call sites should never name one. If you find
 * yourself importing `BuiltinMarkdownMemoryProvider` outside a test, the seam
 * has sprung a leak — that is the exact failure ADR-0031 was written to
 * prevent, and the fix is a config field, not an import.
 */

export {
  BUILTIN_MARKDOWN_PROVIDER_ID,
  BuiltinMarkdownMemoryProvider,
  createBuiltinMarkdownProvider,
  type BuiltinMarkdownProviderOptions,
} from './builtin-markdown-provider.ts';

export {
  HEADROOM_DB_FILE,
  HEADROOM_MCP_PROVIDER_ID,
  HeadroomMcpMemoryProvider,
  createHeadroomMcpProvider,
  looksLikeMissingEmbedder,
  parseHeadroomSearchProse,
  resolveHeadroomPython,
  type HeadroomMcpProviderOptions,
} from './headroom-mcp-provider.ts';

export {
  UNAVAILABLE_PROVIDER_ID,
  createUnavailableMemoryProvider,
} from './unavailable-provider.ts';

export {
  REGISTERED_MEMORY_PROVIDER_IDS,
  createMemoryProvider,
  type MemoryProviderContext,
} from './registry.ts';

export {
  MAX_FACTS_PER_TURN,
  MEMORY_CONTEXT_CLOSING,
  MEMORY_CONTEXT_HEADING,
  MEMORY_EXTRACTION_PROMPT,
  loadMemoryContext,
  parseExtractedFacts,
  renderMemoryBlock,
  saveTurnMemory,
  type MemoryContextRequest,
  type SaveTurnMemoryInput,
} from './session-memory.ts';

export {
  MEMORY_ARCHIVE_DIR,
  MEMORY_DIR_NAME,
  MEMORY_ENTRIES_DIR,
  MEMORY_RETRIEVAL_LOG,
  appendRetrievalLog,
  archiveMemoryEntry,
  ensureMemoryStore,
  readMemoryEntries,
  readRetrievalLog,
  recordCitations,
  resolveMemoryStorePaths,
  restoreMemoryEntry,
  writeMemoryEntry,
  type MemoryStorePaths,
  type RetrievalLogLine,
} from './markdown-store.ts';

export {
  COLD_STORAGE_BANNER_PREFIX,
  buildMemoryId,
  coldStorageBanner,
  memoryFileName,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryFileEntry,
} from './memory-file.ts';

export {
  DECAY_FRESH_THRESHOLD,
  DECAY_REVIEW_THRESHOLD,
  IMPORTANCE_FLOOR,
  IMPORTANCE_HIGH,
  IMPORTANCE_LOW,
  IMPORTANCE_PINNED,
  RECENCY_FLOOR,
  ageInDays,
  anchorTimestampMs,
  bandFor,
  decayScore,
  effectiveHalfLifeDays,
  normalizeImportance,
  parseTimestamp,
  rankingScore,
  temporalWeight,
  type DecayBand,
  type TemporalWeight,
} from './decay.ts';

export {
  PHRASE_MATCH_BONUS,
  TAG_MATCH_WEIGHT,
  applyScopeTrim,
  isInScope,
  lexicalScore,
  prepareQuery,
  tokenize,
  type PreparedQuery,
} from './lexical.ts';
