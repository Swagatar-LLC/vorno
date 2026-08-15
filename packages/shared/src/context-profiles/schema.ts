/**
 * Context-profile schema — fork(PLAN-030 Phase 3).
 *
 * Strict, unlike `ActionDefinitionSchema`'s deliberate `.passthrough()` catch-all
 * (ADR-0021 §4). The forward-compatibility argument for the catch-all does not transfer:
 * an unknown *action type* must not take a whole `automations.json` down with it, but an
 * unknown *profile key* means someone reached for a context knob that does not exist,
 * and that is precisely the failure PLAN-030 Phase 0 exists to make loud.
 */

import { z } from 'zod';
import { PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';

/**
 * Named so that writing it produces an honest error rather than a bare
 * `Unrecognized key: "skills"`.
 *
 * Skills have no per-session representation to activate. A skill is applied by putting
 * `[skill:<slug>]` in a *message* — `base-agent.ts` parses the mention out of the message
 * text and blocks tool use until the SKILL.md is read. There is no session field, no
 * setter, and nothing in `SESSION_PERSISTENT_FIELDS` for it, so a profile carrying
 * `skills` would either lie or need a new session-state knob invented underneath it.
 * Building that knob is PLAN-032; accepting the key before it exists would ship exactly
 * the silent no-op this plan was written to eliminate.
 */
const SKILLS_REJECTION =
  'Context profiles cannot carry "skills". Skills activate per-message via a '
  + '[skill:<slug>] mention, not per-session — there is no session-level skill state to '
  + 'set. Put the mention in the automation\'s prompt action, or track PLAN-032 '
  + '(session-sticky skills).';

export const ContextProfileSchema = z
  .object({
    id: z.string().min(1, 'Profile id cannot be empty'),
    name: z.string().min(1).optional(),
    workingDirectory: z.string().min(1).optional(),
    sources: z.array(z.string().min(1)).optional(),
    permissionMode: z.enum(PERMISSION_MODE_ORDER).optional(),
    allowEscalation: z.boolean().optional(),
    skills: z.never({ error: SKILLS_REJECTION }).optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.workingDirectory !== undefined
      || p.sources !== undefined
      || p.permissionMode !== undefined,
    'A profile must set at least one of "workingDirectory", "sources", or "permissionMode" '
    + '— a profile that changes nothing is a rule that silently does nothing',
  );

export const WorkspaceContextProfilesConfigSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(ContextProfileSchema),
  })
  .strict()
  .refine(
    (c) => new Set(c.profiles.map((p) => p.id)).size === c.profiles.length,
    'Profile ids must be unique — a duplicate id makes which profile applies depend on file order',
  );
