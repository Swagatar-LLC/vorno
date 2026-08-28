/**
 * HeadroomSettingsSection (fork: PLAN-040, SUV-0017)
 *
 * The Headroom block of Workspace Settings: an enable switch plus one control
 * per option, each labelled with where its effective value came from and each
 * clearable back to the instance default.
 *
 * This component is a *view*. It resolves nothing: effective values, the
 * instance fallback, and per-field provenance all arrive pre-computed from the
 * SUV-0016 resolver via `WorkspaceSettings.headroom`, and every edit is
 * persisted as a whole workspace override layer through the same
 * `workspace:settings:update` path every other workspace setting uses. Nothing
 * here reads the toggle at runtime — wiring Headroom to anything that actually
 * runs is SUV-0018.
 *
 * The instance base config is displayed, never edited: its editing surface is
 * decided together with the server-hosted end-state.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { HEADROOM_VERBOSITY_VALUES } from '@craft-agent/core/types'
import type {
  HeadroomConfigOverrides,
  HeadroomVerbosity,
} from '@craft-agent/core/types'
import type { HeadroomConfigViewDto } from '@craft-agent/shared/protocol'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  SettingsCard,
  SettingsMenuSelect,
  SettingsRow,
  SettingsSection,
} from '@/components/settings'
import {
  buildHeadroomRows,
  formatCompressionEngines,
  parseCompressionEngines,
  withHeadroomOverride,
  withoutHeadroomOverride,
} from '@/lib/headroom-settings'
import type { HeadroomFieldRow } from '@/lib/headroom-settings'

export interface HeadroomSettingsSectionProps {
  /**
   * The resolved view for the active workspace, or `undefined` when the
   * workspace has no Headroom config at all (fresh install) or the server
   * predates the field. Either way the section renders with the disabled
   * defaults rather than blank.
   */
  view: HeadroomConfigViewDto | undefined
  /**
   * Persist a new workspace override layer. `undefined` clears the layer
   * entirely, putting the workspace back to pure inheritance.
   */
  onSaveOverrides: (next: HeadroomConfigOverrides | undefined) => void
}

/**
 * Two-way provenance chip. `instance` and `default` both read as "instance
 * default" — from a workspace's point of view they are the same thing: a value
 * this workspace does not set.
 */
function SourceBadge({ row }: { row: HeadroomFieldRow }) {
  const { t } = useTranslation()
  const label = row.overridden
    ? t('settings.workspace.headroomSourceWorkspace')
    : t('settings.workspace.headroomSourceInstance')
  return (
    <span
      data-headroom-source={row.source}
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
  row: HeadroomFieldRow
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
 * Comma-separated engine-id editor. Local draft state so typing a list does
 * not write on every keystroke; commits on blur and on Enter.
 */
function CompressionEnginesInput({
  value,
  onCommit,
}: {
  value: string[]
  onCommit: (engines: string[]) => void
}) {
  const { t } = useTranslation()
  const formatted = formatCompressionEngines(value)
  const [draft, setDraft] = React.useState(formatted)

  // Adopt externally-changed values (a clear, or a workspace switch) without
  // clobbering an in-progress edit.
  React.useEffect(() => {
    setDraft(formatted)
  }, [formatted])

  const commit = () => {
    const parsed = parseCompressionEngines(draft)
    setDraft(formatCompressionEngines(parsed))
    onCommit(parsed)
  }

  return (
    <Input
      aria-label={t('settings.workspace.headroomCompressionEngines')}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      placeholder={t('settings.workspace.headroomCompressionEnginesPlaceholder')}
      className="h-8 w-56 text-sm"
    />
  )
}

export function HeadroomSettingsSection({
  view,
  onSaveOverrides,
}: HeadroomSettingsSectionProps) {
  const { t } = useTranslation()
  const rows = React.useMemo(() => buildHeadroomRows(view), [view])
  const byField = React.useMemo(
    () => Object.fromEntries(rows.map((r) => [r.field, r])) as Record<
      HeadroomFieldRow['field'],
      HeadroomFieldRow
    >,
    [rows],
  )

  const set = <K extends HeadroomFieldRow['field']>(field: K, value: unknown) => {
    onSaveOverrides(
      withHeadroomOverride(view, field, value as never),
    )
  }
  const clear = (field: HeadroomFieldRow['field']) => {
    onSaveOverrides(withoutHeadroomOverride(view, field))
  }

  const verbosityLabel = (v: HeadroomVerbosity): string =>
    v === 'terse'
      ? t('settings.workspace.headroomVerbosityTerse')
      : v === 'verbose'
        ? t('settings.workspace.headroomVerbosityVerbose')
        : t('settings.workspace.headroomVerbosityBalanced')

  const enabled = byField.enabled
  const engines = byField.compressionEngines
  const verbosity = byField.verbosity
  const exposeStats = byField.exposeStats

  return (
    <SettingsSection
      title={t('settings.workspace.headroom')}
      description={t('settings.workspace.headroomDesc')}
    >
      <SettingsCard>
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.workspace.headroomEnabled')}
              <SourceBadge row={enabled} />
            </span>
          }
          description={t('settings.workspace.headroomEnabledDesc')}
        >
          <ClearOverrideButton row={enabled} onClear={() => clear('enabled')} />
          <Switch
            aria-label={t('settings.workspace.headroomEnabled')}
            checked={enabled.value as boolean}
            onCheckedChange={(checked) => set('enabled', checked)}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.workspace.headroomCompressionEngines')}
              <SourceBadge row={engines} />
            </span>
          }
          description={t('settings.workspace.headroomCompressionEnginesDesc')}
        >
          <ClearOverrideButton row={engines} onClear={() => clear('compressionEngines')} />
          <CompressionEnginesInput
            value={engines.value as string[]}
            onCommit={(next) => set('compressionEngines', next)}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.workspace.headroomVerbosity')}
              <SourceBadge row={verbosity} />
            </span>
          }
          description={t('settings.workspace.headroomVerbosityDesc')}
        >
          <ClearOverrideButton row={verbosity} onClear={() => clear('verbosity')} />
          <SettingsMenuSelect
            value={verbosity.value as HeadroomVerbosity}
            onValueChange={(v) => set('verbosity', v as HeadroomVerbosity)}
            options={HEADROOM_VERBOSITY_VALUES.map((v) => ({
              value: v,
              label: verbosityLabel(v),
            }))}
          />
        </SettingsRow>

        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('settings.workspace.headroomExposeStats')}
              <SourceBadge row={exposeStats} />
            </span>
          }
          description={t('settings.workspace.headroomExposeStatsDesc')}
        >
          <ClearOverrideButton row={exposeStats} onClear={() => clear('exposeStats')} />
          <Switch
            aria-label={t('settings.workspace.headroomExposeStats')}
            checked={exposeStats.value as boolean}
            onCheckedChange={(checked) => set('exposeStats', checked)}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}
