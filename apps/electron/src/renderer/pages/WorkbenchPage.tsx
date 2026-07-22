/**
 * WorkbenchPage — Review Workbench (ADR-0014, PLAN-024).
 *
 * The first dynamic-workspace surface: read dense governance/session artifacts
 * with native markdown/mermaid, comment inline (anchored, content-hash
 * versioned), and run an anchored question loop with agent sessions.
 *
 * Three panes:
 *   LEFT   — workbench instances (list + create + corpus roots) and the
 *            artifact index grouped by kind, with skippedRoots warnings.
 *   CENTER — the selected artifact, rendered via AnnotatableMarkdownDocument.
 *            Text selections become ReviewThreadV1 threads (comment default).
 *   RIGHT  — thread rail: filter by kind/status, stale badge on version drift,
 *            status actions, and "Ask agent" (routes a question into a session).
 *
 * v0.1 has no push events: panes refetch on selection/focus. Selection state
 * lives in atoms/workbench.ts, never the route.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { FolderOpen, Plus, RefreshCw, MessageSquare, AlertTriangle } from 'lucide-react'
import { AnnotatableMarkdownDocument } from '@craft-agent/ui'
import type {
  AnnotationV1,
  ArtifactRef,
  WorkbenchArtifactKind,
  ReviewThreadKind,
  ReviewThreadStatus,
} from '@craft-agent/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import {
  workbenchInstancesAtom,
  selectedWorkbenchIdAtom,
  selectedWorkbenchAtom,
  workbenchArtifactsAtom,
  selectedArtifactUriAtom,
  selectedArtifactReadAtom,
  workbenchThreadsAtom,
} from '@/atoms/workbench'
import type {
  ReviewThreadV1,
  WorkbenchInstanceV1,
  WorkbenchArtifactIndexResult,
} from '../../shared/types'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Synthetic messageId for annotations on a workbench artifact. */
function artifactMessageId(uri: string): string {
  return `workbench:${uri}`
}

/** Pull the quoted anchor text out of an annotation's text-quote selector. */
function anchorQuote(annotation: AnnotationV1): string {
  const sel = annotation.target?.selectors?.find((s) => s.type === 'text-quote')
  return sel && sel.type === 'text-quote' ? sel.exact : ''
}

/** ReviewThreadKind → AnnotationIntent (comment/question map through, decision → comment). */
function kindToIntent(kind: ReviewThreadKind): AnnotationV1['intent'] {
  return kind === 'question' ? 'question' : 'comment'
}

const THREAD_KINDS: ReviewThreadKind[] = ['comment', 'question', 'decision']

/** Next status offered by the primary status action for a given kind. */
function resolveTargetStatus(kind: ReviewThreadKind): ReviewThreadStatus {
  if (kind === 'question') return 'answered'
  if (kind === 'decision') return 'decided'
  return 'resolved'
}

