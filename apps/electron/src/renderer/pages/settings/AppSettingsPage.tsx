/**
 * AppSettingsPage
 *
 * Global app-level settings that apply across all workspaces.
 *
 * Settings:
 * - Notifications
 * - Network (proxy)
 * - About (version, updates)
 *
 * Note: AI settings (connections, model, thinking) have been moved to AiSettingsPage.
 * Note: Appearance settings (theme, font) have been moved to AppearanceSettingsPage.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { NetworkProxySettings } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
  SettingsSelect,
} from '@/components/settings'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'
import type { UpdaterConfig } from '../../../shared/types'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'app',
}

// ============================================
// Proxy form helpers
// ============================================

interface ProxyFormState {
  enabled: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
}

const EMPTY_PROXY_FORM: ProxyFormState = {
  enabled: false,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
}

function toProxyFormState(settings?: NetworkProxySettings): ProxyFormState {
  if (!settings) return EMPTY_PROXY_FORM
  return {
    enabled: settings.enabled,
    httpProxy: settings.httpProxy ?? '',
    httpsProxy: settings.httpsProxy ?? '',
    noProxy: settings.noProxy ?? '',
  }
}

function toNetworkProxySettings(form: ProxyFormState): NetworkProxySettings {
  return {
    enabled: form.enabled,
    httpProxy: form.httpProxy.trim() || undefined,
    httpsProxy: form.httpsProxy.trim() || undefined,
    noProxy: form.noProxy.trim() || undefined,
  }
}

function validateProxyUrl(url: string): string | undefined {
  if (!url.trim()) return undefined
  try {
    const parsed = new URL(url.trim())
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
      return 'proxyErrorProtocol'
    }
    return undefined
  } catch {
    return 'proxyErrorFormat'
  }
}

// ============================================
// Update feed form helpers (fork PLAN-018 / ADR-0009)
// ============================================

interface FeedFormState {
  provider: 'github' | 'generic'
  owner: string
  repo: string
  url: string
  channel: string
  autoCheck: boolean
}

const DEFAULT_FEED_FORM: FeedFormState = {
  provider: 'github',
  owner: 'Swagatar-LLC',
  repo: 'vorno-releases',
  url: '',
  channel: 'latest',
  autoCheck: true,
}

function toFeedFormState(config?: UpdaterConfig): FeedFormState {
  if (!config) return DEFAULT_FEED_FORM
  return {
    provider: config.provider,
    owner: config.owner ?? '',
    repo: config.repo ?? '',
    url: config.url ?? '',
    channel: config.channel || 'latest',
    autoCheck: config.autoCheck,
  }
}

function toUpdaterConfig(form: FeedFormState): UpdaterConfig {
  const channel = form.channel.trim() || 'latest'
  if (form.provider === 'github') {
    return { provider: 'github', owner: form.owner.trim(), repo: form.repo.trim(), channel, autoCheck: form.autoCheck }
  }
  return { provider: 'generic', url: form.url.trim(), channel, autoCheck: form.autoCheck }
}

/** Client-side validation mirroring validateUpdaterConfig; returns an i18n key or undefined. */
function validateFeedForm(form: FeedFormState): string | undefined {
  if (form.provider === 'github') {
    if (!form.owner.trim() || !form.repo.trim()) return 'feedErrorGithubRequired'
    return undefined
  }
  const url = form.url.trim()
  if (!url) return 'feedErrorUrlRequired'
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return 'feedErrorUrlHttps'
  } catch {
    return 'feedErrorUrlFormat'
  }
  return undefined
}

// ============================================
// Main Component
// ============================================

