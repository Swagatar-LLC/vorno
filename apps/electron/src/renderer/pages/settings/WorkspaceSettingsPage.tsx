/**
 * WorkspaceSettingsPage
 *
 * Workspace-level settings for the active workspace.
 *
 * Settings:
 * - Identity (Name, Icon)
 * - Permissions (Default mode, Mode cycling)
 * - Advanced (Working directory, Local MCP servers)
 *
 * Note: AI settings (model, thinking, connection) have been moved to AiSettingsPage.
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import { RenameDialog } from '@/components/ui/rename-dialog'
import type { PermissionMode, WorkspaceSettings, LoadedSource } from '../../../shared/types'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { PERMISSION_MODE_CONFIG } from '@craft-agent/shared/agent/mode-types'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import type {
  RootBindingConfig,
  StorageCapabilities,
  RootHealth,
} from '@craft-agent/core'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsMenuSelectRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'workspace',
}

// ============================================
// Main Component
// ============================================

export default function WorkspaceSettingsPage() {
  const { t } = useTranslation()

  // Get active workspace from context
  const appShellContext = useAppShellContext()
  const activeWorkspaceId = appShellContext.activeWorkspaceId
  const onRefreshWorkspaces = appShellContext.onRefreshWorkspaces

  // Workspace settings state
  const [wsName, setWsName] = useState('')
  const [wsNameEditing, setWsNameEditing] = useState('')
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [wsIconUrl, setWsIconUrl] = useState<string | null>(null)
  const [isUploadingIcon, setIsUploadingIcon] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [localMcpEnabled, setLocalMcpEnabled] = useState(true)
  // fork(PLAN-024): Review Workbench feature flag
  const [workbenchEnabled, setWorkbenchEnabled] = useState(false)
  // fork(PLAN-025 C1): Artifact plane feature flag + registered roots
  const [artifactsEnabled, setArtifactsEnabled] = useState(false)
  const [artifactRoots, setArtifactRoots] = useState<Record<string, string | RootBindingConfig>>({})
  // fork(PLAN-029): per-root kind/capabilities/health from `roots:list` (no
  // absolute paths on the wire), keyed by rootId. Lazily (re)loaded.
  const [rootDescriptors, setRootDescriptors] = useState<Record<string, RootDescriptor>>({})
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(true)

  // Default sources state
  const [availableSources, setAvailableSources] = useState<LoadedSource[]>([])
  const [enabledSourceSlugs, setEnabledSourceSlugs] = useState<string[]>([])

  // Mode cycling state
  const [enabledModes, setEnabledModes] = useState<PermissionMode[]>(['safe', 'ask', 'allow-all'])
  const [modeCyclingError, setModeCyclingError] = useState<string | null>(null)

  // Load workspace settings when active workspace changes
  useEffect(() => {
    const loadWorkspaceSettings = async () => {
      if (!window.electronAPI || !activeWorkspaceId) {
        setIsLoadingWorkspace(false)
        return
      }

      setIsLoadingWorkspace(true)
      try {
        const settings = await window.electronAPI.getWorkspaceSettings(activeWorkspaceId)
        if (settings) {
          setWsName(settings.name || '')
          setWsNameEditing(settings.name || '')
          setPermissionMode(settings.permissionMode || 'ask')
          setWorkingDirectory(settings.workingDirectory || '')
          setLocalMcpEnabled(settings.localMcpEnabled ?? true)
          setWorkbenchEnabled(settings.workbenchEnabled ?? false)
          setArtifactsEnabled(settings.artifactsEnabled ?? false)
          setArtifactRoots(settings.artifactRoots ?? {})
          if (settings.artifactsEnabled) void refreshRootDescriptors()
          // Load cyclable permission modes from workspace settings
          if (settings.cyclablePermissionModes && settings.cyclablePermissionModes.length >= 2) {
            setEnabledModes(settings.cyclablePermissionModes)
          }

          // Load default source slugs
          const savedSlugs = settings.enabledSourceSlugs ?? []

          // Load available sources and auto-heal stale slugs
          const sources = await window.electronAPI.getSources(activeWorkspaceId)
          setAvailableSources(sources)
          const validSlugs = new Set(sources.map(s => s.config.slug))
          const healedSlugs = savedSlugs.filter(s => validSlugs.has(s))
          setEnabledSourceSlugs(healedSlugs)

          // Persist cleaned list if stale slugs were removed
          if (healedSlugs.length !== savedSlugs.length) {
            window.electronAPI.updateWorkspaceSetting(activeWorkspaceId, 'enabledSourceSlugs', healedSlugs)
          }
        }

        // Try to load workspace icon (check common extensions)
        const ICON_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif']
        let iconFound = false
        for (const ext of ICON_EXTENSIONS) {
          try {
            const iconData = await window.electronAPI.readWorkspaceImage(activeWorkspaceId, `./icon.${ext}`)
            // IPC returns null for missing files - continue to next extension
            if (!iconData) {
              continue
            }
            // For SVG, wrap in data URL
            if (ext === 'svg' && !iconData.startsWith('data:')) {
              setWsIconUrl(`data:image/svg+xml;base64,${btoa(iconData)}`)
            } else {
              setWsIconUrl(iconData)
            }
            iconFound = true
            break
          } catch {
            // Icon not found with this extension, try next
          }
        }
        if (!iconFound) {
          setWsIconUrl(null)
        }
      } catch (error) {
        console.error('Failed to load workspace settings:', error)
      } finally {
        setIsLoadingWorkspace(false)
      }
    }

    loadWorkspaceSettings()
  }, [activeWorkspaceId])

  // Subscribe to live source changes (additions/removals)
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onSourcesChanged((workspaceId: string, sources: LoadedSource[]) => {
      if (workspaceId !== activeWorkspaceId) return
      setAvailableSources(sources)
      // Auto-heal: remove slugs for sources that no longer exist
      const validSlugs = new Set(sources.map(s => s.config.slug))
      setEnabledSourceSlugs(prev => {
        const healed = prev.filter(s => validSlugs.has(s))
        if (healed.length !== prev.length && activeWorkspaceId) {
          window.electronAPI.updateWorkspaceSetting(activeWorkspaceId, 'enabledSourceSlugs', healed)
        }
        return healed
      })
    })
    return cleanup
  }, [activeWorkspaceId])

  // Save workspace setting
  const updateWorkspaceSetting = useCallback(
    async <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
      if (!window.electronAPI || !activeWorkspaceId) return false

      try {
        await window.electronAPI.updateWorkspaceSetting(activeWorkspaceId, key, value)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error(`Failed to save ${String(key)}:`, error)
        toast.error(t("settings.workspace.failedToSave", { setting: String(key) }), {
          description: message,
        })
        return false
      }
    },
    [activeWorkspaceId, t]
  )

  // Workspace icon upload handler
  const handleIconUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !activeWorkspaceId || !window.electronAPI) return

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif']
    if (!validTypes.includes(file.type)) {
      console.error('Invalid file type:', file.type)
      return
    }

    setIsUploadingIcon(true)
    try {
      // Read file as base64
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )

      // Determine extension from mime type
      const extMap: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/svg+xml': 'svg',
        'image/webp': 'webp',
        'image/gif': 'gif',
      }
      const ext = extMap[file.type] || 'png'

      // Upload to workspace
      await window.electronAPI.writeWorkspaceImage(activeWorkspaceId, `./icon.${ext}`, base64, file.type)

      // Reload the icon locally for settings display
      const iconData = await window.electronAPI.readWorkspaceImage(activeWorkspaceId, `./icon.${ext}`)
      if (iconData) {
        if (ext === 'svg' && !iconData.startsWith('data:')) {
          setWsIconUrl(`data:image/svg+xml;base64,${btoa(iconData)}`)
        } else {
          setWsIconUrl(iconData)
        }
      }

      // Refresh workspaces to update sidebar icon
      onRefreshWorkspaces?.()
    } catch (error) {
      console.error('Failed to upload icon:', error)
    } finally {
      setIsUploadingIcon(false)
      // Reset the input so the same file can be selected again
      e.target.value = ''
    }
  }, [activeWorkspaceId, onRefreshWorkspaces])

  // Workspace settings handlers
  const handlePermissionModeChange = useCallback(
    async (newMode: PermissionMode) => {
      setPermissionMode(newMode)
      await updateWorkspaceSetting('permissionMode', newMode)
    },
    [updateWorkspaceSetting]
  )

  const handleWorkingDirectorySelected = useCallback(async (selectedPath: string) => {
    const saved = await updateWorkspaceSetting('workingDirectory', selectedPath)
    if (saved) {
      setWorkingDirectory(selectedPath)
    }
  }, [updateWorkspaceSetting])

  const {
    pickDirectory: handleChangeWorkingDirectory,
    showServerBrowser: showWdBrowser,
    serverBrowserMode: wdBrowserMode,
    cancelServerBrowser: cancelWdBrowser,
    confirmServerBrowser: confirmWdBrowser,
  } = useDirectoryPicker(handleWorkingDirectorySelected)

  const handleClearWorkingDirectory = useCallback(async () => {
    if (!window.electronAPI) return

    const saved = await updateWorkspaceSetting('workingDirectory', undefined)
    if (saved) {
      setWorkingDirectory('')
    }
  }, [updateWorkspaceSetting])

  const handleLocalMcpEnabledChange = useCallback(
    async (enabled: boolean) => {
      setLocalMcpEnabled(enabled)
      await updateWorkspaceSetting('localMcpEnabled', enabled)
    },
    [updateWorkspaceSetting]
  )

  // fork(PLAN-024): Review Workbench feature flag. Notify the shell so the
  // sidebar entry appears/disappears without a workspace re-focus.
  const handleWorkbenchEnabledChange = useCallback(
    async (enabled: boolean) => {
      setWorkbenchEnabled(enabled)
      await updateWorkspaceSetting('workbenchEnabled', enabled)
      window.dispatchEvent(
        new CustomEvent('workbench:flag-changed', {
          detail: { workspaceId: activeWorkspaceId, enabled },
        })
      )
    },
    [updateWorkspaceSetting, activeWorkspaceId]
  )

  // fork(PLAN-025 C1): Artifact plane feature flag. Notify the shell so the
  // sidebar entry appears/disappears without a workspace re-focus.
  const handleArtifactsEnabledChange = useCallback(
    async (enabled: boolean) => {
      setArtifactsEnabled(enabled)
      await updateWorkspaceSetting('artifactsEnabled', enabled)
      window.dispatchEvent(
        new CustomEvent('artifacts:flag-changed', {
          detail: { workspaceId: activeWorkspaceId, enabled },
        })
      )
    },
    [updateWorkspaceSetting, activeWorkspaceId]
  )

  // fork(PLAN-029): (re)load per-root kind/capabilities/health descriptors from
  // `roots:list`. The server omits absolute paths (ADR-0016 §2) — only
  // id/kind/capabilities/status ride the wire. Keyed by rootId for the editor.
  const refreshRootDescriptors = useCallback(async () => {
    try {
      const result = await window.electronAPI.artifactsRootsList()
      const byId: Record<string, RootDescriptor> = {}
      for (const r of result.roots) {
        byId[r.id] = { kind: r.kind, capabilities: r.capabilities, status: r.status }
      }
      setRootDescriptors(byId)
    } catch {
      // Non-fatal: the editor falls back to a neutral display without health.
    }
  }, [])

  // Persist the artifact-roots map. Server validates (root-id syntax, reserved
  // 'workspace' id, absolute paths / binding kind); validation errors surface
  // via the shared updateWorkspaceSetting toast. On success, adopt the saved
  // map locally and refresh the per-root descriptors (kind/caps/health).
  const saveArtifactRoots = useCallback(
    async (next: Record<string, string | RootBindingConfig>) => {
      const saved = await updateWorkspaceSetting('artifactRoots', next)
      if (saved) {
        setArtifactRoots(next)
        void refreshRootDescriptors()
      }
    },
    [updateWorkspaceSetting, refreshRootDescriptors]
  )

  // Route directory-picker selections: a rootId re-picks that row's path; null
  // means "add a new root" — pick-directory-first, the id derives from the
  // folder name (ADR-0015 §7: pickers over free-text; QA G2c-2 flow fix).
  const pendingRootIdRef = React.useRef<string | null>(null)
  const handleRootDirSelected = useCallback(
    (path: string) => {
      const rootId = pendingRootIdRef.current
      pendingRootIdRef.current = null
      const id =
        rootId ??
        deriveRootId(path, new Set([...Object.keys(artifactRoots), 'workspace']))
      void saveArtifactRoots({ ...artifactRoots, [id]: path })
    },
    [artifactRoots, saveArtifactRoots]
  )

  const {
    pickDirectory: pickRootDirectory,
    showServerBrowser: showRootBrowser,
    serverBrowserMode: rootBrowserMode,
    cancelServerBrowser: cancelRootBrowser,
    confirmServerBrowser: confirmRootBrowser,
  } = useDirectoryPicker(handleRootDirSelected)

  const handleSourceToggle = useCallback(
    async (slug: string, checked: boolean) => {
      const newSlugs = checked
        ? [...enabledSourceSlugs, slug]
        : enabledSourceSlugs.filter(s => s !== slug)
      setEnabledSourceSlugs(newSlugs)
      await updateWorkspaceSetting('enabledSourceSlugs', newSlugs)
    },
    [enabledSourceSlugs, updateWorkspaceSetting]
  )

  const handleModeToggle = useCallback(
    async (mode: PermissionMode, checked: boolean) => {
      if (!window.electronAPI) return

      // Calculate what the new modes would be
      const newModes = checked
        ? [...enabledModes, mode]
        : enabledModes.filter((m) => m !== mode)

      // Validate: at least 2 modes required
      if (newModes.length < 2) {
        setModeCyclingError(t('settings.workspace.atLeast2Modes'))
        // Auto-dismiss after 2 seconds
        setTimeout(() => {
          setModeCyclingError(null)
        }, 2000)
        return
      }

      // Update state and persist
      setEnabledModes(newModes)
      setModeCyclingError(null)
      try {
        await updateWorkspaceSetting('cyclablePermissionModes', newModes)
      } catch (error) {
        console.error('Failed to save mode cycling settings:', error)
      }
    },
    [enabledModes, updateWorkspaceSetting, t]
  )

  // Show empty state if no workspace is active
  if (!activeWorkspaceId) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title={t("settings.workspace.workspaceSettings")} actions={<HeaderMenu route={routes.view.settings('workspace')} helpFeature="workspaces" />} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">{t("settings.workspace.noWorkspaceSelected")}</p>
        </div>
      </div>
    )
  }

  // Show loading state
  if (isLoadingWorkspace) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title={t("settings.workspace.workspaceSettings")} actions={<HeaderMenu route={routes.view.settings('workspace')} helpFeature="workspaces" />} />
        <div className="flex-1 flex items-center justify-center">
          <Spinner className="text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.workspace.workspaceSettings")} actions={<HeaderMenu route={routes.view.settings('workspace')} helpFeature="workspaces" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
          <div className="space-y-8">
            {/* Workspace Info */}
            <SettingsSection title={t("settings.workspace.workspaceInfo")}>
              <SettingsCard>
                <SettingsRow
                  label={t("common.name")}
                  description={wsName || t("settings.workspace.untitled")}
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        setWsNameEditing(wsName)
                        setRenameDialogOpen(true)
                      }}
                      className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
                    >
                      {t("common.edit")}
                    </button>
                  }
                />
                <SettingsRow
                  label={t("settings.workspace.icon")}
                  action={
                    <label className="cursor-pointer">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                        onChange={handleIconUpload}
                        className="sr-only"
                        disabled={isUploadingIcon}
                      />
                      <span className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors">
                        {isUploadingIcon ? t("common.uploading") : t("common.change")}
                      </span>
                    </label>
                  }
                >
                  <div
                    className={cn(
                      'w-6 h-6 rounded-full overflow-hidden bg-foreground/5 flex items-center justify-center',
                      'ring-1 ring-border/50'
                    )}
                  >
                    {isUploadingIcon ? (
                      <Spinner className="text-muted-foreground text-[8px]" />
                    ) : wsIconUrl ? (
                      <img src={wsIconUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">
                        {wsName?.charAt(0)?.toUpperCase() || 'W'}
                      </span>
                    )}
                  </div>
                </SettingsRow>
              </SettingsCard>

              <RenameDialog
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
                title={t("settings.workspace.renameWorkspace")}
                value={wsNameEditing}
                onValueChange={setWsNameEditing}
                onSubmit={() => {
                  const newName = wsNameEditing.trim()
                  if (newName && newName !== wsName) {
                    setWsName(newName)
                    updateWorkspaceSetting('name', newName)
                    onRefreshWorkspaces?.()
                  }
                  setRenameDialogOpen(false)
                }}
                placeholder={t("settings.workspace.enterWorkspaceName")}
              />
            </SettingsSection>

            {/* Permissions */}
            <SettingsSection title={t("settings.workspace.permissionsSection")}>
              <SettingsCard>
                <SettingsMenuSelectRow
                  label={t("settings.workspace.defaultMode")}
                  description={t("settings.workspace.defaultModeDesc")}
                  value={permissionMode}
                  onValueChange={(v) => handlePermissionModeChange(v as PermissionMode)}
                  options={[
                    { value: 'safe', label: t("mode.explore"), description: t("mode.exploreDesc") },
                    { value: 'ask', label: t("mode.ask"), description: t("mode.askDesc") },
                    { value: 'allow-all', label: t("mode.execute"), description: t("mode.executeDesc") },
                  ]}
                />
              </SettingsCard>
            </SettingsSection>

            {/* Mode Cycling */}
            <SettingsSection
              title={t("settings.workspace.modeCycling")}
              description={t("settings.workspace.modeCyclingDesc")}
            >
              <SettingsCard>
                {(['safe', 'ask', 'allow-all'] as const).map((m) => {
                  const modeTranslations: Record<string, { label: string; desc: string }> = {
                    'safe': { label: t("mode.explore"), desc: t("mode.exploreFullDesc") },
                    'ask': { label: t("mode.askToEdit"), desc: t("mode.askFullDesc") },
                    'allow-all': { label: t("mode.execute"), desc: t("mode.executeFullDesc") },
                  }
                  const isEnabled = enabledModes.includes(m)
                  return (
                    <SettingsToggle
                      key={m}
                      label={modeTranslations[m].label}
                      description={modeTranslations[m].desc}
                      checked={isEnabled}
                      onCheckedChange={(checked) => handleModeToggle(m, checked)}
                    />
                  )
                })}
              </SettingsCard>
              <AnimatePresence>
                {modeCyclingError && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                    className="text-xs text-destructive mt-1 overflow-hidden"
                  >
                    {modeCyclingError}
                  </motion.p>
                )}
              </AnimatePresence>
            </SettingsSection>

            {/* Default Sources */}
            <SettingsSection
              title={t("settings.workspace.defaultSources")}
              description={t("settings.workspace.defaultSourcesDesc")}
            >
              {availableSources.length > 0 ? (
                <SettingsCard>
                  {availableSources.map((source) => (
                    <SettingsToggle
                      key={source.config.slug}
                      label={
                        <span className="inline-flex items-center gap-2">
                          <SourceAvatar source={source} size="xs" />
                          {source.config.name}
                        </span>
                      }
                      description={source.config.tagline}
                      checked={enabledSourceSlugs.includes(source.config.slug)}
                      onCheckedChange={(checked) => handleSourceToggle(source.config.slug, checked)}
                    />
                  ))}
                </SettingsCard>
              ) : (
                <p className="text-sm text-muted-foreground">{t("settings.workspace.noSourcesConfigured")}</p>
              )}
            </SettingsSection>

            {/* Advanced */}
            <SettingsSection title={t("settings.workspace.advanced")}>
              <SettingsCard>
                <SettingsRow
                  label={t("settings.workspace.defaultWorkingDir")}
                  description={workingDirectory || t("settings.workspace.defaultWorkingDirDesc")}
                  action={
                    <div className="flex items-center gap-2">
                      {workingDirectory && (
                        <button
                          type="button"
                          onClick={handleClearWorkingDirectory}
                          className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors text-foreground/60 hover:text-foreground"
                        >
                          {t("common.clear")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleChangeWorkingDirectory}
                        className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
                      >
                        {t("common.change")}
                      </button>
                    </div>
                  }
                />
                <SettingsToggle
                  label={t("settings.workspace.localMcpServers")}
                  description={t("settings.workspace.localMcpServersDesc")}
                  checked={localMcpEnabled}
                  onCheckedChange={handleLocalMcpEnabledChange}
                />
                {/* fork(PLAN-024): Review Workbench feature flag */}
                <SettingsToggle
                  label={t("settings.workspace.workbench")}
                  description={t("settings.workspace.workbenchDesc")}
                  checked={workbenchEnabled}
                  onCheckedChange={handleWorkbenchEnabledChange}
                />
                {/* fork(PLAN-025 C1): Artifact plane feature flag */}
                <SettingsToggle
                  label={t("settings.workspace.artifacts")}
                  description={t("settings.workspace.artifactsDesc")}
                  checked={artifactsEnabled}
                  onCheckedChange={handleArtifactsEnabledChange}
                />
              </SettingsCard>

              {/* fork(PLAN-025 C1): advanced artifact-roots editor (visible when enabled) */}
              {artifactsEnabled && (
                <div className="mt-3">
                  <ArtifactRootsEditor
                    roots={artifactRoots}
                    descriptors={rootDescriptors}
                    onSave={saveArtifactRoots}
                    onBrowse={(rootId) => {
                      // null rootId = add-new (id derived from the picked folder)
                      pendingRootIdRef.current = rootId
                      pickRootDirectory()
                    }}
                  />
                </div>
              )}
            </SettingsSection>

          </div>
        </div>
        </ScrollArea>
      </div>
      <ServerDirectoryBrowser
        open={showWdBrowser}
        mode={wdBrowserMode}
        onSelect={confirmWdBrowser}
        onCancel={cancelWdBrowser}
        initialPath={workingDirectory || undefined}
      />
      {/* fork(PLAN-025 C1): directory picker for artifact-root rows */}
      <ServerDirectoryBrowser
        open={showRootBrowser}
        mode={rootBrowserMode}
        onSelect={confirmRootBrowser}
        onCancel={cancelRootBrowser}
      />
    </div>
  )
}

