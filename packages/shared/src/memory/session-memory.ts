/**
 * Host-invoked memory for sessions and workflow runs
 * (fork: PLAN-040 / SUV-0029; ADR-0029 commitment 1, generalized by ADR-0031).
 *
 * Modelled directly on `agent/tool-result-context.ts`, which is the codebase's
 * established shape for "the host does something to context at a defined point,
 * and the model is not consulted". The rules copied from it, verbatim in
 * spirit:
 *
 * - **Extracted so it is testable standalone.** No agent, no session, no
 *   Electron — a provider and a config in, a string or `null` out.
 * - **Never branch on the provider's identity.** The disabled path is a
 *   provider that returns unavailable, not an `if` here.
 * - **`null` means "nothing changed".** With memory off, the assembled prompt
 *   must be byte-identical to what it would have been with this module absent.
 *   That is what makes "Vorno is fully functional with the feature off" a
 *   checkable claim rather than a hope.
 *
 * ## Why this is host-invoked and not a tool
 *
 * If memory were an MCP tool the model could call, memory would happen only
 * when the model elected to call it — adherence-dependence, which ADR-0029
 * commitment 1 rules out. It is also what the workspace's own `agentic-memory`
 * source does today, and the reason ADR-0031 records that arrangement as an
 * irony rather than a precedent. Because the host owns this call site, a later
 * slice can fan `search` across providers and merge, or write to one and mirror
 * to another. Composition is out of this slice; precluding it was not an
 * option.
 */

import type {
  MemoryConfig,
  MemoryFact,
  MemoryProvider,
  MemoryRecord,
  MemoryScope,
} from '@craft-agent/core/types';

import { debug } from '../utils/debug.ts';

/** Heading the memory block is spliced in under. */
export const MEMORY_CONTEXT_HEADING = '<memory>';
export const MEMORY_CONTEXT_CLOSING = '</memory>';

/** Longest a single memory may be before it is truncated into context. */
const MAX_MEMORY_CHARS = 1_000;

/** Cap on the whole block, so memory can never crowd out the actual request. */
const MAX_BLOCK_CHARS = 8_000;

export interface MemoryContextRequest {
  readonly query: string;
  readonly scope?: MemoryScope;
  readonly topK?: number;
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}

