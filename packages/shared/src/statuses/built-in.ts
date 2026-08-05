/**
 * Built-in Statuses — single source of truth
 *
 * PLAN-031. Before this file, "the built-in status set" was asserted independently in five
 * places, and they had already drifted: `getDefaultStatusConfig` omitted `in-progress` while
 * `BuiltInStatusId`, `DEFAULT_ICON_SVGS`, `StatusConfig`'s own doc comment, and `TaskRunner`'s
 * status constants all assumed it existed. The consequence was silent: a workspace seeded from
 * defaults had no `in-progress`, so every TaskRunner-driven run wrote a status that
 * `validateSessionStatus` read back as `todo` — a board where nothing ever appeared to be running.
 *
 * Everything that needs to know the built-in set derives from this array. Adding or removing an
 * entry here is the only supported way to change it; the drift guards in `__tests__/built-in.test.ts`
 * fail if a consumer disagrees.
 *
 * `color` and `icon` are deliberately omitted: colors come from `colors/defaults.ts` and icons are
 * auto-discovered from `statuses/icons/{id}.svg` (seeded by `ensureDefaultIconFiles`).
 */

import type { StatusConfig } from './types.ts';

/**
 * The built-in statuses, in canonical display order.
 *
 * Flag semantics (see `StatusConfig` in `types.ts`):
 * - `isFixed: true`  — cannot be deleted, and its category cannot change. The workflow endpoints
 *   (`todo`, `done`, `cancelled`) that `validateStatusConfig` requires to exist.
 * - `isDefault: true` — can be relabeled/recolored but not deleted (`deleteStatus` refuses both
 *   flags). The right setting for statuses host code hardcodes but users may want to restyle.
 *
 * `in-progress` is `isDefault`, not `isFixed`: `TaskRunner` hardcodes the id so it must not be
 * deletable, but there is no reason a user cannot rename it to "Doing" or recolor it. This matches
 * `needs-review`, which is in the same position, and matches what `types.ts` has always documented.
 */
export const BUILT_IN_STATUSES = [
  { id: 'backlog', label: 'Backlog', category: 'open', isFixed: false, isDefault: true, order: 0 },
  { id: 'todo', label: 'Todo', category: 'open', isFixed: true, isDefault: false, order: 1 },
  {
    id: 'in-progress',
    label: 'In Progress',
    category: 'open',
    isFixed: false,
    isDefault: true,
    order: 2,
  },
  {
    id: 'needs-review',
    label: 'Needs Review',
    category: 'open',
    isFixed: false,
    isDefault: true,
    order: 3,
  },
  { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 4 },
  {
    id: 'cancelled',
    label: 'Cancelled',
    category: 'closed',
    isFixed: true,
    isDefault: false,
    order: 5,
  },
] as const satisfies readonly StatusConfig[];

/**
 * Built-in status ids as a literal union.
 *
 * Derived, not hand-written — this is the drift that started PLAN-031. `satisfies` above (rather
 * than a `: readonly StatusConfig[]` annotation) is load-bearing: an annotation would widen `id`
 * to `string` and collapse this union back to `string`.
 */
export type BuiltInStatusId = (typeof BUILT_IN_STATUSES)[number]['id'];

/** The default status for new sessions. */
export const DEFAULT_STATUS_ID = 'todo' satisfies BuiltInStatusId;

/** Built-in status ids, in canonical order. */
export const BUILT_IN_STATUS_IDS: readonly BuiltInStatusId[] = BUILT_IN_STATUSES.map(s => s.id);

/** True if `id` names a built-in status. */
export function isBuiltInStatusId(id: string): id is BuiltInStatusId {
  return (BUILT_IN_STATUS_IDS as readonly string[]).includes(id);
}
