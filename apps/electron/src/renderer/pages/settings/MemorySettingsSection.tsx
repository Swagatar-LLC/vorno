/**
 * MemorySettingsSection (fork: PLAN-040, SUV-0029 + SUV-0040; ADR-0031)
 *
 * The Memory block of Workspace Settings: an enable switch, a provider choice,
 * and one control per option — each labelled with where its effective value
 * came from and each clearable back to the instance default — plus a live
 * report of what the selected provider can actually do.
 *
 * Two halves, and the split is the architectural point:
 *
 * - **Configuration** (top) is pre-resolved by the shared resolver and arrives
 *   in `WorkspaceSettings.memoryView`. This component resolves nothing and
 *   persists a whole workspace override layer through the same
 *   `workspace:settings:update` path every other workspace setting uses.
 * - **Capabilities** (bottom) are *not* configuration. They are live host state
 *   — is the store there, is the embedder provisioned, is the interpreter on
 *   this machine — and they come from the provider's own `describe()`. Nothing
 *   in this file branches on a provider id to decide what a provider can do;
 *   that coupling is exactly what ADR-0031 removed, and re-adding it here would
 *   put the seam's whole benefit back behind a switch statement in the UI.
 *
 * `notes` is rendered in full, deliberately. It is where a provider states its
 * own honest limitations ("lexical, not semantic: paraphrases a vector index
 * would catch will be missed"), and a settings screen that hides the cost of
 * the default option is selling, not informing.
 *
 * The instance base config is displayed, never edited — same posture as the
 * Headroom section: its editing surface is decided together with the
 * server-hosted end-state.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  MEMORY_HALF_LIFE_MAX_DAYS,
  MEMORY_HALF_LIFE_MIN_DAYS,
  MEMORY_PROVIDER_CHOICES,
  MEMORY_TOP_K_MAX,
  MEMORY_TOP_K_MIN,
} from '@craft-agent/core/types'
import type {
  MemoryConfigOverrides,
  MemoryProviderCapabilities,
  MemoryProviderChoice,
} from '@craft-agent/core/types'
import type { MemoryConfigViewDto } from '@craft-agent/shared/protocol'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  SettingsCard,
  SettingsMenuSelect,
  SettingsNumberInput,
  SettingsRow,
  SettingsSection,
} from '@/components/settings'
import {
  buildMemoryRows,
  withMemoryOverride,
  withoutMemoryOverride,
} from '@/lib/memory-settings'
import type { MemoryFieldRow } from '@/lib/memory-settings'

export interface MemorySettingsSectionProps {
  /** The active workspace, or null/undefined before one is selected. */
  workspaceId: string | null | undefined
  /**
   * The resolved config view for the active workspace, or `undefined` when the
   * workspace has no memory config at all (fresh install) or the server
   * predates the field. Either way the section renders with the disabled
   * defaults rather than blank.
   */
  view: MemoryConfigViewDto | undefined
  /**
   * Persist a new workspace override layer. `undefined` clears the layer
   * entirely, putting the workspace back to pure inheritance.
   */
  onSaveOverrides: (next: MemoryConfigOverrides | undefined) => void
}

/**
 * Two-way provenance chip. `instance` and `default` both read as "instance
 * default" — from a workspace's point of view they are the same thing: a value
 * this workspace does not set.
 */
function SourceBadge({ row }: { row: MemoryFieldRow }) {
  const { t } = useTranslation()
  const label = row.overridden
    ? t('settings.memory.sourceWorkspace')
    : t('settings.memory.sourceInstance')
  return (
    <span
      data-memory-source={row.source}
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
        row.overridden
          ? 'bg-foreground/[0.08] text-foreground/70'
          : 'bg-foreground/[0.04] text-muted-foreground',
      )}
    >
      {label}
    </span>
  )
}

/** "Clear" affordance — present only while the workspace sets the field. */
function ClearOverrideButton({
  row,
  onClear,
}: {
  row: MemoryFieldRow
  onClear: () => void
}) {
  const { t } = useTranslation()
  if (!row.overridden) return null
  return (
    <button
      type="button"
      onClick={onClear}
      className="shrink-0 rounded-lg px-2 py-1 text-xs text-foreground/60 transition-colors hover:text-foreground"
    >
      {t('common.clear')}
    </button>
  )
}

