/**
 * Page Types (shared layer)
 *
 * The domain/protocol types live in @craft-agent/core (renderer-safe); this
 * module re-exports them and adds the storage-layer shapes that carry
 * absolute paths or creation inputs.
 *
 * File structure: see the docblock in @craft-agent/core types/page.ts.
 */

import type {
  PageActionHttpMethod as PageActionHttpMethodValue,
  PageActionDescriptor,
  PageActionGrant,
  PageActionInvocation,
  PageActionOrigin,
  PageConfig,
  PageKind,
  PageRefreshSpec,
} from '@craft-agent/core';

// Re-export the core page types so consumers can import everything from
// '@craft-agent/shared/pages' (mirrors how sources/projects expose types).
export type {
  PageKind,
  PageActionOrigin,
  PageActionAuthority,
  PageScriptRuntime,
  PageRefreshSpec,
  PageRefreshStatus,
  PageSeriesPoint,
  PageDataSnapshot,
  PageActionHttpMethod,
  PageActionDescriptor,
  PageActionGrant,
  PageRenderLease,
  PageActionInvocation,
  PageActionRequest,
  PageActionResult,
  PageShareInfo,
  PageThumbnailInfo,
  PageConfig,
} from '@craft-agent/core';

/**
 * Whether a grant is currently usable: bound to the given content digest and
 * not expired. The single definition of "usable"/"stale" — the render frame,
 * the publish ack requirement, and the get_page stale flag must all agree.
 * Pure and browser-safe (this module is imported by the renderer).
 */
export function isPageGrantUsable(
  grant: Pick<PageActionGrant, 'contentDigest' | 'expiresAt'>,
  contentDigest: string | undefined,
  now: number,
): boolean {
  return contentDigest !== undefined && grant.contentDigest === contentDigest && grant.expiresAt > now;
}

/**
 * The single canonical identity of a grant descriptor.
 *
 * Consent coalescing, renderer dedupe, and deny-memory all mean "the same
 * capability", so they must all agree on what "same" is. Two properties matter
 * and neither comes free from `JSON.stringify(descriptor)`:
 *
 *  - **Field order is not identity.** A page-supplied object preserves its own
 *    key order through schema parsing, so `{kind,method,…}` and `{method,kind,…}`
 *    would otherwise be two identities for one capability — two native prompts
 *    and two persisted grants. Fields are emitted here in a fixed order.
 *  - **Optional fields are normalized the way execution reads them.** A script
 *    with no `runtime` runs as `bun`, and absent `args` runs as `[]`, exactly
 *    as `descriptorEquals` compares them. Omitting that normalization would
 *    split one approved command into several identities.
 *
 * Arrays are JSON-encoded rather than delimiter-joined so a script argument
 * that itself contains the delimiter cannot forge a colliding identity.
 * Pure and browser-safe: the renderer and the RPC host both call it.
 */
export function pageActionDescriptorSignature(descriptor: PageActionDescriptor): string {
  if (descriptor.kind === 'mcp') {
    return JSON.stringify(['mcp', descriptor.sourceSlug, descriptor.toolName]);
  }
  if (descriptor.kind === 'script') {
    return JSON.stringify([
      'script',
      descriptor.script,
      descriptor.runtime ?? 'bun',
      descriptor.args ?? [],
    ]);
  }
  if (descriptor.kind === 'session') {
    // Both fields are identity: the same sentence to a different session, and a
    // different sentence to the same session, are different capabilities. The
    // body is included in full rather than hashed because this signature is
    // compared, never logged — the audit path reads `describeApprovedAction`,
    // which deliberately never sees it.
    return JSON.stringify(['session', descriptor.sessionId, descriptor.message]);
  }
  return JSON.stringify([
    'api',
    descriptor.sourceSlug,
    descriptor.method,
    descriptor.pathPattern,
  ]);
}

/**
 * How each action kind classifies for mutation (ADR-0033 §2).
 *
 * A **mapped type over the union** rather than a lookup object with a string
 * index: adding a kind to `PageActionDescriptor` without adding it here stops
 * compiling, which is the only version of "a new kind cannot silently evade
 * classification" that survives someone who never reads this comment. A plain
 * `Record<string, …>` would accept the union's growth in silence and classify
 * the new kind as `undefined` — the worst answer, because `undefined` is falsy
 * and falsy means non-mutating means no activation proof required.
 *
 * `'conditional'` belongs to `api` alone, and the condition is the method:
 * ADR-0033 fixes GET as the ONLY non-mutating action. `mcp` tools are opaque
 * (a granted "create issue" tool has no method to read), `script` is host
 * command execution, and `session` puts text into a live session running under
 * the user's permission mode, so none can ever be proven read-only.
 */