// ============================================
// Artifact roots editor (fork PLAN-025 C1)
// ============================================

/**
 * Derive a valid root id from a picked folder: basename → lowercase, non
 * [a-z0-9] runs → '-', trimmed, ≤64 chars, deduped against taken ids
 * (including the reserved 'workspace').
 */
function deriveRootId(path: string, taken: Set<string>): string {
  const base = path.split('/').filter(Boolean).pop() ?? 'root'
  let id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (!id) id = 'root'
  if (!taken.has(id)) return id
  for (let n = 2; ; n++) {
    const candidate = `${id.slice(0, 60)}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Per-root descriptor from `roots:list` (no absolute paths — ADR-0016 §2). */
interface RootDescriptor {
  kind: string
  capabilities?: StorageCapabilities
  status?: RootHealth
}

/** Display path for a root value: string shorthand, filesystem `path`, or —. */
function rootDisplayPath(value: string | RootBindingConfig): string {
  if (typeof value === 'string') return value
  if (value.kind === 'filesystem' && typeof (value as { path?: unknown }).path === 'string') {
    return (value as { path: string }).path
  }
  return '—'
}

/** A root value is filesystem when it is a bare string or `{kind:'filesystem'}`. */
function isFilesystemRoot(value: string | RootBindingConfig): boolean {
  return typeof value === 'string' || value.kind === 'filesystem'
}

/** Kind smart-chip (DIR-04 tenet 6). */
function KindBadge({ kind }: { kind: string }) {
  const { t } = useTranslation()
  const label =
    kind === 'filesystem'
      ? t('settings.workspace.rootKindFilesystem')
      : kind === 'object-store'
        ? t('settings.workspace.rootKindObjectStore')
        : kind
  return (
    <Badge variant="secondary" className="shrink-0 font-normal">
      {label}
    </Badge>
  )
}

/** Health dot fed by the `roots:list` `status` probe (green/amber/red). */
function HealthDot({ status }: { status?: RootHealth }) {
  const { t } = useTranslation()
  const map: Record<RootHealth, { cls: string; label: string }> = {
    ok: { cls: 'bg-emerald-500', label: t('settings.workspace.rootHealthOk') },
    missing: { cls: 'bg-red-500', label: t('settings.workspace.rootHealthMissing') },
    unreadable: { cls: 'bg-red-500', label: t('settings.workspace.rootHealthUnreadable') },
    truncated: { cls: 'bg-amber-500', label: t('settings.workspace.rootHealthTruncated') },
  }
  const shown = status ? map[status] : { cls: 'bg-foreground/20', label: t('settings.workspace.rootHealthUnknown') }
  return (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full', shown.cls)}
      title={shown.label}
      aria-label={shown.label}
    />
  )
}

/** Read-only capability chips from the provider's `StorageCapabilities`. */
function CapabilityChips({ capabilities }: { capabilities?: StorageCapabilities }) {
  const { t } = useTranslation()
  if (!capabilities) return null
  const chips: string[] = []
  if (capabilities.read) chips.push(t('settings.workspace.capRead'))
  if (capabilities.list) chips.push(t('settings.workspace.capList'))
  if (capabilities.write) chips.push(t('settings.workspace.capWrite'))
  if (capabilities.presign) chips.push(t('settings.workspace.capPresign'))
  // All C2 roots are read-only; make that explicit when no write path exists.
  if (!capabilities.write) chips.push(t('settings.workspace.capReadOnly'))
  return (
    <span className="hidden shrink-0 items-center gap-1 sm:flex" title={chips.join(' · ')}>
      {chips.map((c) => (
        <span key={c} className="rounded bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {c}
        </span>
      ))}
    </span>
  )
}

/**
 * Advanced artifact-roots editor (PLAN-025 C1; provider-aware PLAN-029).
 * Pick-directory-first (ADR-0015 §7; QA G2c-2): "Local folder…" opens the
 * directory picker immediately, the root id is derived from the folder name,
 * and id + path save together in one write. Each row shows a kind badge,
 * capability chips, and a health dot fed by `roots:list` (ADR-0019 §4) — the
 * absolute path is shown only for local filesystem rows (the server never puts
 * paths on the wire). "Add root" is a kind-first menu; only "Local folder…" is
 * live — "Object storage…" is the seam for the hosted track. Server validates
 * on save (ADR-0016 §2, ADR-0019).
 */
function ArtifactRootsEditor({
  roots,
  descriptors,
  onSave,
  onBrowse,
}: {
  roots: Record<string, string | RootBindingConfig>
  descriptors: Record<string, RootDescriptor>
  onSave: (next: Record<string, string | RootBindingConfig>) => void
  onBrowse: (rootId: string | null) => void
}) {
  const { t } = useTranslation()

  const entries = React.useMemo(() => Object.entries(roots), [roots])

  const removeRoot = (rootId: string) => {
    const next = { ...roots }
    delete next[rootId]
    onSave(next)
  }

  return (
    <div className="rounded-xl border border-border/50 bg-background p-4">
      <div className="mb-3">
        <p className="text-sm font-medium">{t("settings.workspace.artifactRoots")}</p>
        <p className="text-xs text-muted-foreground">{t("settings.workspace.artifactRootsDesc")}</p>
      </div>

      {entries.length === 0 ? (
        <p className="mb-3 text-xs text-muted-foreground">{t("settings.workspace.noArtifactRoots")}</p>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          {entries.map(([rootId, value]) => {
            const descriptor = descriptors[rootId]
            const kind = descriptor?.kind ?? (typeof value === 'string' ? 'filesystem' : value.kind)
            const filesystem = isFilesystemRoot(value)
            const displayPath = rootDisplayPath(value)
            return (
              <div key={rootId} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate font-mono text-xs" title={rootId}>
                  {rootId}
                </span>
                <KindBadge kind={kind} />
                <HealthDot status={descriptor?.status} />
                <button
                  type="button"
                  onClick={() => filesystem && onBrowse(rootId)}
                  disabled={!filesystem}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded-lg bg-foreground/[0.03] px-2 py-1.5 text-left text-xs shadow-minimal transition-colors',
                    filesystem ? 'hover:bg-foreground/[0.06]' : 'cursor-default opacity-70',
                  )}
                  title={filesystem ? displayPath || t("settings.workspace.chooseArtifactRootDir") : displayPath}
                >
                  {displayPath || t("settings.workspace.chooseArtifactRootDir")}
                </button>
                <CapabilityChips capabilities={descriptor?.capabilities} />
                <button
                  type="button"
                  onClick={() => removeRoot(rootId)}
                  className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-foreground/60 hover:text-destructive transition-colors"
                >
                  {t("common.remove")}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 items-center px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
          >
            {t("settings.workspace.addArtifactRoot")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onBrowse(null)}>
            {t("settings.workspace.addRootLocalFolder")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            {t("settings.workspace.addRootObjectStore")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
