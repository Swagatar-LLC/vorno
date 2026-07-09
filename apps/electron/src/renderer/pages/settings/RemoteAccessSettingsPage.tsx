/**
 * RemoteAccessSettingsPage
 *
 * Server configuration for the HTTP trigger server.
 *
 * Settings:
 * - Server enable/disable and status
 * - Host and port configuration
 * - API key management (create, revoke, list)
 * - Rate limits
 */

import { useState, useEffect, useCallback } from 'react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type {
  RemoteAccessConfig,
  RemoteAccessApiKeyInfo,
  RemoteAccessApiKeyPermissions,
  RemoteAccessStatus,
} from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsRow,
  SettingsInput,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'remote-access',
}

export default function RemoteAccessSettingsPage() {
  const [config, setConfig] = useState<RemoteAccessConfig | null>(null)
  const [status, setStatus] = useState<RemoteAccessStatus>({ running: false, state: 'stopped', activeSessions: 0 })
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState(false)

  // Load config and status on mount
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const [cfg, sts] = await Promise.all([
          window.electronAPI.getRemoteAccessConfig(),
          window.electronAPI.getRemoteAccessStatus(),
        ])
        setConfig(cfg)
        setStatus(sts)
      } catch (error) {
        console.error('Failed to load remote access config:', error)
      }
    }
    load()
  }, [])

  // Poll status every 5 seconds while mounted so starting/error/configStale
  // transitions surface even when the server isn't running.
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!window.electronAPI) return
      try {
        const sts = await window.electronAPI.getRemoteAccessStatus()
        setStatus(sts)
      } catch {
        // Ignore polling errors
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleToggleServer = useCallback(async () => {
    if (!window.electronAPI || !config) return
    try {
      if (status.running) {
        await window.electronAPI.stopRemoteAccessServer()
      } else {
        // stopped or error → (re)start
        await window.electronAPI.startRemoteAccessServer()
      }
      // Re-read the authoritative status from the supervisor rather than guessing.
      const sts = await window.electronAPI.getRemoteAccessStatus()
      setStatus(sts)
    } catch (error) {
      console.error('Failed to toggle server:', error)
    }
  }, [config, status.running, status.state])

  const handleUpdateConfig = useCallback(async (updates: Partial<RemoteAccessConfig>) => {
    if (!window.electronAPI || !config) return
    const newConfig = { ...config, ...updates }
    setConfig(newConfig)
    try {
      await window.electronAPI.updateRemoteAccessConfig(updates)
    } catch (error) {
      console.error('Failed to update config:', error)
      setConfig(config) // Revert on error
    }
  }, [config])

  const handleCreateKey = useCallback(async () => {
    if (!window.electronAPI || !newKeyName.trim()) return
    try {
      const permissions: RemoteAccessApiKeyPermissions = {
        workspaceIds: [],
        permissionPolicy: 'allow-safe',
        maxConcurrentSessions: 3,
      }
      const result = await window.electronAPI.createRemoteAccessApiKey(newKeyName.trim(), permissions)
      setCreatedKey(result.fullKey)
      setNewKeyName('')
      // Reload config to show new key
      const cfg = await window.electronAPI.getRemoteAccessConfig()
      setConfig(cfg)
    } catch (error) {
      console.error('Failed to create API key:', error)
    }
  }, [newKeyName])

  const handleRevokeKey = useCallback(async (keyId: string) => {
    if (!window.electronAPI) return
    try {
      await window.electronAPI.revokeRemoteAccessApiKey(keyId)
      const cfg = await window.electronAPI.getRemoteAccessConfig()
      setConfig(cfg)
    } catch (error) {
      console.error('Failed to revoke API key:', error)
    }
  }, [])

  const handleCopyKey = useCallback(() => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey)
      setCopiedKey(true)
      setTimeout(() => setCopiedKey(false), 2000)
    }
  }, [createdKey])

  if (!config) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title="Remote Access" />
        <div className="flex-1 flex items-center justify-center">
          <span className="text-muted-foreground">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title="Remote Access" />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">

              {/* Server Status */}
              <SettingsSection title="Server">
                <SettingsCard>
                  <SettingsRow
                    label="Status"
                    description={
                      status.state === 'running' ? `Running on ${status.host}:${status.port}`
                        : status.state === 'starting' ? 'Starting…'
                        : status.state === 'stopping' ? 'Stopping…'
                        : status.state === 'error' ? (status.lastError ?? 'Server error')
                        : 'Server is stopped'
                    }
                  >
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
                      {status.running ? 'Stop' : status.state === 'error' ? 'Retry' : 'Start'}
                    </button>
                  </SettingsRow>
                  {status.configStale && (
                    <div className="px-4 py-2 text-xs text-amber-500 bg-amber-500/5 rounded-md mx-3 mb-3">
                      Host, port, or rate-limit changes apply after restarting the server.
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Connection Settings */}
              <SettingsSection title="Connection">
                <SettingsCard>
                  <SettingsRow label="Host" description="Bind address for the server">
                    <select
                      value={config.host}
                      onChange={e => handleUpdateConfig({ host: e.target.value })}
                      className="bg-muted rounded-md px-2 py-1 text-sm"
                    >
                      <option value="127.0.0.1">127.0.0.1 (localhost only)</option>
                      <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
                    </select>
                  </SettingsRow>
                  <SettingsRow label="Port" description="HTTP port for the server">
                    <input
                      type="number"
                      value={config.port}
                      onChange={e => handleUpdateConfig({ port: parseInt(e.target.value) || 3847 })}
                      className="bg-muted rounded-md px-2 py-1 text-sm w-20 text-right"
                      min={1024}
                      max={65535}
                    />
                  </SettingsRow>
                  {config.host === '0.0.0.0' && (
                    <div className="px-4 py-2 text-xs text-amber-500 bg-amber-500/5 rounded-md mx-3 mb-3">
                      Warning: Binding to 0.0.0.0 exposes the agent to your local network.
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* API Keys */}
              <SettingsSection title="API Keys" description="Keys for authenticating remote clients">
                <SettingsCard divided={false}>
                  {/* Create new key */}
                  <div className="px-4 py-3 flex gap-2">
                    <input
                      type="text"
                      placeholder="Key name (e.g., CI Pipeline)"
                      value={newKeyName}
                      onChange={e => setNewKeyName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
                      className="flex-1 bg-muted rounded-md px-3 py-1.5 text-sm"
                    />
                    <button
                      onClick={handleCreateKey}
                      disabled={!newKeyName.trim()}
                      className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      Create Key
                    </button>
                  </div>

                  {/* Show newly created key */}
                  {createdKey && (
                    <div className="mx-4 mb-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-md">
                      <p className="text-xs text-amber-500 mb-2">
                        Copy this key now — it won't be shown again.
                      </p>
                      <div className="flex gap-2 items-center">
                        <code className="flex-1 text-xs font-mono bg-muted p-2 rounded overflow-x-auto">
                          {createdKey}
                        </code>
                        <button
                          onClick={handleCopyKey}
                          className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80"
                        >
                          {copiedKey ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Key list */}
                  {config.apiKeys.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No API keys created yet
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {config.apiKeys.map(key => (
                        <ApiKeyRow key={key.id} apiKey={key} onRevoke={handleRevokeKey} />
                      ))}
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Rate Limits */}
              <SettingsSection title="Rate Limits">
                <SettingsCard>
                  <SettingsRow label="Requests per minute" description="Max API requests per key per minute">
                    <input
                      type="number"
                      value={config.rateLimits.requestsPerMinute}
                      onChange={e => handleUpdateConfig({
                        rateLimits: { ...config.rateLimits, requestsPerMinute: parseInt(e.target.value) || 30 }
                      })}
                      className="bg-muted rounded-md px-2 py-1 text-sm w-20 text-right"
                      min={1}
                      max={1000}
                    />
                  </SettingsRow>
                  <SettingsRow label="Max concurrent sessions" description="Maximum simultaneous sessions across all keys">
                    <input
                      type="number"
                      value={config.rateLimits.concurrentSessions}
                      onChange={e => handleUpdateConfig({
                        rateLimits: { ...config.rateLimits, concurrentSessions: parseInt(e.target.value) || 5 }
                      })}
                      className="bg-muted rounded-md px-2 py-1 text-sm w-20 text-right"
                      min={1}
                      max={50}
                    />
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Active Sessions */}
              {status.running && status.activeSessions > 0 && (
                <SettingsSection title="Active Remote Sessions">
                  <SettingsCard>
                    <SettingsRow
                      label="Sessions"
                      description={`${status.activeSessions} active remote session(s)`}
                    >
                      <span className="text-sm text-muted-foreground">
                        {status.activeSessions}
                      </span>
                    </SettingsRow>
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

/**
 * Individual API key row component.
 */
function ApiKeyRow({ apiKey, onRevoke }: { apiKey: RemoteAccessApiKeyInfo; onRevoke: (id: string) => void }) {
  const createdDate = new Date(apiKey.createdAt).toLocaleDateString()
  const lastUsed = apiKey.lastUsedAt
    ? formatRelativeTime(apiKey.lastUsedAt)
    : 'never'

  return (
    <div className="px-4 py-3 flex items-center justify-between">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{apiKey.name}</span>
          <code className="text-xs text-muted-foreground">{apiKey.keyPrefix}</code>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Created {createdDate} · Last used: {lastUsed}
          {apiKey.permissions.workspaceIds.length > 0 && (
            <> · Workspaces: {apiKey.permissions.workspaceIds.join(', ')}</>
          )}
          {' '}· Max: {apiKey.permissions.permissionPolicy}
        </div>
      </div>
      <button
        onClick={() => onRevoke(apiKey.id)}
        className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-500 hover:bg-red-500/20"
      >
        Revoke
      </button>
    </div>
  )
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
