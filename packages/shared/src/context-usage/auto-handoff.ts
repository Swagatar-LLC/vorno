/**
 * Auto-handoff configuration (fork: PLAN-055, SUV-0072).
 *
 * The built-in consumer of `ContextThresholdReached`: when an interactive
 * session first crosses the workspace's `warn` threshold, the host delivers a
 * user-configured prompt into it (through the same mid-turn path the composer
 * uses, so it never aborts the turn), and once that handoff turn completes it
 * may set a configured status and archive the session.
 *
 * Browser-safe: the settings card and the RPC validator share the shape and
 * the normalizer so what the UI can save is exactly what the host will act on.
 */

import { parseMentions } from '../mentions/index.ts';

/** Persisted under `WorkspaceConfig.defaults.autoHandoff`; every field optional. */
export interface AutoHandoffConfig {
  /** Master switch. Off by default. */
  enabled?: boolean;
  /**
   * The prompt delivered on the first `warn` crossing. May mention skills as
   * `[skill:slug]` (the composer's canonical form) or `@slug`. Blank → the
   * built-in {@link DEFAULT_AUTO_HANDOFF_PROMPT}.
   */
  prompt?: string;
  /** Status id to apply after the handoff turn completes. Absent/blank → leave unchanged. */
  status?: string;
  /** Archive the session after the handoff turn completes. */
  archive?: boolean;
}

/** Hard cap on the stored prompt. Generous for a handoff brief, small enough to stay a setting. */
export const AUTO_HANDOFF_PROMPT_MAX_LENGTH = 20_000;

/**
 * Used when the configured prompt is blank. Agent-facing English, deliberately
 * not localized: it is an instruction to the model, not UI copy. Written so a
 * model with only the session in front of it can act: brief first, then start
 * the successor, then stop.
 */
export const DEFAULT_AUTO_HANDOFF_PROMPT = [
  'This session is approaching its context limit. Prepare a handoff now instead of starting new work.',
  '',
  '1. Write a handoff brief a fresh session can start from: the goal, the decisions made and why, the current state (files, branches, ids, links), open questions, and the exact next steps.',
  '2. Start the successor with the spawn_session tool, passing that brief as the prompt so it inherits this workspace and connection.',
  '3. Reply here with the new session id and a one-line summary, then stop. Do not continue the task in this session.',
].join('\n');

/**
 * Coerce a raw `defaults.autoHandoff` value into a well-typed config, or `null`
 * when it is not an object. Unknown keys are dropped; wrongly typed known keys
 * are dropped rather than failing the whole block, so a hand-edited config
 * degrades to "that field unset" instead of "feature off".
 */
export function normalizeAutoHandoffConfig(raw: unknown): AutoHandoffConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: AutoHandoffConfig = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.prompt === 'string') out.prompt = r.prompt;
  if (typeof r.status === 'string' && r.status.trim() !== '') out.status = r.status.trim();
  if (typeof r.archive === 'boolean') out.archive = r.archive;
  return out;
}

/**
 * Validate a value the settings RPC is about to persist. Returns an error
 * message, or `null` when the value is acceptable. Status existence is checked
 * by the caller, which owns the workspace's status config.
 */
export function validateAutoHandoffConfigShape(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'autoHandoff must be an object';
  const r = raw as Record<string, unknown>;
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return 'autoHandoff.enabled must be a boolean';
  if (r.archive !== undefined && typeof r.archive !== 'boolean') return 'autoHandoff.archive must be a boolean';
  if (r.prompt !== undefined) {
    if (typeof r.prompt !== 'string') return 'autoHandoff.prompt must be a string';
    if (r.prompt.length > AUTO_HANDOFF_PROMPT_MAX_LENGTH) {
      return `autoHandoff.prompt must be at most ${AUTO_HANDOFF_PROMPT_MAX_LENGTH} characters`;
    }
  }
  if (r.status !== undefined && typeof r.status !== 'string') return 'autoHandoff.status must be a status id string';
  return null;
}

/** The prompt the host will actually send: the configured one, or the default when blank. */
export function resolveAutoHandoffPrompt(config: AutoHandoffConfig | null | undefined): string {
  const configured = config?.prompt?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_AUTO_HANDOFF_PROMPT;
}

/** True when the config asks for anything to happen after the handoff turn. */
export function autoHandoffHasFollowThrough(config: AutoHandoffConfig | null | undefined): boolean {
  return Boolean(config && ((config.status && config.status.trim() !== '') || config.archive === true));
}

/**
 * Skill slugs a handoff prompt mentions, restricted to `availableSkillSlugs`.
 * Accepts the composer's canonical `[skill:slug]` form via {@link parseMentions}
 * and the automations-style `@slug` form, so a prompt pasted from either
 * surface resolves the same way. Order is first-mention, de-duplicated.
 */
export function extractAutoHandoffSkillSlugs(prompt: string, availableSkillSlugs: readonly string[]): string[] {
  const available = new Set(availableSkillSlugs);
  const out: string[] = [];
  const push = (slug: string) => {
    if (available.has(slug) && !out.includes(slug)) out.push(slug);
  };
  for (const slug of parseMentions(prompt, [...availableSkillSlugs], []).skills) push(slug);
  const atPattern = /(^|[\s(,;:])@([\w][\w.-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = atPattern.exec(prompt)) !== null) {
    push(match[2]!.replace(/[.]+$/, ''));
  }
  return out;
}
