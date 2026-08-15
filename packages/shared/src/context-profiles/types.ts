/**
 * Context profiles — fork(PLAN-030 Phase 3) / ADR-0022.
 *
 * A named, reviewable bundle of session context knobs, stored once in workspace config
 * and referenced by id from an automation's `apply-context` action.
 *
 * The point is the indirection. One action type per context knob multiplies without
 * bound — N knobs × M rules — and every new knob is another action type, another
 * validation entry, another executor branch, another doc row. A profile inverts that: the
 * knobs grow inside a config file that is reviewed once and reused everywhere, and the
 * automation surface stays at exactly one action type forever. If a future knob looks
 * like it "just needs its own action type", it needs a field here instead.
 */

import type { PermissionMode } from '../agent/mode-types.ts';

/** One named context bundle. Every knob is optional; absent means "leave it alone". */
export interface ContextProfile {
  /** Referenced by `{ "type": "apply-context", "profile": "<id>" }`. */
  id: string;
  /** Optional display name. Purely cosmetic; `id` is the identity. */
  name?: string;
  /** Absolute path. Validated at apply time against the real filesystem. */
  workingDirectory?: string;
  /**
   * Replaces the session's enabled sources wholesale (not a merge) — a profile describes
   * a context, and a context that only ever accumulates sources is not reusable.
   */
  sources?: string[];
  /**
   * Raising this above the session's current mode requires `allowEscalation` (below).
   * Lowering it is always permitted.
   */
  permissionMode?: PermissionMode;
  /**
   * Registration-time opt-in for raising permission mode, deliberately mirroring
   * `allowClosed` on `set-status` (ADR-0021 §2): the authority to do the privileged
   * thing is declared in a reviewed config file, never at runtime.
   *
   * It lives on the *profile* rather than on the action because the profile is the
   * artifact a reviewer reads. Splitting the escalation flag into `automations.json`
   * would mean the file that declares `permissionMode: "allow-all"` cannot tell you
   * whether that escalation is authorized.
   */
  allowEscalation?: boolean;
}

/** `{workspace}/context-profiles/config.json`. */
export interface WorkspaceContextProfilesConfig {
  version: 1;
  profiles: ContextProfile[];
}
