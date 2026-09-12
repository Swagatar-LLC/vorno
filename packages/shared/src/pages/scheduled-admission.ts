/**
 * Admission for the scheduled-refresh origin (ADR-0033 §2, §5).
 *
 * The broker is the authoritative gate for actions a *render* asks for. A cron
 * refresh has no render, so it never enters the broker — which meant the
 * `scheduled-refresh` origin existed in the policy table and was enforced
 * nowhere a user's machine actually runs. ADR-0033 §5 is explicit that
 * "recurring refresh execution must use a user-approved, declared grant and
 * undergo the same invocation checks", so this closes that gap on the real
 * path: the scheduler calls it immediately before spawning.
 *
 * It deliberately does NOT execute anything. The hardened argv/no-shell runner
 * in `automations/script-executor.ts` already owns spawning, and a second
 * execution path is exactly the thing that drifts from the first. This is the
 * decision, and the spawn stays where it is.
 *
 * **Honest authority, no fake render.** There is no lease, no nonce, no
 * activation ticket, and none is invented — a synthetic lease would be a lie
 * the audit log then records as fact.
 *
 * The render/no-render distinction is structural rather than a flag: the
 * lease, nonce, and replay checks live in `PageActionBroker.validate`, which
 * only a rendered action reaches, and this function calls the shared primitive
 * without them. There is nothing to declare because there is nothing that could
 * branch on the declaration — a policy field for it would be a value no code
 * reads, and flipping it would change nothing.
 */

import type { PageActionAuthority, PageConfig, PageRefreshSpec } from '@craft-agent/core';
import { loadWorkspaceConfig, readStoredPermissionMode } from '../workspaces/storage.ts';
import { appendPageActionAudit } from './action-bridge.ts';
import { authorizePageAction } from './admission.ts';
import { isPagesEnabled } from './capability.ts';
import { refreshDescriptorMatches } from './storage.ts';
import { pageActionOriginAllowsKind, pageActionOriginPolicy, type PageActionOriginPolicy } from './types.ts';

/**
 * Whether a policy row is one a cron tick can actually satisfy.
 *
 * Pure and exported so the refusal is *provable* rather than asserted: the
 * scheduled path structurally cannot produce an activation ticket (no click) or
 * a first-use confirmation (no window), and if a future edit flips either cell
 * for this origin the honest response is to stop running — not to keep running
 * while a table says otherwise.
 *
 * Split out because the live table makes both cells false, so the branch is not
 * reachable through `admitScheduledPageRefresh` today. A guard nobody can
 * execute is a guard nobody can trust, so the logic lives here where a test
 * calls it with the rows that do not exist yet.
 */
export function scheduledPolicyRefusal(
  policy: PageActionOriginPolicy,
): { code: string; reason: string } | null {
  if (policy.requiresActivationTicket) {
    return { code: 'activation-required', reason: 'A scheduled refresh cannot produce an activation ticket' };
  }
  if (policy.requiresFirstUseConfirmation) {
    return { code: 'first-use-confirmation-required', reason: 'A scheduled refresh has no window to confirm in' };
  }
  return null;
}

export type ScheduledAdmissionOutcome =
  | { ok: true }
  | { ok: false; code: string; reason: string };

export interface ScheduledAdmissionInput {
  workspaceRootPath: string;
  page: PageConfig;
  refresh: PageRefreshSpec;
  /** The grant id the cached matcher claims; must still be the page's own. */
  grantId: string;
  /** Test seam for the audit destination. */
  auditLogPath?: string;
}

/**
 * Decide whether one scheduled refresh run may proceed, and audit the decision
 * either way.
 *
 * Every refusal is recorded, because a refresh that silently stops running is
 * indistinguishable from one that was never scheduled — and "my dashboard went
 * stale and nothing said why" is the report this prevents.
 */
