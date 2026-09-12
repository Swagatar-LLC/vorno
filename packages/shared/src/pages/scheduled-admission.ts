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
 * the audit log then records as fact. What applies without a render still
 * applies here, and `PageActionOriginPolicy.requiresRenderLease` is where that
 * distinction is written down rather than assumed.
 */

import type { PageConfig, PageRefreshSpec } from '@craft-agent/core';
import { loadWorkspaceConfig } from '../workspaces/storage.ts';
import { appendPageActionAudit } from './action-bridge.ts';
import { assertPageRefreshGrant } from './storage.ts';
import { pageActionOriginAllowsKind, pageActionOriginPolicy } from './types.ts';

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
  const audit = (code: string, reason: string) =>
    appendPageActionAudit(
      {
        event: 'page_action_rejected',
        workspaceId: workspace.id,
        origin: 'scheduled-refresh',
        permissionMode: workspace.permissionMode,
        pageSlug: page.slug,
        grantId,
        actionKind: 'script',
        code,
        reason,
      },
      { auditLogPath },
    );

  const refuse = async (code: string, reason: string): Promise<ScheduledAdmissionOutcome> => {
    await audit(code, reason);
    return { ok: false, code, reason };
  };

  // Origin policy first, read from the same table the broker reads. An origin
  // that vanished from the table must stop everything, not fall through.
  const policy = pageActionOriginPolicy('scheduled-refresh');
  if (!policy) return refuse('origin-unattributed', 'The scheduled origin has no policy');
  if (!pageActionOriginAllowsKind('scheduled-refresh', 'script')) {
    return refuse('origin-forbidden', 'A scheduled refresh may not run this action kind');
  }

  // Explore is read-only across the product, and a background script is not an
  // exception to that. Re-read per run, so switching a workspace to Explore
  // stops the next refresh rather than the next restart.
  if (workspace.permissionMode === 'safe') {
    return refuse('permission-mode-forbidden', 'Explore mode does not run scheduled page refreshes');
  }

  // The grant itself: present, still the page's declared refresh grant, bound
  // to current content, unexpired, and descriptor-identical. Delegated to the
  // one existing definition rather than restated — a second copy here is how
  // the scheduled path would start disagreeing with the rest of the product.
  if (!page.refresh || page.refresh.grantId !== grantId) {
    return refuse('grant-not-found', 'Page refresh grant is missing, revoked, or no longer current');
  }
  try {
    assertPageRefreshGrant(page, refresh);
  } catch (error) {
    return refuse('grant-stale', error instanceof Error ? error.message : 'Refresh grant is no longer usable');
  }

  await appendPageActionAudit(
    {
      event: 'page_action_admitted',
      workspaceId: workspace.id,
      origin: 'scheduled-refresh',
      permissionMode: workspace.permissionMode,
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
 * Workspace identity and permission mode, resolved the way the rest of the
 * product resolves it.
 *
 * **Absent is `ask`, not `safe`.** `defaults.permissionMode` is a preference
 * most workspaces never set, and the product default is `ask`
 * (`config/storage.ts`). Reading absence as Explore would not be "failing
 * closed" — it would revoke a capability the user never restricted, silently
 * stopping every scheduled refresh in every workspace that left the setting
 * alone. Only an explicit Explore refuses.
 *
 * The security boundary here is the approved, digest-bound grant; permission
 * mode is an additional restriction layered on top of it, so resolving an
 * unreadable config to the product default is not a privilege escalation.
 */
function safeLoadWorkspace(workspaceRootPath: string): { id: string; permissionMode: 'safe' | 'ask' | 'allow-all' } {
  try {
    const config = loadWorkspaceConfig(workspaceRootPath);
    const mode = config?.defaults?.permissionMode;
    return {
      id: config?.id ?? 'unknown',
      permissionMode: mode === 'safe' || mode === 'allow-all' ? mode : 'ask',
    };
  } catch {
    return { id: 'unknown', permissionMode: 'ask' };
  }
}