type PageActionMutationClass = 'always-mutating' | 'conditional-on-method';
const PAGE_ACTION_MUTATION: { [K in PageActionDescriptor['kind']]: PageActionMutationClass } = {
  api: 'conditional-on-method',
  mcp: 'always-mutating',
  script: 'always-mutating',
  session: 'always-mutating',
};

/** Every classified kind, for tests that must enumerate the whole union. */
export const PAGE_ACTION_KINDS = Object.keys(PAGE_ACTION_MUTATION) as PageActionDescriptor['kind'][];

/**
 * Whether an action mutates, and therefore needs fresh trusted-interaction
 * proof. Accepts a grant descriptor or a concrete invocation — they carry the
 * same `kind`, and the two must never disagree about what is privileged.
 *
 * Fails closed twice over. An unrecognized kind is mutating, so a descriptor
 * that reaches here from a future wire version or an untyped JS caller is
 * treated as dangerous rather than waved through; and an `api` action without a
 * readable method is mutating, so a malformed request cannot launder itself
 * into the GET exemption. Pure and browser-safe: the renderer page-bridge
 * (first gate) and the broker (authoritative) both call it, and a second
 * definition on either side is how the two gates start disagreeing.
 */
export function isMutatingPageAction(action: PageActionDescriptor | PageActionInvocation): boolean {
  const mutation: PageActionMutationClass | undefined =
    PAGE_ACTION_MUTATION[action.kind as PageActionDescriptor['kind']];
  if (mutation !== 'conditional-on-method') return true;
  return (action as { method?: unknown }).method !== 'GET';
}

/**
 * Whether a descriptor reaches past the page's own data, and therefore takes
 * the short TTL clamp, the publish refusal, and the loud treatment in every
 * surface that lists grants.
 *
 * A mapped type over the union, for the same reason the mutation table above is
 * one: a new descriptor kind must state which side of this line it sits on
 * before it compiles, rather than defaulting into the permissive side because
 * nobody edited a boolean expression.
 *
 * It lives HERE, not in `storage.ts` where its first caller is, because the
 * renderer needs the same answer and cannot import a module that pulls in Node
 * `fs`. A second copy on the renderer side is how the Share dialog starts
 * offering a publish the host will refuse.
 */
const PAGE_GRANT_PRIVILEGED: { [K in PageActionDescriptor['kind']]: boolean } = {
  // Bounded by an anchored path pattern and a pinned source.
  api: false,
  // Bounded by one named tool on one named source.
  mcp: false,
  // Host command execution.
  script: true,
  // Writes into a live session running under the user's permission mode.
  session: true,
};

/**
 * Whether this action kind is privileged. Unknown kinds are privileged, so a
 * descriptor from a future wire version cannot buy the long TTL or slip past
 * the publish refusal. Pure and browser-safe.
 */
export function isPrivilegedPageGrantKind(kind: PageActionDescriptor['kind']): boolean {
  return PAGE_GRANT_PRIVILEGED[kind] ?? true;
}

/** What one origin is permitted to do, before any grant is even consulted. */
export interface PageActionOriginPolicy {
  /** Must a mutating action carry a host-minted, single-use activation ticket? */
  requiresActivationTicket: boolean;
  /**
   * Must a mutating action additionally clear host-rendered first-use
   * confirmation on this render before its first execution?
   *
   * ADR-0033 §3 names script and session as the kinds that require this, on the
   * assumption that a click in the Page frame could be established as proof for
   * the others. The experiment in `roadmap/evidence/SUV-0065` measured that
   * assumption and it did not hold: no signal at any trust level attributes a
   * gesture to the frame, so a window gesture cannot distinguish "the user
   * clicked this Page's button" from "the user clicked anything at all". The
   * ADR's own safe branch is then binding — use a trusted host-click path for
   * the affected operation or reject it — and the affected operation is every
   * mutating kind, not only the two it expected to need it.
   */
  requiresFirstUseConfirmation: boolean;
}

