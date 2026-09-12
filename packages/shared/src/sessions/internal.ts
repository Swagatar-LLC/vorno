/**
 * Session internals that deliberately do NOT sit on the package barrel.
 *
 * Everything here is reachable — this is TypeScript, not a capability system —
 * but reaching it requires importing
 * `@craft-agent/shared/sessions/internal` by name, which is a reviewable act
 * rather than something autocomplete offers while you are typing `listS…`.
 *
 * The barrel is the surface most code sees, so what it offers is what gets
 * used. Keeping these off it is the difference between "a caller had to mean
 * it" and "a caller found it".
 *
 * SUV-0066.
 */

/**
 * Session metadata INCLUDING pending-plan state, for the host's startup
 * hydration.
 *
 * `pendingPlanExecution` carries `draftInputSnapshot` — text the user typed and
 * did not send. The barrel's `listSessions` strips it at runtime, so the only
 * way to obtain it is this named import. Use it to rebuild a managed session's
 * mirror at cold load and nowhere else; in particular, never hand one of these
 * records to anything that serializes for the wire.
 */
export { listSessionsWithPendingPlan } from './storage.ts'

/**
 * Attach commit hooks to the SHARED persistence queue, for the few suites that
 * must exercise mid-commit behaviour through `SessionManager`.
 *
 * Test-only, and off the barrel on purpose. See the function's own comment for
 * the token/disposer contract and for why a per-instance injection cannot serve
 * those suites.
 */
export {
  installSingletonCommitHooksForTesting,
  currentSingletonCommitHooksForTesting,
} from './persistence-queue.ts'
export type { SessionCommitHooks } from './persistence-queue.ts'