function newId(): string {
  // crypto.randomUUID is available in the renderer (Electron/Chromium + WebUI).
  return crypto.randomUUID()
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

interface WorkbenchPageProps {
  workspaceId: string
}

export default function WorkbenchPage({ workspaceId }: WorkbenchPageProps) {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const isRemote = !!activeWorkspace?.remoteServer
  const workspaceRoot = activeWorkspace?.rootPath ?? '{workspaceRoot}'

  const [instances, setInstances] = useAtom(workbenchInstancesAtom)
  const [selectedId, setSelectedId] = useAtom(selectedWorkbenchIdAtom)
  const selected = useAtomValue(selectedWorkbenchAtom)
  const [artifacts, setArtifacts] = useAtom(workbenchArtifactsAtom)
  const [selectedUri, setSelectedUri] = useAtom(selectedArtifactUriAtom)
  const [artifactRead, setArtifactRead] = useAtom(selectedArtifactReadAtom)
  const [threads, setThreads] = useAtom(workbenchThreadsAtom)

  const [loadingArtifacts, setLoadingArtifacts] = React.useState(false)

  // --- Instances: load on mount / workspace change ------------------------
  const loadInstances = React.useCallback(async () => {
    try {
      const list = await window.electronAPI.workbenchListInstances()
      setInstances(list)
      setSelectedId((prev) => prev ?? list[0]?.id ?? null)
    } catch (err) {
      console.error('[Workbench] failed to list instances', err)
      toast.error(t('workbench.loadInstancesFailed'))
    }
  }, [setInstances, setSelectedId, t])

  React.useEffect(() => {
    void loadInstances()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // --- Artifacts: (re)index when the selected instance changes ------------
  const indexArtifacts = React.useCallback(
    async (workbenchId: string) => {
      setLoadingArtifacts(true)
      try {
        const result = await window.electronAPI.workbenchIndexArtifacts({ workbenchId })
        setArtifacts(result)
      } catch (err) {
        console.error('[Workbench] failed to index artifacts', err)
        toast.error(t('workbench.indexFailed'))
        setArtifacts(null)
      } finally {
        setLoadingArtifacts(false)
      }
    },
    [setArtifacts, t]
  )

  const loadThreads = React.useCallback(
    async (workbenchId: string) => {
      try {
        const list = await window.electronAPI.workbenchListThreads({ workbenchId })
        setThreads(list)
      } catch (err) {
        console.error('[Workbench] failed to list threads', err)
        setThreads([])
      }
    },
    [setThreads]
  )

  React.useEffect(() => {
    if (!selectedId) {
      setArtifacts(null)
      setThreads([])
      setSelectedUri(null)
      setArtifactRead(null)
      return
    }
    void indexArtifacts(selectedId)
    void loadThreads(selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // --- Artifact read: when a document is selected -------------------------
  React.useEffect(() => {
    if (!selectedId || !selectedUri) {
      setArtifactRead(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const result = await window.electronAPI.workbenchReadArtifact({
          workbenchId: selectedId,
          uri: selectedUri,
        })
        if (!cancelled) setArtifactRead(result)
      } catch (err) {
        console.error('[Workbench] failed to read artifact', err)
        if (!cancelled) setArtifactRead(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedUri])

  // --- Thread mutation plumbing -------------------------------------------
  const mutateThread = React.useCallback(
    async (command: Parameters<typeof window.electronAPI.workbenchMutateThread>[0]['command']) => {
      if (!selectedId) return null
      try {
        const result = await window.electronAPI.workbenchMutateThread({ workbenchId: selectedId, command })
        if (!result.ok) {
          toast.error(t('workbench.threadMutationFailed', { reason: result.reason }))
          return null
        }
        await loadThreads(selectedId)
        return result.thread ?? null
      } catch (err) {
        console.error('[Workbench] thread mutation failed', err)
        toast.error(t('workbench.threadMutationFailed', { reason: 'error' }))
        return null
      }
    },
    [selectedId, loadThreads, t]
  )

  // Threads for the currently-open artifact (for the annotatable document).
  const artifactThreads = React.useMemo(
    () => threads.filter((th) => th.artifactUri === selectedUri),
    [threads, selectedUri]
  )
  const artifactAnnotations = React.useMemo(
    () => artifactThreads.map((th) => th.annotation),
    [artifactThreads]
  )

  // --- Annotation → thread bridges ----------------------------------------
  const handleAddAnnotation = React.useCallback(
    (_messageId: string, annotation: AnnotationV1) => {
      if (!selectedId || !selectedUri) return
      // A3 (PLAN-025 review): don't drop the annotation silently when the read
      // hasn't landed yet — a thread needs the artifact version to anchor to.
      if (!artifactRead) {
        toast.error(t('workbench.annotationNotReady'))
        return
      }
      const now = Date.now()
      const thread: ReviewThreadV1 = {
        schemaVersion: 1,
        id: newId(),
        workbenchId: selectedId,
        artifactUri: selectedUri,
        artifactVersion: artifactRead.version,
        annotation,
        kind: 'comment',
        status: 'open',
        sessionLinks: [],
        createdAt: now,
        updatedAt: now,
      }
      void mutateThread({ type: 'add', thread })
    },
    [selectedId, selectedUri, artifactRead, mutateThread, t]
  )

  const handleUpdateAnnotation = React.useCallback(
    (_messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => {
      const thread = artifactThreads.find((th) => th.annotation.id === annotationId)
      if (!thread) return
      const nextAnnotation = { ...thread.annotation, ...patch }
      void mutateThread({ type: 'update', threadId: thread.id, patch: { annotation: nextAnnotation } })
    },
    [artifactThreads, mutateThread]
  )

  const handleRemoveAnnotation = React.useCallback(
    (_messageId: string, annotationId: string) => {
      const thread = artifactThreads.find((th) => th.annotation.id === annotationId)
      if (!thread) return
      void mutateThread({ type: 'remove', threadId: thread.id })
    },
    [artifactThreads, mutateThread]
  )

  return (
    <div className="flex h-full w-full overflow-hidden">
      <LeftPane
        instances={instances}
        selectedId={selectedId}
        onSelectInstance={(id) => {
          setSelectedId(id)
          setSelectedUri(null)
        }}
        onCreated={async (created) => {
          await loadInstances()
          setSelectedId(created)
          setSelectedUri(null)
        }}
        onRefresh={loadInstances}
        selected={selected}
        onSaveCorpusRoots={async (roots) => {
          if (!selectedId) return
          const updated = await window.electronAPI.workbenchUpdateInstance({
            workbenchId: selectedId,
            patch: { corpusRoots: roots },
          })
          if (updated) {
            setInstances((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
            void indexArtifacts(selectedId)
          }
        }}
        artifacts={artifacts}
        loadingArtifacts={loadingArtifacts}
        selectedUri={selectedUri}
        onSelectArtifact={setSelectedUri}
        onReindex={() => selectedId && indexArtifacts(selectedId)}
        isRemote={isRemote}
      />

      <CenterPane
        artifactUri={selectedUri}
        content={artifactRead?.content ?? null}
        annotations={artifactAnnotations}
        onAddAnnotation={handleAddAnnotation}
        onUpdateAnnotation={handleUpdateAnnotation}
        onRemoveAnnotation={handleRemoveAnnotation}
      />

      <RightPane
        allThreads={threads}
        artifactUri={selectedUri}
        currentVersionHash={artifactRead?.version.contentHash ?? null}
        artifacts={artifacts}
        boundSessionId={selected?.boundSessionId}
        workspaceRoot={workspaceRoot}
        onSelectArtifact={(uri) => {
          setSelectedUri(uri)
        }}
        onMutate={mutateThread}
      />
    </div>
  )
}

// -----------------------------------------------------------------------------
// LEFT PANE — instances + corpus roots + artifact index
// -----------------------------------------------------------------------------

interface LeftPaneProps {
  instances: WorkbenchInstanceV1[]
  selectedId: string | null
  onSelectInstance: (id: string) => void
  onCreated: (id: string) => void
  onRefresh: () => void
  selected: WorkbenchInstanceV1 | null
  onSaveCorpusRoots: (roots: string[]) => Promise<void>
  artifacts: WorkbenchArtifactIndexResult | null
  loadingArtifacts: boolean
  selectedUri: string | null
  onSelectArtifact: (uri: string) => void
  onReindex: () => void
  isRemote: boolean
}

function LeftPane({
  instances,
  selectedId,
  onSelectInstance,
  onCreated,
  onRefresh,
  selected,
  onSaveCorpusRoots,
  artifacts,
  loadingArtifacts,
  selectedUri,
  onSelectArtifact,
  onReindex,
  isRemote,
}: LeftPaneProps) {
  const { t } = useTranslation()
  const [creating, setCreating] = React.useState(false)
  const [newTitle, setNewTitle] = React.useState('')
  const [rootsDraft, setRootsDraft] = React.useState('')

  // Keep the corpus-roots textarea in sync with the selected instance.
  // A4 (PLAN-025 review): resync ONLY when the selected instance id changes.
  // Depending on `selected.corpusRoots` (a fresh array reference on every
  // loadInstances() rebuild) clobbered an in-progress edit mid-typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    setRootsDraft((selected?.corpusRoots ?? []).join('\n'))
  }, [selected?.id])

  const handleCreate = async () => {
    const title = newTitle.trim()
    if (!title) return
    try {
      const created = await window.electronAPI.workbenchCreateInstance({ title })
      setNewTitle('')
      setCreating(false)
      onCreated(created.id)
    } catch (err) {
      console.error('[Workbench] create failed', err)
      toast.error(t('workbench.createFailed'))
    }
  }

  const handleAddPath = async () => {
    try {
      const path = await window.electronAPI.openFolderDialog()
      if (path) {
        setRootsDraft((prev) => (prev.trim() ? `${prev.trimEnd()}\n${path}` : path))
      }
    } catch (err) {
      console.error('[Workbench] folder dialog failed', err)
    }
  }

  const parseRoots = (raw: string): string[] =>
    raw
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)

  const rootsChanged =
    JSON.stringify(parseRoots(rootsDraft)) !== JSON.stringify(selected?.corpusRoots ?? [])

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-border/40 bg-background">
      {/* Instances header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('workbench.instances')}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRefresh} title={t('workbench.refresh')}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setCreating((v) => !v)}
            title={t('workbench.newInstance')}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {creating && (
        <div className="flex flex-col gap-2 p-3 border-b border-border/30">
          <Input
            value={newTitle}
            autoFocus
            placeholder={t('workbench.titlePlaceholder')}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate} disabled={!newTitle.trim()}>
              {t('workbench.create')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1">
        {/* Instance list */}
        <div className="flex flex-col p-1.5">
          {instances.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">{t('workbench.noInstances')}</p>
          )}
          {instances.map((inst) => (
            <button
              key={inst.id}
              onClick={() => onSelectInstance(inst.id)}
              className={cn(
                'flex flex-col items-start rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/5',
                inst.id === selectedId && 'bg-foreground/8'
              )}
            >
              <span className="truncate font-medium">{inst.title}</span>
              <span className="text-[11px] text-muted-foreground">
                {t('workbench.corpusRootsCount', { count: inst.corpusRoots.length })}
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <>
            {/* Corpus roots editor */}
            <div className="flex flex-col gap-2 border-t border-border/30 p-3">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('workbench.corpusRoots')}
              </span>
              <Textarea
                value={rootsDraft}
                onChange={(e) => setRootsDraft(e.target.value)}
                placeholder={t('workbench.corpusRootsPlaceholder')}
                rows={3}
                className="text-xs font-mono"
              />
              <div className="flex gap-2">
                {!isRemote && (
                  <Button size="sm" variant="outline" onClick={handleAddPath}>
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    {t('workbench.addFolder')}
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!rootsChanged}
                  onClick={() => onSaveCorpusRoots(parseRoots(rootsDraft))}
                >
                  {t('workbench.saveRoots')}
                </Button>
              </div>
            </div>

            {/* Artifact index */}
            <div className="flex items-center justify-between border-t border-border/30 px-3 py-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('workbench.artifacts')}
              </span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onReindex} title={t('workbench.reindex')}>
                <RefreshCw className={cn('h-3.5 w-3.5', loadingArtifacts && 'animate-spin')} />
              </Button>
            </div>

            {artifacts && artifacts.skippedRoots.length > 0 && (
              <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t('workbench.skippedRoots', { count: artifacts.skippedRoots.length })}</span>
              </div>
            )}

            <ArtifactGroups
              artifacts={artifacts?.artifacts ?? []}
              selectedUri={selectedUri}
              onSelect={onSelectArtifact}
              empty={!loadingArtifacts && (artifacts?.artifacts.length ?? 0) === 0}
            />
          </>
        )}
      </ScrollArea>
    </div>
  )
}

const KIND_GROUPS: { kind: WorkbenchArtifactKind; labelKey: string }[] = [
  { kind: 'corpus', labelKey: 'workbench.groupCorpus' },
  { kind: 'session-plan', labelKey: 'workbench.groupSessionPlans' },
  { kind: 'session-data', labelKey: 'workbench.groupSessionData' },
]

function ArtifactGroups({
  artifacts,
  selectedUri,
  onSelect,
  empty,
}: {
  artifacts: ArtifactRef[]
  selectedUri: string | null
  onSelect: (uri: string) => void
  empty: boolean
}) {
  const { t } = useTranslation()
  if (empty) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t('workbench.noArtifacts')}</p>
  }
  return (
    <div className="pb-4">
      {KIND_GROUPS.map(({ kind, labelKey }) => {
        const group = artifacts.filter((a) => a.kind === kind)
        if (group.length === 0) return null
        return (
          <div key={kind} className="mt-1">
            <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">{t(labelKey)}</div>
            {group.map((a) => (
              <button
                key={a.uri}
                onClick={() => onSelect(a.uri)}
                title={a.uri}
                className={cn(
                  'block w-full truncate px-3 py-1 text-left text-[13px] hover:bg-foreground/5',
                  a.uri === selectedUri && 'bg-foreground/8 font-medium'
                )}
              >
                {a.title}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// -----------------------------------------------------------------------------
// CENTER PANE — annotatable document
// -----------------------------------------------------------------------------

function CenterPane({
  artifactUri,
  content,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: {
  artifactUri: string | null
  content: string | null
  annotations: AnnotationV1[]
  onAddAnnotation: (messageId: string, annotation: AnnotationV1) => void
  onUpdateAnnotation: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  onRemoveAnnotation: (messageId: string, annotationId: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-[860px] px-8 py-10">
          {!artifactUri || content === null ? (
            <div className="flex h-full items-center justify-center py-24 text-sm text-muted-foreground">
              {t('workbench.selectArtifact')}
            </div>
          ) : (
            <div className="text-sm">
              <AnnotatableMarkdownDocument
                content={content}
                messageId={artifactMessageId(artifactUri)}
                annotations={annotations}
                onAddAnnotation={onAddAnnotation}
                onUpdateAnnotation={onUpdateAnnotation}
                onRemoveAnnotation={onRemoveAnnotation}
                islandZIndex={420}
              />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// -----------------------------------------------------------------------------
// RIGHT PANE — thread rail
// -----------------------------------------------------------------------------

type ScopeTab = 'artifact' | 'all'

function RightPane({
  allThreads,
  artifactUri,
  currentVersionHash,
  artifacts,
  boundSessionId,
  workspaceRoot,
  onSelectArtifact,
  onMutate,
}: {
  allThreads: ReviewThreadV1[]
  artifactUri: string | null
  currentVersionHash: string | null
  artifacts: WorkbenchArtifactIndexResult | null
  boundSessionId?: string
  workspaceRoot: string
  onSelectArtifact: (uri: string) => void
  onMutate: (
    command: Parameters<typeof window.electronAPI.workbenchMutateThread>[0]['command']
  ) => Promise<ReviewThreadV1 | null>
}) {
  const { t } = useTranslation()
  const [scope, setScope] = React.useState<ScopeTab>('artifact')
  const [kindFilter, setKindFilter] = React.useState<ReviewThreadKind | 'all'>('all')
  const [statusFilter, setStatusFilter] = React.useState<ReviewThreadStatus | 'all'>('all')

  const scoped = React.useMemo(() => {
    let list = scope === 'artifact' && artifactUri ? allThreads.filter((t2) => t2.artifactUri === artifactUri) : allThreads
    if (kindFilter !== 'all') list = list.filter((t2) => t2.kind === kindFilter)
    if (statusFilter !== 'all') list = list.filter((t2) => t2.status === statusFilter)
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [allThreads, scope, artifactUri, kindFilter, statusFilter])

  const artifactTitle = React.useCallback(
    (uri: string) => artifacts?.artifacts.find((a) => a.uri === uri)?.title ?? uri.split('/').pop() ?? uri,
    [artifacts]
  )

  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-border/40 bg-background">
      <div className="border-b border-border/30 px-3 py-2.5">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('workbench.threads')}
        </span>
      </div>

      <div className="flex flex-col gap-2 border-b border-border/30 p-3">
        <Tabs value={scope} onValueChange={(v) => setScope(v as ScopeTab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="artifact">{t('workbench.scopeArtifact')}</TabsTrigger>
            <TabsTrigger value="all">{t('workbench.scopeAll')}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap gap-1">
          <FilterChip active={kindFilter === 'all'} onClick={() => setKindFilter('all')} label={t('workbench.filterAll')} />
          {THREAD_KINDS.map((k) => (
            <FilterChip
              key={k}
              active={kindFilter === k}
              onClick={() => setKindFilter(k)}
              label={t(`workbench.kind.${k}`)}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <FilterChip
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
            label={t('workbench.filterAllStatus')}
          />
          {(['open', 'answered', 'resolved', 'decided'] as ReviewThreadStatus[]).map((s) => (
            <FilterChip
              key={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              label={t(`workbench.status.${s}`)}
            />
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-3">
          {scoped.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">{t('workbench.noThreads')}</p>
          )}
          {scoped.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              stale={
                scope === 'artifact' &&
                currentVersionHash !== null &&
                thread.artifactVersion.contentHash !== currentVersionHash
              }
              showArtifact={scope === 'all'}
              artifactLabel={artifactTitle(thread.artifactUri)}
              onOpenArtifact={() => onSelectArtifact(thread.artifactUri)}
              boundSessionId={boundSessionId}
              workspaceRoot={workspaceRoot}
              onMutate={onMutate}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[11px]',
        active ? 'border-foreground/20 bg-foreground/10 font-medium' : 'border-border/40 text-muted-foreground hover:bg-foreground/5'
      )}
    >
      {label}
    </button>
  )
}

function ThreadCard({
  thread,
  stale,
  showArtifact,
  artifactLabel,
  onOpenArtifact,
  boundSessionId,
  workspaceRoot,
  onMutate,
}: {
  thread: ReviewThreadV1
  stale: boolean
  showArtifact: boolean
  artifactLabel: string
  onOpenArtifact: () => void
  boundSessionId?: string
  workspaceRoot: string
  onMutate: (
    command: Parameters<typeof window.electronAPI.workbenchMutateThread>[0]['command']
  ) => Promise<ReviewThreadV1 | null>
}) {
  const { t } = useTranslation()
  const { onSendMessage } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessions = React.useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])

  const [asking, setAsking] = React.useState(false)
  const [question, setQuestion] = React.useState('')
  const [targetSessionId, setTargetSessionId] = React.useState<string>(boundSessionId ?? '')

  const quote = anchorQuote(thread.annotation)
  const note = thread.annotation.body.find((b) => b.type === 'note')
  const noteText = note && note.type === 'note' ? note.text : ''

  const setKind = (kind: ReviewThreadKind) => {
    void onMutate({
      type: 'update',
      threadId: thread.id,
      patch: { kind, annotation: { ...thread.annotation, intent: kindToIntent(kind) } },
    })
  }

  const setStatus = (status: ReviewThreadStatus) => {
    void onMutate({ type: 'update', threadId: thread.id, patch: { status } })
  }

  const remove = () => {
    void onMutate({ type: 'remove', threadId: thread.id })
  }

  const handleAsk = async () => {
    const q = question.trim()
    if (!q || !targetSessionId) return
    const message = [
      `[Workbench review question — thread ${thread.id}]`,
      `Artifact: ${thread.artifactUri}`,
      quote ? `> ${quote}` : undefined,
      '',
      q,
      '',
      `Thread file: ${workspaceRoot}/reviews/${thread.workbenchId}/threads/${thread.id}.json — update status/notes there.`,
    ]
      .filter((line) => line !== undefined)
      .join('\n')

    onSendMessage(targetSessionId, message)

    await onMutate({
      type: 'update',
      threadId: thread.id,
      patch: {
        status: 'open',
        sessionLinks: [
          ...thread.sessionLinks,
          { sessionId: targetSessionId, role: 'question', createdAt: Date.now() },
        ],
      },
    })
    setAsking(false)
    setQuestion('')
    toast.success(t('workbench.questionSent'))
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/40 bg-foreground/2 p-2.5">
      <div className="flex items-center gap-1.5">
        <Badge variant="secondary" className="text-[10px]">
          {t(`workbench.kind.${thread.kind}`)}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {t(`workbench.status.${thread.status}`)}
        </Badge>
        {stale && (
          <Badge variant="destructive" className="text-[10px]" title={t('workbench.staleDesc')}>
            {t('workbench.stale')}
          </Badge>
        )}
      </div>

      {showArtifact && (
        <button onClick={onOpenArtifact} className="truncate text-left text-[11px] text-muted-foreground hover:underline">
          {artifactLabel}
        </button>
      )}

      {quote && (
        <blockquote className="border-l-2 border-border/60 pl-2 text-[12px] italic text-muted-foreground line-clamp-3">
          {quote}
        </blockquote>
      )}
      {noteText && <p className="text-[13px] line-clamp-4">{noteText}</p>}

      {/* Kind switch */}
      <div className="flex flex-wrap gap-1">
        {THREAD_KINDS.map((k) => (
          <FilterChip
            key={k}
            active={thread.kind === k}
            onClick={() => setKind(k)}
            label={t(`workbench.kind.${k}`)}
          />
        ))}
      </div>

      {/* Status actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        {thread.status === 'open' ? (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setStatus(resolveTargetStatus(thread.kind))}>
            {t(`workbench.status.${resolveTargetStatus(thread.kind)}`)}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setStatus('open')}>
            {t('workbench.reopen')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => setAsking((v) => !v)}
        >
          <MessageSquare className="mr-1 h-3 w-3" />
          {t('workbench.askAgent')}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-destructive" onClick={remove}>
          {t('common.delete')}
        </Button>
      </div>

      {asking && (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-border/30 pt-2">
          <select
            value={targetSessionId}
            onChange={(e) => setTargetSessionId(e.target.value)}
            className="rounded-md border border-border/40 bg-background px-2 py-1 text-xs"
          >
            <option value="">{t('workbench.chooseSession')}</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.preview || s.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <Textarea
            value={question}
            autoFocus
            rows={3}
            placeholder={t('workbench.questionPlaceholder')}
            onChange={(e) => setQuestion(e.target.value)}
            className="text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-[11px]" disabled={!question.trim() || !targetSessionId} onClick={handleAsk}>
              {t('workbench.send')}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {thread.sessionLinks.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {t('workbench.linkedSessions', { count: thread.sessionLinks.length })}
        </p>
      )}
    </div>
  )
}