/**
 * The one place an origin becomes a capability (ADR-0033 §2, §3, §5).
 *
 * Mapped over `PageActionOrigin` for the same reason as the table above: a new
 * origin must state its policy to compile. Nothing here is a default — an
 * origin not in this table does not exist, and an *unattributed* caller gets no
 * entry at all, which is how ADR-0033's "unattributed default that cannot
 * mutate" is enforced rather than described.
 *
 * `scheduled-refresh` is the deliberate asymmetry, and it is narrow. A cron run
 * has no user present to click, so requiring interaction proof would mean no
 * scheduled refresh could ever run. What replaces the click is that the user
 * approved this exact pinned script descriptor when the refresh was persisted,
 * and that approval is re-read from disk before the run. Two callers do it, and
 * they are not interchangeable: `assertPageRefreshGrant` guards persistence and
 * matcher building (a refresh may not be stored or scheduled without a usable
 * grant), while `admitScheduledPageRefresh` is what runs at spawn time and
 * additionally checks the Pages capability, permission mode, and origin policy.
 * Revocation, expiry, and a content change stop the run at both. It is confined to
 * `script` by `pageActionOriginAllowsKind` below — a refresh may never become a
 * route for api/mcp calls that skip activation.
 */
const PAGE_ACTION_ORIGIN_POLICY: { [O in PageActionOrigin]: PageActionOriginPolicy } = {
  'sandboxed-page': { requiresActivationTicket: true, requiresFirstUseConfirmation: true },
  'scheduled-refresh': { requiresActivationTicket: false, requiresFirstUseConfirmation: false },
};

/** Every known origin, for tests that must enumerate the whole union. */
export const PAGE_ACTION_ORIGINS = Object.keys(PAGE_ACTION_ORIGIN_POLICY) as PageActionOrigin[];

/**
 * The policy for an origin, or `null` when the caller is unattributed.
 *
 * Takes `unknown` rather than `PageActionOrigin` because the value it guards is
 * exactly the one the type system cannot vouch for: a host that forgot to
 * attribute, a JS caller, a deserialized object. Typing the parameter would
 * move the check to a place where it is already too late.
 */
export function pageActionOriginPolicy(origin: unknown): PageActionOriginPolicy | null {
  if (typeof origin !== 'string') return null;
  return PAGE_ACTION_ORIGIN_POLICY[origin as PageActionOrigin] ?? null;
}

/**
 * Whether an origin may run this action kind at all. Only the scheduled path is
 * narrowed, and narrowing it here rather than at its one call site means a
 * second scheduled caller inherits the confinement instead of re-deriving it.
 *
 * `session` is the kind this confinement matters most for. A cron tick has no
 * user watching and no interaction proof, so a scheduled callback would be an
 * unattended writer into a live session — recurring prompt injection on a
 * timer. It is excluded by the same clause that excludes api/mcp, and the
 * scheduled admission path additionally refuses anything whose origin policy
 * demands proof a tick cannot produce.
 */
export function pageActionOriginAllowsKind(
  origin: PageActionOrigin,
  kind: PageActionDescriptor['kind'],
): boolean {
  return origin !== 'scheduled-refresh' || kind === 'script';
}

/**
 * Whether a request path contains a directory-traversal segment. Page API
 * invocations are matched against an anchored grant pattern and then handed to
 * fetch, which normalizes `..` — so a grant for `/repos/.*` could otherwise be
 * abused to reach `/repos/../../admin`. Reject such paths before the match so
 * match and execution can never disagree. Decodes one percent-layer first so
 * encoded forms (`%2e%2e`, `..%2f`) are caught too; a malformed encoding is
 * treated as unsafe. Pure and browser-safe — the server-side PageActionBroker
 * (authoritative) and the renderer page-bridge (defense-in-depth) both call it.
 */
export function hasPathTraversal(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // malformed percent-encoding — treat as unsafe
  }
  return decoded.split(/[/\\]/).includes('..');
}


// ============================================================================
// Untrusted invocation parsing
// ============================================================================

/** Bounds shared by every untrusted invocation, wherever it arrives from. */
const MAX_INVOCATION_ID_CHARS = 128;
const MAX_INVOCATION_PATH_CHARS = 2048;
const MAX_INVOCATION_TOOL_NAME_CHARS = 256;
const MAX_INVOCATION_OBJECT_DEPTH = 8;

