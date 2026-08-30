/**
 * The provider that is always unavailable, with a reason
 * (fork: PLAN-040 / SUV-0029).
 *
 * The memory equivalent of `createNoopHeadroomAdapter`, and it exists for the
 * same reason: **the "off" state is expressed by which provider the host holds,
 * not by a conditional at the call site.** `session-memory.ts` never asks "is
 * memory enabled" — it calls `search`, gets `{available: false, reason:
 * 'disabled'}`, and splices nothing. One code path, whatever the configuration.
 *
 * The reason is carried rather than collapsed to a boolean because the three
 * ways memory can be off are not interchangeable to a user: `disabled` is a
 * setting they chose, `not-configured` is a setting that names nothing valid,
 * and `provider-absent` is software that is missing. Telling someone "absent"
 * when they simply switched it off sends them to reinstall a working thing.
 */

import {
  memoryUnavailable,
  type MemoryProvider,
  type MemoryProviderCapabilities,
  type MemoryProviderState,
  type MemoryRecord,
  type MemoryResult,
  type MemoryUnavailableReason,
} from '@craft-agent/core/types';

export const UNAVAILABLE_PROVIDER_ID = 'unavailable';

const STATE_FOR_REASON: Record<MemoryUnavailableReason, MemoryProviderState> = {
  disabled: 'disabled',
  'not-configured': 'disabled',
  'provider-absent': 'absent',
  'provider-unprovisioned': 'unprovisioned',
  'provider-error': 'absent',
};

const SUMMARY_FOR_REASON: Record<MemoryUnavailableReason, string> = {
  disabled: 'Memory is turned off for this workspace.',
  'not-configured': 'Memory is on but no usable provider is selected.',
  'provider-absent': 'The selected memory provider is not available on this machine.',
  'provider-unprovisioned': 'The selected memory provider is installed but not yet set up.',
  'provider-error': 'The selected memory provider could not be started.',
};

export function createUnavailableMemoryProvider(
  reason: MemoryUnavailableReason = 'disabled',
  detail?: string,
): MemoryProvider {
  const capabilities: MemoryProviderCapabilities = {
    providerId: UNAVAILABLE_PROVIDER_ID,
    state: STATE_FOR_REASON[reason],
    summary: SUMMARY_FOR_REASON[reason],
    search: 'none',
    scopeLayers: [],
    structuredReads: false,
    supersession: false,
    decay: false,
    archive: false,
    retrievalLog: false,
    requiresProvisioning: false,
    egress: 'none',
    notes: detail ? [detail] : [],
  };

  return {
    id: UNAVAILABLE_PROVIDER_ID,
    async search(): Promise<MemoryResult<readonly MemoryRecord[]>> {
      return memoryUnavailable(reason, detail);
    },
    async save(): Promise<MemoryResult<readonly string[]>> {
      return memoryUnavailable(reason, detail);
    },
    async describe(): Promise<MemoryProviderCapabilities> {
      return capabilities;
    },
  };
}
