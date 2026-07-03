/**
 * Centralized branding for Craft Agent (VOR-3).
 *
 * Canonical values live in @craft-agent/core/branding so that packages
 * without a dependency on @craft-agent/shared (e.g. apps/viewer) can import
 * them. This module re-exports everything for the rest of the codebase —
 * import from here (`@craft-agent/shared/branding`) unless you can only
 * reach core.
 */
export * from '@craft-agent/core/branding';