/** Render retrieved memories as the prompt block. Exported for tests. */
export function renderMemoryBlock(records: readonly MemoryRecord[]): string | null {
  if (records.length === 0) return null;

  const lines: string[] = [
    MEMORY_CONTEXT_HEADING,
    'Relevant memories from earlier sessions, retrieved automatically. Use them as',
    'context; do not quote or cite them unless asked.',
    '',
  ];

  let used = lines.join('\n').length;
  let rendered = 0;

  for (const record of records) {
    // An archived memory carries its uncertainty marker into the prompt. Cold
    // content may never be restated as a current fact, and the marker travels
    // with the content everywhere it goes — including here.
    const prefix = record.archived
      ? '- (from cold storage — was true at one time, unverified since) '
      : '- ';
    const line = `${prefix}${truncate(record.content, MAX_MEMORY_CHARS)}`;
    if (used + line.length + 1 > MAX_BLOCK_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    rendered += 1;
  }

  if (rendered === 0) return null;

  lines.push(MEMORY_CONTEXT_CLOSING);
  return lines.join('\n');
}

/**
 * Search memory and render the context block, or return `null`.
 *
 * `null` covers every reason there is nothing to add — memory disabled,
 * `autoLoad` off, provider unavailable, or simply no matches — because the
 * caller's response to all of them is identical: splice nothing. The *reason*
 * is not swallowed; it goes to the debug log, where a user diagnosing "why is
 * memory not working" can find it, rather than into a prompt where the model
 * would have to reason about our plumbing.
 *
 * Never throws.
 */
export async function loadMemoryContext(
  provider: MemoryProvider,
  config: MemoryConfig,
  request: MemoryContextRequest,
): Promise<string | null> {
  if (!config.enabled || !config.autoLoad) return null;
  if (!request.query || request.query.trim() === '') return null;

  try {
    const result = await provider.search({
      query: request.query,
      ...(request.scope ? { scope: request.scope } : {}),
      topK: request.topK ?? config.topK,
      includeArchived: config.includeArchived,
    });

    if (!result.available) {
      debug('[memory] search unavailable:', result.reason, result.detail ?? '');
      return null;
    }

    return renderMemoryBlock(result.value);
  } catch (error) {
    // The provider contract forbids throwing, but a session must not die if a
    // provider breaks its contract.
    debug('[memory] loadMemoryContext failed:', error);
    return null;
  }
}

/** How many facts a single turn may contribute. Keeps a chatty model bounded. */
export const MAX_FACTS_PER_TURN = 3;

/**
 * The instruction handed to the mini model to turn a finished turn into durable
 * facts.
 *
 * Exported because the exact wording is behaviour, not decoration: it is what
 * keeps the store from filling with restatements of the conversation. The three
 * rules that matter are "durable", "self-contained", and "nothing at all is a
 * valid answer" — without the last one, a model asked for facts will always
 * find some.
 */
export const MEMORY_EXTRACTION_PROMPT = [
  'Read the exchange below and extract at most',
  String(MAX_FACTS_PER_TURN),
  'durable facts worth remembering in future, unrelated sessions.',
  '',
  'Rules:',
  '- A fact must still be true and useful weeks from now. Skip anything about',
  '  the current task, current files, or what was just done.',
  '- Each fact must be self-contained: no pronouns referring to this',
  '  conversation, no "the above", no "as mentioned".',
  '- Prefer preferences, decisions, constraints, and stable facts about the',
  '  person or the project.',
  '- Output one fact per line, no numbering, no bullets, no commentary.',
  '- If there is nothing durable, output exactly: NONE',
].join('\n');

/** Parse the mini model's reply into facts. Exported for tests. */
export function parseExtractedFacts(reply: string | null): MemoryFact[] {
  if (!reply) return [];
  const trimmed = reply.trim();
  if (trimmed === '' || /^none$/i.test(trimmed)) return [];

  return trimmed
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 3 && !/^none$/i.test(line))
    .slice(0, MAX_FACTS_PER_TURN)
    .map((content) => ({ content, importance: 0.5 }));
}

export interface SaveTurnMemoryInput {
  /** The exchange to mine, already assembled by the caller. */
  readonly transcript: string;
  readonly scope?: MemoryScope;
  /**
   * The mini-model call. Returning `null` (or the callback being absent) makes
   * this a no-op — which is the correct degrade, not an error: a workspace with
   * no usable mini model should still be able to read memory.
   */
  readonly summarize?: (prompt: string) => Promise<string | null>;
}

/**
 * Extract durable facts from a finished turn and save them.
 *
 * Returns the ids written, or an empty array — for any reason, including
 * "nothing was worth remembering", which is the common case and not a failure.
 *
 * The cost is one small model call per turn, which is why the whole feature is
 * off by default and `autoSave` is separately switchable underneath the master
 * switch. Never throws.
 */
export async function saveTurnMemory(
  provider: MemoryProvider,
  config: MemoryConfig,
  input: SaveTurnMemoryInput,
): Promise<readonly string[]> {
  if (!config.enabled || !config.autoSave) return [];
  if (!input.summarize) return [];
  if (!input.transcript || input.transcript.trim().length < 40) return [];

  try {
    const reply = await input.summarize(
      `${MEMORY_EXTRACTION_PROMPT}\n\n---\n\n${input.transcript}`,
    );
    const facts = parseExtractedFacts(reply);
    if (facts.length === 0) return [];

    const result = await provider.save({
      facts,
      ...(input.scope ? { scope: input.scope } : {}),
    });

    if (!result.available) {
      debug('[memory] save unavailable:', result.reason, result.detail ?? '');
      return [];
    }
    return result.value;
  } catch (error) {
    debug('[memory] saveTurnMemory failed:', error);
    return [];
  }
}
