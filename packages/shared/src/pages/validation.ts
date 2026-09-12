/**
 * Page Config Validation
 *
 * Zod schemas mirroring the page types in @craft-agent/core, applied on every
 * page.json write (validate-on-write, like sources) so malformed configs never
 * reach disk. Read paths stay lenient (parse errors → null) like projects.
 */

import { z } from 'zod';
import { Cron } from 'croner';
import type { ValidationIssue, ValidationResult } from '../config/validators.ts';

// ============================================================================
// Schemas
// ============================================================================

export const PAGE_SLUG_REGEX = /^[a-z0-9-]+$/;

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

/** Thrown when a page slug fails the on-disk safety check. */
export class InvalidPageSlugError extends Error {
  constructor(slug: unknown) {
    const shown = typeof slug === 'string' ? slug.slice(0, 100) : String(slug);
    super(`Invalid page slug: ${JSON.stringify(shown)}`);
    this.name = 'InvalidPageSlugError';
  }
}

/**
 * A page slug is a single on-disk directory name — `[a-z0-9-]+`. The regex
 * alone is the full safety guarantee: it rejects empty strings, `.`/`..`,
 * path separators (`/`, `\`), and absolute/drive prefixes, so a validated
 * slug can never escape `{workspaceRoot}/pages/`. Non-throwing; use it on
 * lenient read/enumeration paths that treat a bad slug as "not found".
 */
export function isValidPageSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && PAGE_SLUG_REGEX.test(slug);
}

/**
 * Assert a slug is safe to turn into a filesystem path. This is the single
 * chokepoint called by getPagePath, so no page path is ever derived from an
 * unsafe slug — closing traversal on delete/read/write (`pages:delete(ws, "..")`
 * → rmSync of the workspace root, cross-workspace read/overwrite via `../..`).
 *
 * @throws InvalidPageSlugError
 */
export function assertValidPageSlug(slug: unknown): asserts slug is string {
  if (!isValidPageSlug(slug)) throw new InvalidPageSlugError(slug);
}

export const PageScriptRuntimeSchema = z.enum(['bun', 'node', 'python3']);

/**
 * Upper bound on a workspace-relative script path. Every other descriptor field
 * is capped (source slugs at 200, tool names at 500, API path patterns at 1000)
 * and this one was not, so it was the way to put unbounded text through a grant
 * descriptor and into a host consent dialog. No real path approaches this —
 * POSIX `PATH_MAX` is typically 1024 for the whole absolute path and 255 per
 * component — so the cap constrains abuse and nothing else.
 */
const SCRIPT_PATH_MAX_CHARS = 500;

/**
 * A workspace-relative script path: bounded, no absolute paths, no ".." escape.
 * The executor re-validates with symlink resolution at run time; this is the
 * static gate shared by refresh specs and script-action grants.
 */
export const WorkspaceRelativeScriptPathSchema = z
  .string()
  .min(1, 'Script path cannot be empty')
  .max(SCRIPT_PATH_MAX_CHARS, `Script path cannot exceed ${SCRIPT_PATH_MAX_CHARS} characters`)
  .superRefine((script, ctx) => {
    if (script.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(script)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Script path must be relative to the workspace root' });
    }
    if (script.split(/[\\/]/).includes('..')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Script path must not contain ".." segments' });
    }
  });

/**
 * Policy floor for scheduled refreshes. The scheduler ticks once a minute and
 * every matching run spawns a script subprocess — an every-minute page refresh
 * is 1,440 spawns/day per page. Five minutes is the documented minimum
 * (resources/docs/pages.md); loosen deliberately, not by accident.
 */
export const PAGE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Consecutive runs sampled for the interval floor — enough to catch bursty patterns like "0,1 0 * * *". */
const CRON_SAMPLE_RUNS = 10;

/**
 * Validate a refresh cron with the SAME engine the scheduler matches with
 * (croner, via automations/cron-matcher.ts) so "valid on write" and "fires at
 * runtime" cannot disagree. Rejects unparseable expressions and timezones,
 * expressions that never fire (e.g. "0 0 30 2 *"), and anything that can run
 * more often than the minimum interval.
 */