export default function AppSettingsPage() {
  const { t } = useTranslation()

  // Notifications state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // Power state
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)

  // Tools state
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)

  // Proxy state
  const [proxyForm, setProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [savedProxyForm, setSavedProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [proxyError, setProxyError] = useState<string | undefined>()
  const [isSavingProxy, setIsSavingProxy] = useState(false)

  // Auto-update state (Check Now / Update Ready only shown in Electron, not WebUI)
  const isElectron = window.electronAPI.getRuntimeEnvironment() === 'electron'
  const updateChecker = useUpdateChecker()
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false)

  const handleCheckForUpdates = useCallback(async () => {
    setIsCheckingForUpdates(true)
    try {
      await updateChecker.checkForUpdates()
    } finally {
      setIsCheckingForUpdates(false)
    }
  }, [updateChecker])

  // Update feed config state (fork PLAN-018 / ADR-0009) — Electron-only.
  const [feedForm, setFeedForm] = useState<FeedFormState>(DEFAULT_FEED_FORM)
  const [savedFeedForm, setSavedFeedForm] = useState<FeedFormState>(DEFAULT_FEED_FORM)
  const [feedError, setFeedError] = useState<string | undefined>()
  const [isSavingFeed, setIsSavingFeed] = useState(false)

  const isFeedDirty = useMemo(() => {
    return JSON.stringify(feedForm) !== JSON.stringify(savedFeedForm)
  }, [feedForm, savedFeedForm])

  const handleSaveFeed = useCallback(async () => {
    const err = validateFeedForm(feedForm)
    if (err) {
      setFeedError(err)
      return
    }
    setFeedError(undefined)
    setIsSavingFeed(true)
    try {
      const saved = await window.electronAPI.setUpdateFeedConfig(toUpdaterConfig(feedForm))
      const form = toFeedFormState(saved)
      setFeedForm(form)
      setSavedFeedForm(form)
    } catch (error) {
      setFeedError(error instanceof Error ? error.message : 'Failed to save')
    } finally {
      setIsSavingFeed(false)
    }
  }, [feedForm])

  const handleResetFeed = useCallback(() => {
    setFeedForm(savedFeedForm)
    setFeedError(undefined)
  }, [savedFeedForm])

  // Load settings on mount
  const loadSettings = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const [notificationsOn, keepAwakeOn, browserToolOn, proxySettings] = await Promise.all([
        window.electronAPI.getNotificationsEnabled(),
        window.electronAPI.getKeepAwakeWhileRunning(),
        window.electronAPI.getBrowserToolEnabled(),
        window.electronAPI.getNetworkProxySettings(),
      ])
      setNotificationsEnabled(notificationsOn)
      setKeepAwakeEnabled(keepAwakeOn)
      setBrowserToolEnabled(browserToolOn)
      const form = toProxyFormState(proxySettings)
      setProxyForm(form)
      setSavedProxyForm(form)

      // Update feed config is Electron-only (LOCAL_ONLY RPC).
      if (window.electronAPI.getRuntimeEnvironment() === 'electron') {
        try {
          const feedConfig = await window.electronAPI.getUpdateFeedConfig()
          const feed = toFeedFormState(feedConfig)
          setFeedForm(feed)
          setSavedFeedForm(feed)
        } catch (feedErr) {
          console.error('Failed to load update feed config:', feedErr)
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [])

  const handleNotificationsEnabledChange = useCallback(async (enabled: boolean) => {
    setNotificationsEnabled(enabled)
    await window.electronAPI.setNotificationsEnabled(enabled)
  }, [])

  const handleKeepAwakeEnabledChange = useCallback(async (enabled: boolean) => {
    setKeepAwakeEnabled(enabled)
    await window.electronAPI.setKeepAwakeWhileRunning(enabled)
  }, [])

  const handleBrowserToolEnabledChange = useCallback(async (enabled: boolean) => {
    setBrowserToolEnabled(enabled)
    await window.electronAPI.setBrowserToolEnabled(enabled)
  }, [])

  // Proxy handlers
  const isProxyDirty = useMemo(() => {
    return JSON.stringify(proxyForm) !== JSON.stringify(savedProxyForm)
  }, [proxyForm, savedProxyForm])

  const handleSaveProxy = useCallback(async () => {
    // Validate URLs
    const httpErr = validateProxyUrl(proxyForm.httpProxy)
    const httpsErr = validateProxyUrl(proxyForm.httpsProxy)
    if (httpErr || httpsErr) {
      setProxyError(httpErr || httpsErr)
      return
    }
    setProxyError(undefined)
    setIsSavingProxy(true)
    try {
      const settings = toNetworkProxySettings(proxyForm)
      await window.electronAPI.setNetworkProxySettings(settings)
      // Re-read persisted state to confirm
      const persisted = await window.electronAPI.getNetworkProxySettings()
      const form = toProxyFormState(persisted)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : 'Failed to save')
    } finally {
      setIsSavingProxy(false)
    }
  }, [proxyForm])

  const handleResetProxy = useCallback(() => {
    setProxyForm(savedProxyForm)
    setProxyError(undefined)
  }, [savedProxyForm])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.app.title")} actions={<HeaderMenu route={routes.view.settings('app')} helpFeature="app-settings" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Notifications */}
              <SettingsSection title={t("settings.notifications.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.notifications.desktopNotifications")}
                    description={t("settings.notifications.desktopNotificationsDesc")}
                    checked={notificationsEnabled}
                    onCheckedChange={handleNotificationsEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Power */}
              <SettingsSection title={t("settings.power.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.power.keepScreenAwake")}
                    description={t("settings.power.keepScreenAwakeDesc")}
                    checked={keepAwakeEnabled}
                    onCheckedChange={handleKeepAwakeEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Tools */}
              <SettingsSection title={t("settings.tools.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.tools.builtInBrowser")}
                    description={t("settings.tools.builtInBrowserDesc")}
                    checked={browserToolEnabled}
                    onCheckedChange={handleBrowserToolEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Network */}
              <SettingsSection title={t("settings.network.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.network.httpProxy")}
                    description={t("settings.network.httpProxyDesc")}
                    checked={proxyForm.enabled}
                    onCheckedChange={(enabled) => setProxyForm(prev => ({ ...prev, enabled }))}
                  />
                  {proxyForm.enabled && (
                    <>
                      <SettingsInput
                        label={t("settings.network.httpProxyLabel")}
                        value={proxyForm.httpProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.httpsProxyLabel")}
                        value={proxyForm.httpsProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpsProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.bypassRules")}
                        value={proxyForm.noProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, noProxy: value }))}
                        placeholder={t("settings.network.bypassPlaceholder")}
                        inCard
                      />
                    </>
                  )}
                  {(isProxyDirty || proxyError) && (
                    <SettingsCardFooter>
                      {proxyError && (
                        <span className="text-destructive text-sm mr-auto">{proxyError === 'proxyErrorProtocol' ? t("settings.network.proxyErrorProtocol") : proxyError === 'proxyErrorFormat' ? t("settings.network.proxyErrorFormat") : proxyError}</span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {t("common.reset")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleSaveProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {isSavingProxy ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.saving")}
                          </>
                        ) : (
                          t("common.save")
                        )}
                      </Button>
                    </SettingsCardFooter>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* About */}
              <SettingsSection title={t("settings.about.title")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.about.version")}>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {updateChecker.updateInfo?.currentVersion ?? t("common.loading")}
                      </span>
                      {isElectron && updateChecker.isDownloading && updateChecker.updateInfo?.latestVersion && (
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <Spinner className="w-3 h-3" />
                          <span>{t("settings.about.downloading", { version: updateChecker.updateInfo.latestVersion, percent: updateChecker.downloadProgress })}</span>
                        </div>
                      )}
                    </div>
                  </SettingsRow>
                  {isElectron && (
                    <SettingsRow label={t("settings.about.checkForUpdates")}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCheckForUpdates}
                        disabled={isCheckingForUpdates}
                      >
                        {isCheckingForUpdates ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.checking")}
                          </>
                        ) : (
                          t("settings.about.checkNow")
                        )}
                      </Button>
                    </SettingsRow>
                  )}
                  {isElectron && updateChecker.isReadyToInstall && updateChecker.updateInfo?.latestVersion && (
                    <SettingsRow label={t("settings.about.updateReady")}>
                      <Button
                        size="sm"
                        onClick={updateChecker.installUpdate}
                      >
                        {t("settings.about.restartToUpdate", { version: updateChecker.updateInfo.latestVersion })}
                      </Button>
                    </SettingsRow>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Updates — runtime-configurable feed (fork PLAN-018 / ADR-0009) */}
              {isElectron && (
                <SettingsSection title={t("settings.updates.title")} description={t("settings.updates.description")}>
                  <SettingsCard>
                    <SettingsToggle
                      label={t("settings.updates.autoCheck")}
                      description={t("settings.updates.autoCheckDesc")}
                      checked={feedForm.autoCheck}
                      onCheckedChange={(autoCheck) => setFeedForm(prev => ({ ...prev, autoCheck }))}
                    />
                    <SettingsSelect
                      label={t("settings.updates.provider")}
                      description={t("settings.updates.providerDesc")}
                      value={feedForm.provider}
                      onValueChange={(value) => setFeedForm(prev => ({ ...prev, provider: value as FeedFormState['provider'] }))}
                      options={[
                        { value: 'github', label: t("settings.updates.providerGithub") },
                        { value: 'generic', label: t("settings.updates.providerGeneric") },
                      ]}
                    />
                    {feedForm.provider === 'github' ? (
                      <>
                        <SettingsInput
                          label={t("settings.updates.owner")}
                          value={feedForm.owner}
                          onChange={(value) => setFeedForm(prev => ({ ...prev, owner: value }))}
                          placeholder={t("settings.updates.ownerPlaceholder")}
                          inCard
                        />
                        <SettingsInput
                          label={t("settings.updates.repo")}
                          value={feedForm.repo}
                          onChange={(value) => setFeedForm(prev => ({ ...prev, repo: value }))}
                          placeholder={t("settings.updates.repoPlaceholder")}
                          inCard
                        />
                      </>
                    ) : (
                      <SettingsInput
                        label={t("settings.updates.url")}
                        type="url"
                        value={feedForm.url}
                        onChange={(value) => setFeedForm(prev => ({ ...prev, url: value }))}
                        placeholder={t("settings.updates.urlPlaceholder")}
                        inCard
                      />
                    )}
                    <SettingsInput
                      label={t("settings.updates.channel")}
                      value={feedForm.channel}
                      onChange={(value) => setFeedForm(prev => ({ ...prev, channel: value }))}
                      placeholder={t("settings.updates.channelPlaceholder")}
                      inCard
                    />
                    {(isFeedDirty || feedError) && (
                      <SettingsCardFooter>
                        {feedError && (
                          <span className="text-destructive text-sm mr-auto">
                            {feedError === 'feedErrorGithubRequired' ? t("settings.updates.feedErrorGithubRequired")
                              : feedError === 'feedErrorUrlRequired' ? t("settings.updates.feedErrorUrlRequired")
                              : feedError === 'feedErrorUrlHttps' ? t("settings.updates.feedErrorUrlHttps")
                              : feedError === 'feedErrorUrlFormat' ? t("settings.updates.feedErrorUrlFormat")
                              : feedError}
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleResetFeed}
                          disabled={!isFeedDirty || isSavingFeed}
                        >
                          {t("common.reset")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleSaveFeed}
                          disabled={!isFeedDirty || isSavingFeed}
                        >
                          {isSavingFeed ? (
                            <>
                              <Spinner className="mr-1.5" />
                              {t("common.saving")}
                            </>
                          ) : (
                            t("common.save")
                          )}
                        </Button>
                      </SettingsCardFooter>
                    )}
                  </SettingsCard>
                </SettingsSection>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
