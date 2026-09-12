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
 * (a granted "create issue" tool has no method to read) and `script` is host
 * command execution, so neither can ever be proven read-only.
 */
type PageActionMutationClass = 'always-mutating' | 'conditional-on-method';
const PAGE_ACTION_MUTATION: { [K in PageActionDescriptor['kind']]: PageActionMutationClass } = {
  api: 'conditional-on-method',
  mcp: 'always-mutating',
  script: 'always-mutating',
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

/** What one origin is permitted to do, before any grant is even consulted. */
export interface PageActionOriginPolicy {
  /** May this origin run a mutating action at all? */
  mayMutate: boolean;
  /** Must a mutating action carry a host-minted, single-use activation ticket? */
  requiresActivationTicket: boolean;
  /**
   * Must script/session kinds additionally clear host-rendered first-use
   * confirmation on this render before their first execution?
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
 * `host-ui` is held to exactly the same bar as `sandboxed-page` on purpose.
 * It is the stricter reading: host chrome initiating a granted action is still
 * acting on a Page's approved capability, and an origin that relaxed a check
 * would become the cheapest thing for a future caller to claim.
 *
 * `scheduled-refresh` is the deliberate asymmetry, and it is narrow. A cron run
 * has no user present to click, so requiring interaction proof would mean no
 * scheduled refresh could ever run. What replaces the click is that the user
 * approved this exact pinned script descriptor when the refresh was persisted,
 * and `assertPageRefreshGrant` re-reads that approval from disk at spawn time,
 * so revocation, expiry, and a content change all stop it. It is confined to
 * `script` by `pageActionOriginAllowsKind` below — a refresh may never become a
 * route for api/mcp calls that skip activation.
 */
const PAGE_ACTION_ORIGIN_POLICY: { [O in PageActionOrigin]: PageActionOriginPolicy } = {
  'host-ui': { mayMutate: true, requiresActivationTicket: true, requiresFirstUseConfirmation: true },
  'sandboxed-page': { mayMutate: true, requiresActivationTicket: true, requiresFirstUseConfirmation: true },
  'scheduled-refresh': { mayMutate: true, requiresActivationTicket: false, requiresFirstUseConfirmation: false },
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
