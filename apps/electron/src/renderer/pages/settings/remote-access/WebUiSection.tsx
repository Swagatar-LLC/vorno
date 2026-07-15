/**
 * WebUiSection — fork(PLAN-020)
 *
 * Settings section for the embedded desktop WebUI listener (separate supervised
 * HTTP server, own configurable port, generated login password).
 *
 * Mirrors the trigger-server sections in RemoteAccessSettingsPage:
 * - status row (running/starting/stopping/stopped/error) with a Start/Stop/Retry
 *   button, styled like the server status row
 * - enable toggle (desired state, persisted by start/stop)
 * - port number input (1024–65535) with a restart-to-apply note driven by the
 *   supervisor's `configStale` flag
 * - generated password display with copy + regenerate
 * - copyable loopback URL when running
 *
 * All user-visible copy flows through `settings.remoteAccess.webui.*` i18n keys.
 * The product name is sourced from the branding module, never hardcoded.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PRODUCT_NAME } from '@craft-agent/shared/branding'
import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsRow,
  SettingsNumberInput,
} from '@/components/settings'
import type { WebUiRemoteConfig, WebUiStatus } from '../../../../shared/types'

export default function WebUiSection() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<WebUiRemoteConfig | null>(null)
  const [status, setStatus] = useState<WebUiStatus>({ running: false, state: 'stopped' })
  const [copiedPassword, setCopiedPassword] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)

  // Load config + status on mount.
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const [cfg, sts] = await Promise.all([
          window.electronAPI.getWebUiConfig(),
          window.electronAPI.getWebUiStatus(),
        ])
        setConfig(cfg)
        setStatus(sts)
      } catch (error) {
        console.error('Failed to load WebUI config:', error)
      }
    }
    load()
  }, [])

  // Poll status every 5s so starting/error/configStale transitions surface.
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!window.electronAPI) return
      try {
        const sts = await window.electronAPI.getWebUiStatus()
        setStatus(sts)
      } catch {
        // Ignore polling errors.
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleToggleServer = useCallback(async () => {
    if (!window.electronAPI || !config) return
    try {
      if (status.running) {
        await window.electronAPI.stopWebUi()
      } else {
        // stopped or error → (re)start
        await window.electronAPI.startWebUi()
      }
      const sts = await window.electronAPI.getWebUiStatus()
      setStatus(sts)
    } catch (error) {
      console.error('Failed to toggle WebUI:', error)
    }
  }, [config, status.running])

  const handleToggleEnabled = useCallback(async (checked: boolean) => {
    if (!window.electronAPI || !config) return
    try {
      // start()/stop() persist desired state; use them so enable mirrors the
      // status button semantics.
      if (checked) {
        await window.electronAPI.startWebUi()
      } else {
        await window.electronAPI.stopWebUi()
      }
      const [cfg, sts] = await Promise.all([
        window.electronAPI.getWebUiConfig(),
        window.electronAPI.getWebUiStatus(),
      ])
      setConfig(cfg)
      setStatus(sts)
    } catch (error) {
      console.error('Failed to toggle WebUI enable:', error)
    }
  }, [config])

  const handleUpdatePort = useCallback(async (port: number) => {
    if (!window.electronAPI || !config) return
    const newConfig = { ...config, port }
    setConfig(newConfig)
    try {
      const updated = await window.electronAPI.updateWebUiConfig({ port })
      setConfig(updated)
      const sts = await window.electronAPI.getWebUiStatus()
      setStatus(sts)
    } catch (error) {
      console.error('Failed to update WebUI port:', error)
      setConfig(config) // Revert on error
    }
  }, [config])

  // fork(PLAN-022): host bind-address change. Commits on select change; a live
  // change surfaces the supervisor's configStale note (restart to rebind).
  const handleUpdateHost = useCallback(async (host: string) => {
    if (!window.electronAPI || !config) return
    const prev = config
    setConfig({ ...config, host })
    try {
      const updated = await window.electronAPI.updateWebUiConfig({ host })
      setConfig(updated)
      const sts = await window.electronAPI.getWebUiStatus()
      setStatus(sts)
    } catch (error) {
      console.error('Failed to update WebUI host:', error)
      setConfig(prev) // Revert on error
    }
  }, [config])

  const handleCopyPassword = useCallback(() => {
    if (config?.password) {
      navigator.clipboard.writeText(config.password)
      setCopiedPassword(true)
      setTimeout(() => setCopiedPassword(false), 2000)
    }
  }, [config?.password])

  const handleRegeneratePassword = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const password = await window.electronAPI.regenerateWebUiPassword()
      setConfig(prev => (prev ? { ...prev, password } : prev))
    } catch (error) {
      console.error('Failed to regenerate WebUI password:', error)
    }
  }, [])

  const handleCopyUrl = useCallback(() => {
    if (status.url) {
      navigator.clipboard.writeText(status.url)
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 2000)
    }
  }, [status.url])

  if (!config) return null

  const port = status.port ?? config.port
  const url = status.url ?? `http://127.0.0.1:${port}`

  // fork(PLAN-022): the two managed bind addresses. If the on-disk host is
  // neither (a hand-edited interface IP), surface it as a "custom" option so the
  // dropdown reflects disk truth and never silently clobbers it.
  const isCustomHost = config.host !== '127.0.0.1' && config.host !== '0.0.0.0'

  const statusDescription =
    status.state === 'running'
      ? t('settings.remoteAccess.webui.statusRunning', { host: '127.0.0.1', port })
      : status.state === 'starting'
        ? t('settings.remoteAccess.webui.statusStarting')
        : status.state === 'stopping'
          ? t('settings.remoteAccess.webui.statusStopping')
          : status.state === 'error'
            ? (status.lastError ?? t('settings.remoteAccess.webui.statusError'))
            : t('settings.remoteAccess.webui.statusStopped')

  return (
    <SettingsSection
      title={t('settings.remoteAccess.webui.title')}
      description={t('settings.remoteAccess.webui.description', { product: PRODUCT_NAME })}
    >
      {/* Status */}
      <SettingsCard>
        <SettingsRow label={t('settings.remoteAccess.webui.statusLabel')} description={statusDescription}>
          <button
            onClick={handleToggleServer}
            disabled={status.state === 'starting' || status.state === 'stopping'}
            className={`px-3 py-1 text-sm rounded-md font-medium disabled:opacity-50 ${
              status.running
                ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                : status.state === 'error'
                  ? 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
                  : 'bg-green-500/10 text-green-500 hover:bg-green-500/20'
            }`}
          >
            {status.running
              ? t('settings.remoteAccess.webui.stop')
              : status.state === 'error'
                ? t('settings.remoteAccess.webui.retry')
                : t('settings.remoteAccess.webui.start')}
          </button>
        </SettingsRow>
      </SettingsCard>

      {/* Enable */}
      <SettingsCard>
        <SettingsToggle
          label={t('settings.remoteAccess.webui.enableLabel')}
          description={t('settings.remoteAccess.webui.enableDescription')}
          checked={config.enabled}
          onCheckedChange={handleToggleEnabled}
        />
      </SettingsCard>

      {/* Host (bind address) — fork(PLAN-022) */}
      <SettingsCard>
        <SettingsRow
          label={t('settings.remoteAccess.webui.hostLabel')}
          description={t('settings.remoteAccess.webui.hostDescription')}
        >
          <select
            aria-label={t('settings.remoteAccess.webui.hostLabel')}
            value={config.host}
            onChange={e => handleUpdateHost(e.target.value)}
            className="bg-muted rounded-md px-2 py-1 text-sm"
          >
            <option value="127.0.0.1">{t('settings.remoteAccess.webui.hostLocalhost')}</option>
            <option value="0.0.0.0">{t('settings.remoteAccess.webui.hostAllInterfaces')}</option>
            {isCustomHost && (
              <option value={config.host}>
                {t('settings.remoteAccess.webui.hostCustom', { host: config.host })}
              </option>
            )}
          </select>
        </SettingsRow>
        {config.host === '0.0.0.0' && (
          <div className="px-4 py-2 text-xs text-amber-500 bg-amber-500/5 rounded-md mx-3 mb-3">
            {t('settings.remoteAccess.webui.hostWarning', { product: PRODUCT_NAME })}
          </div>
        )}
      </SettingsCard>

      {/* Port */}
      <SettingsCard>
        <SettingsRow
          label={t('settings.remoteAccess.webui.portLabel')}
          description={t('settings.remoteAccess.webui.portDescription')}
        >
          <SettingsNumberInput
            aria-label={t('settings.remoteAccess.webui.portLabel')}
            value={config.port}
            onCommit={handleUpdatePort}
            min={1024}
            max={65535}
          />
        </SettingsRow>
        {status.configStale && (
          <div className="px-4 py-2 text-xs text-amber-500 bg-amber-500/5 rounded-md mx-3 mb-3">
            {t('settings.remoteAccess.webui.restartToApply')}
          </div>
        )}
      </SettingsCard>

      {/* Password */}
      <SettingsCard divided={false}>
        <div className="px-4 py-3 space-y-2">
          <div className="text-sm font-medium">{t('settings.remoteAccess.webui.passwordLabel')}</div>
          <p className="text-xs text-muted-foreground">
            {t('settings.remoteAccess.webui.passwordHint')}
          </p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 text-xs font-mono bg-muted p-2 rounded overflow-x-auto">
              {config.password ?? '—'}
            </code>
            <button
              onClick={handleCopyPassword}
              disabled={!config.password}
              className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80 disabled:opacity-50"
            >
              {copiedPassword
                ? t('settings.remoteAccess.webui.copied')
                : t('settings.remoteAccess.webui.copy')}
            </button>
            <button
              onClick={handleRegeneratePassword}
              className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80"
            >
              {t('settings.remoteAccess.webui.regenerate')}
            </button>
          </div>
        </div>
      </SettingsCard>

      {/* URL (running only) */}
      {status.running && (
        <SettingsCard>
          <SettingsRow label={t('settings.remoteAccess.webui.urlLabel')} description={url}>
            <button
              onClick={handleCopyUrl}
              className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80"
            >
              {copiedUrl
                ? t('settings.remoteAccess.webui.copied')
                : t('settings.remoteAccess.webui.copy')}
            </button>
          </SettingsRow>
        </SettingsCard>
      )}
    </SettingsSection>
  )
}
