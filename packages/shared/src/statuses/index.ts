/**
 * Statuses Module
 *
 * Configurable session statuses for workspaces.
 */

// Types
export * from './types.ts';

// Built-in status set (single source of truth — see PLAN-031)
export * from './built-in.ts';

// Status-change origin / closure authority (PLAN-031, ADR-0021)
export * from './origin.ts';

// Storage operations
export * from './storage.ts';

// CRUD operations
export * from './crud.ts';

// Validation
export * from './validation.ts';

// Default icons
export * from './default-icons.ts';
