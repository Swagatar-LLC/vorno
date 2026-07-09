/**
 * AdvancedSettingsPage — fork(PLAN-015)
 *
 * Advanced diagnostics for the desktop app. Currently hosts production
 * logging controls:
 * - Log level (error/warn/info/debug) — persisted, applies live (no restart)
 * - Log folder path display + "Open log folder" / "Reveal current log"
 *
 * Level changes go through craft-fork:logging:* IPC to the main-process
 * logger, which updates the live electron-log file transport.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { LoggingState, ProductionLogLevel } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsMenuSelectRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'advanced',
}

export default function AdvancedSettingsPage() {
  const { t } = useTranslation()

  const [logging, setLogging] = useState<LoggingState | null>(null)

  useEffect(() => {
    const loadState = async () => {
      if (!window.electronAPI?.getLoggingState) return
      try {
        setLogging(await window.electronAPI.getLoggingState())
      } catch (error) {
        console.error('Failed to load logging state:', error)
      }
    }
    loadState()
  }, [])

  const handleLevelChange = useCallback(async (value: string) => {
    const level = value as ProductionLogLevel
    // Optimistic update; the handler returns the authoritative state.
    setLogging(prev => (prev ? { ...prev, level } : prev))
    try {
      const next = await window.electronAPI.setLogLevel(level)
      setLogging(next)
    } catch (error) {
      console.error('Failed to set log level:', error)
    }
  }, [])

  const handleOpenLogFolder = useCallback(() => {
    window.electronAPI.openLogFolder().catch((error: unknown) => {
      console.error('Failed to open log folder:', error)
    })
  }, [])

  const handleRevealLogFile = useCallback(() => {
    window.electronAPI.revealLogFile().catch((error: unknown) => {
      console.error('Failed to reveal log file:', error)
    })
  }, [])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.advanced.title")} actions={<HeaderMenu route={routes.view.settings('advanced')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection title={t("settings.advanced.logging")} description={t("settings.advanced.loggingDesc")}>
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t("settings.advanced.logLevel")}
                    description={t("settings.advanced.logLevelDesc")}
                    value={logging?.level ?? 'info'}
                    onValueChange={handleLevelChange}
                    disabled={logging?.envOverride}
                    options={[
                      { value: 'error', label: t("settings.advanced.logLevelError") },
                      { value: 'warn', label: t("settings.advanced.logLevelWarn") },
                      { value: 'info', label: t("settings.advanced.logLevelInfo") },
                      { value: 'debug', label: t("settings.advanced.logLevelDebug") },
                    ]}
                  />
                  {logging?.envOverride && (
                    <div className="px-4 pb-3 text-xs text-muted-foreground">
                      {t("settings.advanced.logLevelEnvOverride")}
                    </div>
                  )}
                  {logging?.debugMode && (
                    <div className="px-4 pb-3 text-xs text-muted-foreground">
                      {t("settings.advanced.debugBuildNote")}
                    </div>
                  )}
                  <SettingsRow
                    label={t("settings.advanced.logFolder")}
                    description={logging?.logDirectory ?? ''}
                    action={
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={handleOpenLogFolder}>
                          {t("settings.advanced.openLogFolder")}
                        </Button>
                        <Button variant="outline" size="sm" onClick={handleRevealLogFile}>
                          {t("settings.advanced.revealLogFile")}
                        </Button>
                      </div>
                    }
                  />
                  <SettingsRow
                    label={t("settings.advanced.logRetention")}
                    description={t("settings.advanced.logRetentionDesc")}
                  />
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