function validateRefreshCron(spec: { cron: string; timezone?: string }, ctx: z.RefinementCtx): void {
  let runs: Date[];
  // The whole evaluation stays inside the try: croner validates the EXPRESSION
  // in the constructor but the TIMEZONE lazily, on the first date computation
  // (nextRuns) — both must land as a validation issue, never an exception.
  try {
    const job = new Cron(spec.cron, spec.timezone ? { timezone: spec.timezone } : {});
    runs = job.nextRuns(CRON_SAMPLE_RUNS);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cron'],
      message: `Invalid cron expression or timezone: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  if (runs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cron'],
      message: 'Cron expression never fires (no upcoming run exists — check day-of-month/month combination)',
    });
    return;
  }

  for (let i = 1; i < runs.length; i++) {
    const gapMs = runs[i]!.getTime() - runs[i - 1]!.getTime();
    if (gapMs < PAGE_REFRESH_MIN_INTERVAL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: `Cron runs too frequently (consecutive runs ${Math.round(gapMs / 1000)}s apart); the minimum refresh interval is ${PAGE_REFRESH_MIN_INTERVAL_MS / 60_000} minutes`,
      });
      return;
    }
  }
}

export const PageRefreshSpecSchema = z
  .object({
    cron: z.string().min(1, 'Cron expression cannot be empty'),
    timezone: z.string().min(1).optional(),
    script: WorkspaceRelativeScriptPathSchema,
    args: z.array(z.string()).optional(),
    runtime: PageScriptRuntimeSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    grantId: z.string().min(1, 'Refresh requires a user-approved grant'),
  })
  .superRefine(validateRefreshCron);

export const PageRefreshStatusSchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  durationMs: z.number(),
  error: z.string().optional(),
});

export const PageActionHttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Upper bound on a pinned callback body.
 *
 * Two things bound it and the smaller one wins. A human has to READ this in a
 * host confirmation sheet before approving it, and a body nobody reads is a
 * body nobody consented to — so the cap is set where a dialog stays legible,
 * not where a session's context window gives out. It also has to survive on
 * disk in `page.json` and cross the consent dialog intact.
 */
const SESSION_CALLBACK_MESSAGE_MAX_CHARS = 2000;

/**
 * Upper bound on a pinned target session id. Session ids are generated
 * identifiers, so this only has to be wide enough for one; it exists because
 * the field reaches a host dialog and unbounded text in host chrome is how a
 * descriptor buries the action it is describing.
 */
const SESSION_CALLBACK_ID_MAX_CHARS = 128;

export const PageActionDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api'),
    sourceSlug: z.string().min(1).max(200),
    method: PageActionHttpMethodSchema,
    pathPattern: z.string().min(1, 'Path pattern cannot be empty').max(1000),
  }),
  z.object({
    kind: z.literal('mcp'),
    sourceSlug: z.string().min(1).max(200),
    toolName: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal('script'),
    script: WorkspaceRelativeScriptPathSchema,
    runtime: PageScriptRuntimeSchema.optional(),
    args: z.array(z.string().max(500)).max(20).optional(),
  }),
  z.object({
    kind: z.literal('session'),
    // Non-empty and bounded only. Whether this session EXISTS, and whether it
    // belongs to the workspace that owns the page, are not schema questions —
    // they are answered server-side against live session state before consent
    // is even requested, and again immediately before execution.
    sessionId: z.string().min(1, 'A session callback must name a session').max(SESSION_CALLBACK_ID_MAX_CHARS),
    message: z
      .string()
      .min(1, 'A session callback must carry a message')
      .max(SESSION_CALLBACK_MESSAGE_MAX_CHARS, `Message cannot exceed ${SESSION_CALLBACK_MESSAGE_MAX_CHARS} characters`),
  // `.strict()`, unlike its sibling arms, because a stripped field on THIS
  // descriptor is a silent downgrade of what the page asked for. A page that
  // sends `action: 'set-status'` has to be told no; stripping it would hand
  // back an approved send-message grant for a request that wanted something
  // else, and the page would have no way to tell the difference.
  }).strict(),
]);

/** Client-facing request shape. The host adds the expected content digest after consent. */
export const AddPageGrantInputSchema = z.object({
  action: PageActionDescriptorSchema,
  description: z.string().optional(),
  ttlMs: z.number().finite().positive().optional(),
}).strict();

export const PageActionGrantSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  action: PageActionDescriptorSchema,
  contentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const PageKindSchema = z.enum(['static', 'interactive', 'live']);

export const PageShareInfoSchema = z.object({
  publicationId: z.string().min(1),
  url: z.string().url(),
  publishedRevision: z.string().min(1),
  publishedContentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  includesData: z.boolean(),
  publishedAt: z.number(),
  updatedAt: z.number(),
  passwordProtected: z.boolean(),
  /** Public routes are revoked; retain capability only to retry physical cleanup. */
  cleanupPending: z.boolean().optional(),
  lastPublishError: z.string().max(2000).optional(),
});

export const PageThumbnailInfoSchema = z.object({
  digest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  capturedAt: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const PageConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  slug: z.string().regex(PAGE_SLUG_REGEX, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1, 'Name cannot be empty'),
  description: z.string().optional(),
  kind: PageKindSchema,
  projectId: z.string().min(1).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  refresh: PageRefreshSpecSchema.optional(),
  lastRefresh: PageRefreshStatusSchema.optional(),
  contentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest').optional(),
  grants: z.array(PageActionGrantSchema).optional(),
  share: PageShareInfoSchema.optional(),
  thumbnail: PageThumbnailInfoSchema.optional(),
});

// ============================================================================
// Validation
// ============================================================================

/** Convert Zod error to ValidationIssues (matches validators.ts pattern) */
function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * Validate a page config object (schema-level).
 * Used on every save; invalid configs are rejected before touching disk.
 */
export function validatePageConfig(config: unknown): ValidationResult {
  const result = PageConfigSchema.safeParse(config);
  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }
  return {
    valid: false,
    errors: zodErrorToIssues(result.error, 'page.json'),
    warnings: [],
  };
}
