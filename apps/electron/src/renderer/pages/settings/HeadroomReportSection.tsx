/**
 * HeadroomReportSection (fork: PLAN-040, SUV-0027)
 *
 * What Headroom actually saved, per session and across the workspace. Every
 * figure on this screen came out of a `HeadroomAdapter.stats()` call; this
 * component performs no arithmetic at all, which is why the interesting logic
 * lives in `@/lib/headroom-report` and is tested there.
 *
 * The rendering contract it implements:
 *
 * - A scope with no measurement renders **one sentence saying why** — Headroom
 *   is off, Headroom is not available, or nothing has been compressed yet — and
 *   no table. Never an empty chart of zeros.
 * - A measured figure the adapter omitted renders as an em dash. A `0` on this
 *   screen always means a measured zero.
 *
 * Reachable from Workspace Settings (workspace aggregate) and from the session
 * info panel (that session's slice) — both render this component, which is why
 * `sessionId` is the only difference between the two entry points.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  HEADROOM_REPORT_METRIC_LABEL_KEYS,
  isHeadroomReportEmpty,
  type HeadroomReportScopeView,
} from '@/lib/headroom-report'
import { useHeadroomReport } from '@/hooks/useHeadroomReport'
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/settings'

/** What an unmeasured figure looks like. Deliberately not `0`. */
const UNKNOWN = '—'

export interface HeadroomReportSectionProps {
  workspaceId: string | null | undefined
  /** Ask for a session's own slice as well as the workspace aggregate. */
  sessionId?: string
  /** Render without the outer section chrome (the session panel is tight). */
  compact?: boolean
}

function ScopeRows({ scope }: { scope: HeadroomReportScopeView }) {
  const { t } = useTranslation()

  if (!scope.available) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" data-headroom-scope={scope.kind}>
        {t(scope.reasonKey ?? 'settings.workspace.headroomReportUnavailableAbsent')}
      </p>
    )
  }

  return (
    <div data-headroom-scope={scope.kind}>
      {scope.rows.map((row) => (
        <SettingsRow
          key={row.metric}
          label={t(HEADROOM_REPORT_METRIC_LABEL_KEYS[row.metric])}
          inCard
        >
          <span
            className="tabular-nums text-sm text-foreground/80"
            data-headroom-metric={row.metric}
            data-headroom-measured={row.value === null ? 'false' : 'true'}
          >
            {row.value ?? UNKNOWN}
          </span>
        </SettingsRow>
      ))}
    </div>
  )
}

export function HeadroomReportSection({
  workspaceId,
  sessionId,
  compact = false,
}: HeadroomReportSectionProps) {
  const { t } = useTranslation()
  const view = useHeadroomReport(workspaceId, sessionId)

  // One explanatory line beats two empty tables when there is nothing measured
  // anywhere — the "state that no stats are available" requirement.
  const body = isHeadroomReportEmpty(view) ? (
    <p className="px-3 py-2 text-xs text-muted-foreground" data-headroom-empty="true">
      {t(view.workspace.reasonKey ?? 'settings.workspace.headroomReportUnavailableAbsent')}
    </p>
  ) : (
    <>
      {view.session ? (
        <>
          <p className="px-3 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('settings.workspace.headroomReportScopeSession')}
          </p>
          <ScopeRows scope={view.session} />
        </>
      ) : null}
      <p className="px-3 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {t('settings.workspace.headroomReportScopeWorkspace')}
      </p>
      <ScopeRows scope={view.workspace} />
    </>
  )

  if (compact) {
    return (
      <div className="flex flex-col" data-headroom-report="compact">
        {body}
      </div>
    )
  }

  return (
    <SettingsSection
      title={t('settings.workspace.headroomReport')}
      description={t('settings.workspace.headroomReportDesc')}
    >
      <SettingsCard>{body}</SettingsCard>
    </SettingsSection>
  )
}