const INVOCATION_HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function isInvocationObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withinInvocationDepth(value: unknown, depth: number): boolean {
  if (depth < 0) return false;
  if (Array.isArray(value)) return value.every(v => withinInvocationDepth(v, depth - 1));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every(v => withinInvocationDepth(v, depth - 1));
  }
  return true;
}

/**
 * Parse an untrusted value into a `PageActionInvocation`, or null.
 *
 * **The whole kind-specific shape, not just `kind`.** A guard that checked only
 * the discriminant and cast the rest would admit an api invocation whose `path`
 * is a number, and the first `path.startsWith(...)` in validation throws —
 * outside the executor's error handling, so the caller gets an unaudited
 * transport error instead of a refusal. Validating the arms here is what makes
 * "malformed input is a result, not a crash" true.
 *
 * One definition on purpose: the renderer bridge parses page-authored messages
 * and the RPC host parses transport payloads, and the two must not disagree
 * about what a well-formed invocation is. Pure and browser-safe.
 */
export function parsePageActionInvocation(value: unknown): PageActionInvocation | null {
  if (!isInvocationObject(value)) return null;

  if (value.kind === 'api') {
    if (typeof value.method !== 'string' || !INVOCATION_HTTP_METHODS.includes(value.method)) return null;
    if (typeof value.path !== 'string' || value.path.length === 0 || value.path.length > MAX_INVOCATION_PATH_CHARS) {
      return null;
    }
    // Defence in depth: the broker re-checks authoritatively, but keeping `..`
    // off timer- and onload-driven paths costs nothing here.
    if (hasPathTraversal(value.path)) return null;
    if (value.params !== undefined) {
      if (!isInvocationObject(value.params)) return null;
      if (!withinInvocationDepth(value.params, MAX_INVOCATION_OBJECT_DEPTH)) return null;
    }
    return {
      kind: 'api',
      method: value.method as PageActionHttpMethodValue,
      path: value.path,
      ...(value.params !== undefined ? { params: value.params as Record<string, unknown> } : {}),
    };
  }

  if (value.kind === 'mcp') {
    if (typeof value.toolName !== 'string' || value.toolName.length === 0) return null;
    if (value.toolName.length > MAX_INVOCATION_TOOL_NAME_CHARS) return null;
    if (value.args !== undefined) {
      if (!isInvocationObject(value.args)) return null;
      if (!withinInvocationDepth(value.args, MAX_INVOCATION_OBJECT_DEPTH)) return null;
    }
    return {
      kind: 'mcp',
      toolName: value.toolName,
      ...(value.args !== undefined ? { args: value.args as Record<string, unknown> } : {}),
    };
  }

  if (value.kind === 'script') {
    // A bare trigger: script, runtime, and args all come from the matched grant
    // and never from the caller, so there is deliberately nothing to validate.
    return { kind: 'script' };
  }

  if (value.kind === 'session') {
    // Bare trigger, same as `script`. Note what this DISCARDS: a caller that
    // sends `{kind:'session', sessionId:'…', message:'…'}` gets a well-formed
    // trigger with both fields dropped on the floor, so a smuggled target or
    // body cannot reach the executor even by accident. Rejecting the extra
    // fields instead would turn a harmless caller mistake into a refusal
    // without making anything safer.
    return { kind: 'session' };
  }

  return null;
}

/** Whether an untrusted string is a plausible bounded identifier. */
export function isBoundedPageActionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_INVOCATION_ID_CHARS;
}

/**
 * Page creation input (without auto-generated fields)
 */
export interface CreatePageInput {
  name: string;
  description?: string;
  /** Runtime capability class (default: 'interactive') */
  kind?: PageKind;
  /** Stable Project ID to bind this page to */
  projectId?: string;
  /** Initial index.html content (sets contentDigest when provided) */
  content?: string;
}

/**
 * Fully loaded page (config + folder paths)
 */
export interface LoadedPage {
  config: PageConfig;
  /** Absolute path to the page folder */
  folderPath: string;
  /** Absolute path to index.html (may not exist yet) */
  contentPath: string;
  /** Absolute path to the data/ folder */
  dataPath: string;
  /** Absolute path to data/snapshot.json (may not exist yet) */
  snapshotPath: string;
  /** Absolute path to workspace folder */
  workspaceRootPath: string;
  /** Workspace this page belongs to (derived from basename of workspaceRootPath) */
  workspaceId: string;
}