/**
 * Fetch the configured provider's self-description for this workspace.
 *
 * Re-fetches whenever the *effective config* changes, because switching
 * provider or flipping the master toggle changes which object `describe()`
 * would even be called on. There is no change event to subscribe to — the
 * things that move a provider between `unprovisioned` and `ready` happen
 * outside the app (a model finishes downloading, an interpreter gets
 * installed) — so a re-read on config change plus a fresh read on mount is the
 * honest ceiling, and stale-response ordering is guarded by the cancel flag.
 *
 * `null` means "not asked yet / cannot ask", which the caller renders as a
 * loading line rather than as absence. A provider that genuinely cannot be
 * reached answers `state: 'absent'` — that is a result, not a null.
 */
function useMemoryCapabilities(
  workspaceId: string | null | undefined,
  configKey: string,
): MemoryProviderCapabilities | null {
  const [caps, setCaps] = React.useState<MemoryProviderCapabilities | null>(null)

  React.useEffect(() => {
    const api = window.electronAPI
    // An older host (or a web client predating this channel) simply has no
    // method here. Keep the loading line rather than inventing an answer.
    if (!workspaceId || !api?.getMemoryCapabilities) {
      setCaps(null)
      return
    }

    let cancelled = false
    setCaps(null)
    void api
      .getMemoryCapabilities(workspaceId)
      .then((next) => {
        if (!cancelled) setCaps(next)
      })
      .catch((error: unknown) => {
        // The channel is non-throwing by contract; if it throws anyway that is
        // a transport fault, and a settings screen must not blank on one.
        console.error('Failed to read memory provider capabilities:', error)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId, configKey])

  return caps
}

/** The provider's own account of itself: state, summary, and stated limits. */
function CapabilitiesPanel({
  caps,
}: {
  caps: MemoryProviderCapabilities | null
}) {
  const { t } = useTranslation()

  if (!caps) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" data-memory-capabilities="loading">
        {t('settings.memory.capabilitiesLoading')}
      </p>
    )
  }

  return (
    <div className="px-3 py-2" data-memory-capabilities={caps.state}>
      <div className="flex items-center gap-2">
        <span
          data-memory-state={caps.state}
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
            caps.state === 'ready'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : caps.state === 'unprovisioned'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'bg-foreground/[0.06] text-muted-foreground',
          )}
        >
          {/* Dynamic key over a closed four-value union; every arm has a key. */}
          {t(`settings.memory.state.${caps.state}`)}
        </span>
        <span className="text-xs text-foreground/80" data-memory-summary>
          {caps.summary}
        </span>
      </div>

      {caps.notes.length > 0 && (
        <>
          <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('settings.memory.capabilitiesNotes')}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {caps.notes.map((note, index) => (
              // Notes are prose from the provider with no stable id; index keys
              // are correct here because the list is replaced wholesale on
              // every re-read and never reordered in place.
              <li key={index} data-memory-note>
                {note}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export function MemorySettingsSection({
  workspaceId,
  view,
  onSaveOverrides,
}: MemorySettingsSectionProps) {
  const { t } = useTranslation()
  const rows = React.useMemo(() => buildMemoryRows(view), [view])
  const byField = React.useMemo(
    () => Object.fromEntries(rows.map((r) => [r.field, r])) as Record<
      MemoryFieldRow['field'],
      MemoryFieldRow
    >,
    [rows],
  )

  // Re-describe when the effective config moves. Serialising it is cheaper and
  // more accurate than listing the two fields we *think* matter today: any new
  // config field automatically re-triggers, which is the same "iterate the
  // exported list" discipline `buildMemoryRows` follows.
  const configKey = React.useMemo(
    () => JSON.stringify(rows.map((r) => r.value)),
    [rows],
  )
  const caps = useMemoryCapabilities(workspaceId, configKey)

  const set = <K extends MemoryFieldRow['field']>(field: K, value: unknown) => {
    onSaveOverrides(withMemoryOverride(view, field, value as never))
  }
  const clear = (field: MemoryFieldRow['field']) => {
    onSaveOverrides(withoutMemoryOverride(view, field))
  }

  // Provider *labels* are a naming question, not a capability question, so a
  // per-id string is fine here — and it is a dynamic key on purpose: adding a
  // provider to the registry surfaces as a missing translation rather than as a
  // silently unlabelled option. What a provider can do is never read from here.
  const providerLabel = (choice: MemoryProviderChoice): string =>
    t(`settings.memory.providerChoice.${choice}`, { defaultValue: choice })

  const enabled = byField.enabled
  const provider = byField.provider
  const topK = byField.topK
  const autoLoad = byField.autoLoad
  const autoSave = byField.autoSave
  const decayHalfLifeDays = byField.decayHalfLifeDays
  const includeArchived = byField.includeArchived

  return (
    <SettingsSection
      title={t('settings.memory.title')}
      description={t('settings.memory.desc')}
    >
      <SettingsCard>
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.memory.enabled')}
              <SourceBadge row={enabled} />
            </span>
          }
          description={t('settings.memory.enabledDesc')}
        >
          <ClearOverrideButton row={enabled} onClear={() => clear('enabled')} />
          <Switch
            aria-label={t('settings.memory.enabled')}
            checked={enabled.value as boolean}
            onCheckedChange={(checked) => set('enabled', checked)}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.memory.provider')}
              <SourceBadge row={provider} />
            </span>
          }
          description={t('settings.memory.providerDesc')}
        >
          <ClearOverrideButton row={provider} onClear={() => clear('provider')} />
          <SettingsMenuSelect
            value={provider.value as MemoryProviderChoice}
            onValueChange={(v) => set('provider', v as MemoryProviderChoice)}
            options={MEMORY_PROVIDER_CHOICES.map((choice) => ({
              value: choice,
              label: providerLabel(choice),
            }))}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.memory.topK')}
              <SourceBadge row={topK} />
            </span>
          }
          description={t('settings.memory.topKDesc')}
        >
          <ClearOverrideButton row={topK} onClear={() => clear('topK')} />
          <SettingsNumberInput
            aria-label={t('settings.memory.topK')}
            value={topK.value as number}
            onCommit={(next) => set('topK', next)}
            min={MEMORY_TOP_K_MIN}
            max={MEMORY_TOP_K_MAX}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.memory.autoLoad')}
              <SourceBadge row={autoLoad} />
            </span>
          }
          description={t('settings.memory.autoLoadDesc')}
        >
          <ClearOverrideButton row={autoLoad} onClear={() => clear('autoLoad')} />
          <Switch
            aria-label={t('settings.memory.autoLoad')}
            checked={autoLoad.value as boolean}
            onCheckedChange={(checked) => set('autoLoad', checked)}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.memory.autoSave')}
              <SourceBadge row={autoSave} />
            </span>
          }
          description={t('settings.memory.autoSaveDesc')}
        >
          <ClearOverrideButton row={autoSave} onClear={() => clear('autoSave')} />
          <Switch
            aria-label={t('settings.memory.autoSave')}
            checked={autoSave.value as boolean}
            onCheckedChange={(checked) => set('autoSave', checked)}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.memory.decayHalfLifeDays')}
              <SourceBadge row={decayHalfLifeDays} />
            </span>
          }
          description={t('settings.memory.decayHalfLifeDaysDesc')}
        >
          <ClearOverrideButton
            row={decayHalfLifeDays}
            onClear={() => clear('decayHalfLifeDays')}
          />
          <SettingsNumberInput
            aria-label={t('settings.memory.decayHalfLifeDays')}
            value={decayHalfLifeDays.value as number}
            onCommit={(next) => set('decayHalfLifeDays', next)}
            min={MEMORY_HALF_LIFE_MIN_DAYS}
            max={MEMORY_HALF_LIFE_MAX_DAYS}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.memory.includeArchived')}
              <SourceBadge row={includeArchived} />
            </span>
          }
          description={t('settings.memory.includeArchivedDesc')}
        >
          <ClearOverrideButton
            row={includeArchived}
            onClear={() => clear('includeArchived')}
          />
          <Switch
            aria-label={t('settings.memory.includeArchived')}
            checked={includeArchived.value as boolean}
            onCheckedChange={(checked) => set('includeArchived', checked)}
          />
        </SettingsRow>
      </SettingsCard>

      <p className="mt-4 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {t('settings.memory.capabilities')}
      </p>
      <p className="mb-2 px-1 text-xs text-muted-foreground">
        {t('settings.memory.capabilitiesDesc')}
      </p>
      <SettingsCard>
        <CapabilitiesPanel caps={caps} />
      </SettingsCard>
    </SettingsSection>
  )
}