export async function admitScheduledPageRefresh(
  input: ScheduledAdmissionInput,
): Promise<ScheduledAdmissionOutcome> {
  const { workspaceRootPath, page, refresh, grantId, auditLogPath } = input;

  const workspace = safeLoadWorkspace(workspaceRootPath);
  /**
   * The same `PageActionAuthority` shape the broker is given, constructed here
   * because this is the host for a cron tick. Built as a value rather than
   * spelled as a literal at each use so the origin, workspace, and mode that
   * the policy is checked against are provably the ones the audit records.
   */
  const authority: PageActionAuthority = {
    workspaceId: workspace.id,
    origin: 'scheduled-refresh',
    permissionMode: workspace.permissionMode,
  };

  // The durable row carries closed codes and bounded identifiers only.
  // `reason` is returned to the caller and surfaced in the blocked-run message,
  // where it can name the script or the mismatch; it is not persisted, because
  // it interpolates content. See `describeApprovedAction` for the full contract.
  const audit = (code: string) =>
    appendPageActionAudit(
      {
        event: 'page_action_rejected',
        workspaceId: authority.workspaceId,
        origin: authority.origin,
        permissionMode: authority.permissionMode,
        pageSlug: page.slug,
        grantId,
        actionKind: 'script',
        code,
      },
      { auditLogPath },
    );

  const refuse = async (code: string, reason: string): Promise<ScheduledAdmissionOutcome> => {
    await audit(code);
    return { ok: false, code, reason };
  };

  // The origin policy, ENFORCED rather than displayed. An origin missing from
  // the table stops everything; a row demanding something a cron tick cannot
  // produce — an activation ticket, a first-use confirmation — stops this run
  // rather than letting it proceed while the table says otherwise.
  const policy = pageActionOriginPolicy(authority.origin);
  if (!policy) return refuse('origin-unattributed', 'The scheduled origin has no policy');
  const unsatisfiable = scheduledPolicyRefusal(policy);
  if (unsatisfiable) return refuse(unsatisfiable.code, unsatisfiable.reason);

  // Pages is a per-workspace capability and the matcher that scheduled this run
  // may be older than the setting. A workspace that turned Pages off between
  // the last matcher rebuild and this tick must not get one more refresh out of
  // the stale schedule, so the capability is re-read per run like everything
  // else on this path.
  if (!isPagesEnabled(workspaceRootPath)) {
    return refuse('pages-disabled', 'Pages are disabled for this workspace');
  }

  // The page must still declare THIS grant as its refresh grant — a cached
  // matcher can name one the config has since replaced.
  if (!page.refresh || page.refresh.grantId !== grantId) {
    return refuse('grant-not-found', 'Page refresh grant is missing, revoked, or no longer current');
  }

  // Origin policy, workspace, content digest, grant existence/binding/expiry,
  // kind confinement, and permission mode all come from the shared primitive —
  // the same call the broker makes. A second copy here is exactly how the
  // background path would start answering the question differently.
  const admission = authorizePageAction({
    page,
    grantId,
    // A cron tick is a bare trigger, identical in shape to the one a Page sends
    // for a script grant.
    invocation: { kind: 'script' },
    authority,
    now: Date.now(),
  });
  if (!admission.ok) return refuse(admission.code, admission.reason);

  // The only genuinely refresh-specific check: a spec and its grant are two
  // records that can drift apart, which has no analogue for a rendered action.
  if (!refreshDescriptorMatches(admission.grant, refresh)) {
    return refuse('grant-stale', 'Scheduled refresh must exactly match its approved script grant');
  }

  await appendPageActionAudit(
    {
      event: 'page_action_admitted',
      workspaceId: authority.workspaceId,
      origin: authority.origin,
      permissionMode: authority.permissionMode,
      pageSlug: page.slug,
      grantId,
      actionKind: 'script',
      // No lease, nonce, or activation: a cron run has no render and none is
      // invented. Recorded explicitly so the log says which checks applied.
      renderBound: false,
    },
    { auditLogPath },
  );
  return { ok: true };
}

/**
 * Workspace identity and permission mode.
 *
 * **Absent and corrupt are different, and the earlier version of this function
 * treated them the same.** It resolved both to `ask` and justified it with a
 * comment claiming that "resolving an unreadable config to the product default
 * is not a privilege escalation" — which is wrong for the corrupt case, because
 * a stored `"safe"` that failed to parse would silently become a mode that runs
 * mutations.
 *
 * - **Absent** (`undefined`) is a legacy workspace that never set the field.
 *   The product contract is that this means `ask` (`config/storage.ts` resolves
 *   `workspaceDefaults.permissionMode` to `'ask'`), and reading it as Explore
 *   would revoke a capability the user never restricted, silently stopping
 *   refreshes everywhere the setting was left alone.
 * - **Present but unrecognized** is corruption, truncation, or a downgrade from
 *   a future version. Something was stored and cannot be honoured, and the only
 *   safe reading of an unhonourable restriction is the most restrictive one.
 * - **Unreadable config** is the same class: a restriction may exist and cannot
 *   be read.
 *
 * A corrupt value therefore refuses; a missing one does not.
 */
function safeLoadWorkspace(workspaceRootPath: string): { id: string; permissionMode: 'safe' | 'ask' | 'allow-all' } {
  let id = 'unknown';
  try {
    id = loadWorkspaceConfig(workspaceRootPath)?.id ?? 'unknown';
  } catch {
    return { id, permissionMode: 'safe' };
  }
  const stored = readStoredPermissionMode(workspaceRootPath);
  if (stored.state === 'valid') return { id, permissionMode: stored.mode };
  if (stored.state === 'absent') return { id, permissionMode: 'ask' };
  return { id, permissionMode: 'safe' };
}
