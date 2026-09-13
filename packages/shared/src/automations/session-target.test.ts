/**
 * SUV-0064 — workspace containment for session targets.
 *
 * The property under test is not "the right session is returned"; it is that a
 * target naming a session in another workspace resolves to nothing, for both
 * the Page callback path and the desktop webhook path that shares this
 * primitive. That was a real exposure before this module: an explicit `{ id }`
 * was answered from a by-id map spanning every loaded workspace, and the action
 * then ran against the calling workspace's root path.
 */

import { describe, expect, it } from 'bun:test';
import { resolveWorkspaceSessionTarget, type WorkspaceSessionLookup } from './session-target.ts';

const WORKSPACE = 'ws_home';
const OTHER = 'ws_other';

function lookupOver(sessions: Record<string, Array<{ id: string; labels?: string[] }>>): WorkspaceSessionLookup {
  return { getSessions: (workspaceId: string) => sessions[workspaceId] ?? [] };
}

describe('resolveWorkspaceSessionTarget', () => {
  it('resolves an explicit id the workspace owns', () => {
    const lookup = lookupOver({ [WORKSPACE]: [{ id: 'sess_a' }, { id: 'sess_b' }] });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { id: 'sess_b' })).toBe('sess_b');
  });

  it('refuses an explicit id another workspace owns', () => {
    // The session exists. It is just not this workspace's, and acting on it
    // with this workspace's root path is the containment break.
    const lookup = lookupOver({ [WORKSPACE]: [{ id: 'sess_a' }], [OTHER]: [{ id: 'sess_elsewhere' }] });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { id: 'sess_elsewhere' })).toBeNull();
  });

  it('refuses an id that exists nowhere', () => {
    const lookup = lookupOver({ [WORKSPACE]: [{ id: 'sess_a' }] });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { id: 'sess_ghost' })).toBeNull();
  });

  it('answers identically for "missing" and "another workspace owns it"', () => {
    const lookup = lookupOver({ [WORKSPACE]: [{ id: 'sess_a' }], [OTHER]: [{ id: 'sess_elsewhere' }] });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { id: 'sess_elsewhere' }))
      .toBe(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { id: 'sess_ghost' })!);
  });

  it('resolves a label to the most recently active session carrying it', () => {
    // `getSessions` is most-recent-first, so the first match wins.
    const lookup = lookupOver({
      [WORKSPACE]: [{ id: 'sess_new', labels: ['ci'] }, { id: 'sess_old', labels: ['ci'] }],
    });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { label: 'ci' })).toBe('sess_new');
  });

  it('matches a valued label entry exactly, not by its base id', () => {
    const lookup = lookupOver({ [WORKSPACE]: [{ id: 'sess_a', labels: ['priority::3'] }] });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { label: 'priority::3' })).toBe('sess_a');
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { label: 'priority' })).toBeNull();
  });

  it('refuses a label carried only by another workspace', () => {
    const lookup = lookupOver({ [WORKSPACE]: [{ id: 'sess_a' }], [OTHER]: [{ id: 'sess_b', labels: ['ci'] }] });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { label: 'ci' })).toBeNull();
  });

  it('refuses an empty workspace id instead of searching everything', () => {
    // `SessionManager.getSessions` filters only when given an id, so passing an
    // empty one through would return every session in the process — the exact
    // containment break this module exists to close, arriving by a different
    // route. Guarded before the lookup rather than after it.
    const everything: WorkspaceSessionLookup = {
      getSessions: () => [{ id: 'sess_a', labels: ['ci'] }, { id: 'sess_b' }],
    };
    expect(resolveWorkspaceSessionTarget(everything, '', { id: 'sess_a' })).toBeNull();
    expect(resolveWorkspaceSessionTarget(everything, '', { label: 'ci' })).toBeNull();
  });

  it('refuses a selector that names neither an id nor a label', () => {
    const lookup = lookupOver({ [WORKSPACE]: [{ id: 'sess_a' }] });
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, {})).toBeNull();
    // An empty string is not a target. Falling through to "pick something"
    // would be the ambient-default behavior ADR-0033 §4 rules out.
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { id: '' })).toBeNull();
    expect(resolveWorkspaceSessionTarget(lookup, WORKSPACE, { label: '' })).toBeNull();
  });
});
