/**
 * ArtifactHomePage — Artifact Home (ADR-0015/0016, DIR-04, PLAN-025 C1).
 *
 * The C1 surface of the generalized workspace artifact plane. Three zones:
 *   LEFT   — filter rail: type / origin-kind / project / label / session-status
 *            pickers, pinned-only + show-archived toggles, and a client-side
 *            title search. Filters auto-apply (ADR-0015 §7: friction is a defect).
 *   MIDDLE — the artifact list from `vorno:artifacts:index`, sorted mtime desc,
 *            with skippedRoots surfaced as a dismissible note.
 *   RIGHT  — detail: `read` the selected artifact and render by type (markdown /
 *            json-canvas / json|file), pin/archive actions, a stale hint on
 *            content-hash drift, and a relations section with an add-relation
 *            picker (no free-text URIs).
 *
 * C1 has no push events: the page refetches on mount/focus and after mutations.
 * Selection + filters live in atoms/artifacts.ts, never the route.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { formatDistanceToNowStrict } from 'date-fns'
import { Library, RefreshCw, Pin, PinOff, Archive, ArchiveRestore, X, Plus, AlertTriangle } from 'lucide-react'
import { Markdown } from '@craft-agent/ui'
import type { ArtifactEntry, ArtifactRelation, ArtifactSkippedRoot } from '@craft-agent/core'
import { describeRelationEdges } from '@craft-agent/shared/artifacts/relations-view'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { shortTimeLocale } from '@/utils/session'
import { projectsAtom } from '@/atoms/projects'
import {
  artifactFiltersAtom,
  artifactsIndexAtom,
  artifactTypesAtom,
  selectedArtifactUriAtom,
  selectedArtifactReadAtom,
  EMPTY_ARTIFACT_FILTERS,
  type ArtifactFilters,
} from '@/atoms/artifacts'
import { JsonCanvasView } from '@/components/artifacts/JsonCanvasView'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const ORIGIN_KINDS = ['session-plan', 'session-data', 'corpus'] as const
const RELATION_KINDS = ['derived-from', 'references', 'renders', 'discussed-in'] as const

function relMtime(mtimeMs: number): string {
  return formatDistanceToNowStrict(new Date(mtimeMs), { locale: shortTimeLocale as never })
}

/** Origin display: sessionId (short) or projectId, falling back to the kind. */
function originLabel(entry: ArtifactEntry): string {
  if (entry.origin.sessionId) return entry.origin.sessionId.slice(0, 8)
  if (entry.origin.projectId) return entry.origin.projectId
  return entry.origin.kind
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

interface ArtifactHomePageProps {
  workspaceId: string
}

export default function ArtifactHomePage({ workspaceId }: ArtifactHomePageProps) {
  const { t } = useTranslation()

  const [filters, setFilters] = useAtom(artifactFiltersAtom)
  const [index, setIndex] = useAtom(artifactsIndexAtom)
  const [types, setTypes] = useAtom(artifactTypesAtom)
  const [selectedUri, setSelectedUri] = useAtom(selectedArtifactUriAtom)
  const [read, setRead] = useAtom(selectedArtifactReadAtom)

  const [loading, setLoading] = React.useState(false)
  const [skippedDismissed, setSkippedDismissed] = React.useState(false)

  // --- Types registry: load once per workspace -----------------------------
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await window.electronAPI.artifactsTypesList()
        if (!cancelled) setTypes(result.types)
      } catch (err) {
        console.error('[Artifacts] failed to list types', err)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // --- Index: (re)fetch when server-side filters change --------------------
  const loadIndex = React.useCallback(async () => {
    setLoading(true)
    setSkippedDismissed(false)
    try {
      const result = await window.electronAPI.artifactsIndex({
        filters: {
          type: filters.type ?? undefined,
          projectId: filters.projectId ?? undefined,
          label: filters.label?.trim() ? filters.label.trim() : undefined,
          sessionStatus: filters.sessionStatus ?? undefined,
          originKind: filters.originKind ?? undefined,
          includeArchived: filters.showArchived || undefined,
        },
      })
      setIndex(result)
    } catch (err) {
      console.error('[Artifacts] failed to index', err)
      toast.error(t('artifacts.indexFailed'))
      setIndex(null)
    } finally {
      setLoading(false)
    }
  }, [filters.type, filters.projectId, filters.label, filters.sessionStatus, filters.originKind, filters.showArchived, setIndex, t])

  React.useEffect(() => {
    void loadIndex()
  }, [loadIndex])

  // --- Read: when an artifact is selected -----------------------------------
  React.useEffect(() => {
    if (!selectedUri) {
      setRead(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const result = await window.electronAPI.artifactsRead({ uri: selectedUri })
        if (!cancelled) setRead(result)
      } catch (err) {
        console.error('[Artifacts] failed to read', err)
        if (!cancelled) setRead({ ok: false, reason: 'not-found' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedUri, setRead])

  // Client-side view: title search + pinned-only over the server-filtered set.
  const visible = React.useMemo(() => {
    let list = index?.artifacts ?? []
    if (filters.pinnedOnly) list = list.filter((a) => a.pinned)
    const q = filters.titleQuery.trim().toLowerCase()
    if (q) list = list.filter((a) => a.title.toLowerCase().includes(q))
    return [...list].sort((a, b) => b.mtimeMs - a.mtimeMs)
  }, [index, filters.pinnedOnly, filters.titleQuery])

  const selectedEntry = React.useMemo(
    () => (selectedUri ? index?.artifacts.find((a) => a.uri === selectedUri) ?? null : null),
    [index, selectedUri]
  )

  // Optimistic lifecycle mutation → re-index.
  const setLifecycle = React.useCallback(
    async (uri: string, patch: { pinned?: boolean; archived?: boolean }) => {
      try {
        const result = await window.electronAPI.artifactsLifecycleSet({ uri, patch })
        if (!result.ok) {
          toast.error(t('artifacts.lifecycleFailed'))
          return
        }
        await loadIndex()
      } catch (err) {
        console.error('[Artifacts] lifecycle set failed', err)
        toast.error(t('artifacts.lifecycleFailed'))
      }
    },
    [loadIndex, t]
  )

  const patchFilters = React.useCallback(
    (patch: Partial<ArtifactFilters>) => setFilters((prev) => ({ ...prev, ...patch })),
    [setFilters]
  )

  return (
    <div className="flex h-full w-full overflow-hidden">
      <FilterRail
        filters={filters}
        types={types}
        onPatch={patchFilters}
        onReset={() => setFilters(EMPTY_ARTIFACT_FILTERS)}
      />

      <ListPane
        artifacts={visible}
        loading={loading}
        selectedUri={selectedUri}
        onSelect={setSelectedUri}
        onRefresh={loadIndex}
        skippedRoots={index?.skippedRoots ?? []}
        skippedDismissed={skippedDismissed}
        onDismissSkipped={() => setSkippedDismissed(true)}
      />

      <DetailPane
        entry={selectedEntry}
        read={read}
        index={index?.artifacts ?? []}
        onSetLifecycle={setLifecycle}
        onSelectArtifact={setSelectedUri}
      />
    </div>
  )
}

// -----------------------------------------------------------------------------
// LEFT — filter rail
// -----------------------------------------------------------------------------

function FilterRail({
  filters,
  types,
  onPatch,
  onReset,
}: {
  filters: ArtifactFilters
  types: { id: string; displayName: string }[]
  onPatch: (patch: Partial<ArtifactFilters>) => void
  onReset: () => void
}) {
  const { t } = useTranslation()
  const projects = useAtomValue(projectsAtom)

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border/40 bg-background">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <Library className="h-3.5 w-3.5" />
          {t('artifacts.filters')}
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onReset}>
          {t('artifacts.clearFilters')}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 p-3">
          <Input
            value={filters.titleQuery}
            placeholder={t('artifacts.searchPlaceholder')}
            onChange={(e) => onPatch({ titleQuery: e.target.value })}
            className="h-8 text-xs"
          />

          <FilterSelect
            label={t('artifacts.filterType')}
            value={filters.type}
            onChange={(v) => onPatch({ type: v })}
            options={types.map((ty) => ({ value: ty.id, label: ty.displayName }))}
            anyLabel={t('artifacts.anyType')}
          />

          <FilterSelect
            label={t('artifacts.filterOrigin')}
            value={filters.originKind}
            onChange={(v) => onPatch({ originKind: v })}
            options={ORIGIN_KINDS.map((k) => ({ value: k, label: t(`artifacts.originKind.${k}`) }))}
            anyLabel={t('artifacts.anyOrigin')}
          />

          <FilterSelect
            label={t('artifacts.filterProject')}
            value={filters.projectId}
            onChange={(v) => onPatch({ projectId: v })}
            options={projects.map((p) => ({ value: p.config.id, label: p.config.name }))}
            anyLabel={t('artifacts.anyProject')}
          />

          {/* C1 deviation: label is a free-text filter — no shared label atom /
              picker seam exists at page scope (see hand-back note). */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">{t('artifacts.filterLabel')}</span>
            <Input
              value={filters.label ?? ''}
              placeholder={t('artifacts.labelPlaceholder')}
              onChange={(e) => onPatch({ label: e.target.value || null })}
              className="h-8 text-xs"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">{t('artifacts.filterSessionStatus')}</span>
            <Input
              value={filters.sessionStatus ?? ''}
              placeholder={t('artifacts.sessionStatusPlaceholder')}
              onChange={(e) => onPatch({ sessionStatus: e.target.value || null })}
              className="h-8 text-xs"
            />
          </div>

          <ToggleRow
            label={t('artifacts.pinnedOnly')}
            checked={filters.pinnedOnly}
            onChange={(v) => onPatch({ pinnedOnly: v })}
          />
          <ToggleRow
            label={t('artifacts.showArchived')}
            checked={filters.showArchived}
            onChange={(v) => onPatch({ showArchived: v })}
          />
        </div>
      </ScrollArea>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
}: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  options: { value: string; label: string }[]
  anyLabel: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 rounded-md border border-border/40 bg-background px-2 text-xs"
      >
        <option value="">{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border/60"
      />
      {label}
    </label>
  )
}

// -----------------------------------------------------------------------------
// MIDDLE — artifact list
// -----------------------------------------------------------------------------

function ListPane({
  artifacts,
  loading,
  selectedUri,
  onSelect,
  onRefresh,
  skippedRoots,
  skippedDismissed,
  onDismissSkipped,
}: {
  artifacts: ArtifactEntry[]
  loading: boolean
  selectedUri: string | null
  onSelect: (uri: string) => void
  onRefresh: () => void
  skippedRoots: ArtifactSkippedRoot[]
  skippedDismissed: boolean
  onDismissSkipped: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-border/40 bg-background">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('artifacts.artifacts')}
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRefresh} title={t('artifacts.refresh')}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {skippedRoots.length > 0 && !skippedDismissed && (
        <div className="mx-3 mt-2 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="flex-1" title={skippedRoots.map((s) => `${s.rootId}: ${s.reason}`).join(', ')}>
            {t('artifacts.skippedRoots', { count: skippedRoots.length })}
          </span>
          <button onClick={onDismissSkipped} className="shrink-0 opacity-70 hover:opacity-100" title={t('common.dismiss')}>
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="flex flex-col p-1.5">
          {artifacts.length === 0 && !loading && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('artifacts.noArtifacts')}</p>
          )}
          {artifacts.map((a) => (
            <button
              key={a.uri}
              onClick={() => onSelect(a.uri)}
              title={a.uri}
              className={cn(
                'flex flex-col items-start gap-1 rounded-md px-2 py-2 text-left hover:bg-foreground/5',
                a.uri === selectedUri && 'bg-foreground/8'
              )}
            >
              <div className="flex w-full items-center gap-1.5">
                {a.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
                <span className="truncate text-[13px] font-medium">{a.title}</span>
              </div>
              <div className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                  {a.type}
                </Badge>
                <span className="truncate">{originLabel(a)}</span>
                <span className="ml-auto shrink-0">{relMtime(a.mtimeMs)}</span>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

// -----------------------------------------------------------------------------
// RIGHT — detail
// -----------------------------------------------------------------------------

function DetailPane({
  entry,
  read,
  index,
  onSetLifecycle,
  onSelectArtifact,
}: {
  entry: ArtifactEntry | null
  read: import('../../shared/types').ArtifactsReadResult | null
  index: ArtifactEntry[]
  onSetLifecycle: (uri: string, patch: { pinned?: boolean; archived?: boolean }) => void
  onSelectArtifact: (uri: string) => void
}) {
  const { t } = useTranslation()

  // Stale detection: remember the first contentHash seen for this uri; if a later
  // re-read of the SAME uri yields a different hash, the artifact changed under us.
  // Hooks run unconditionally (Rules of Hooks — QA crash G2c-1: these previously
  // sat below the early return and threw on first selection); the memo guards on
  // entry internally.
  const entryUri = entry?.uri
  const firstHashRef = React.useRef<{ uri: string; hash: string } | null>(null)
  const stale = React.useMemo(() => {
    if (!entryUri || !read?.ok) return false
    const seen = firstHashRef.current
    if (!seen || seen.uri !== entryUri) {
      firstHashRef.current = { uri: entryUri, hash: read.version.contentHash }
      return false
    }
    return seen.hash !== read.version.contentHash
  }, [read, entryUri])

  if (!entry) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">{t('artifacts.selectArtifact')}</p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-border/30 px-6 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{entry.title}</h2>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {entry.type}
            </Badge>
            <span className="truncate">{entry.uri}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={entry.pinned ? t('artifacts.unpin') : t('artifacts.pin')}
            onClick={() => onSetLifecycle(entry.uri, { pinned: !entry.pinned })}
          >
            {entry.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={entry.archived ? t('artifacts.unarchive') : t('artifacts.archive')}
            onClick={() => onSetLifecycle(entry.uri, { archived: !entry.archived })}
          >
            {entry.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-[900px] px-6 py-6">
          {/* Stale hint: a re-read of this artifact returned a different content hash. */}
          {stale && (
            <div className="mb-3 rounded-md bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
              {t('artifacts.staleHint')}
            </div>
          )}

          <ArtifactBody entry={entry} read={read} />

          <RelationsSection uri={entry.uri} index={index} onSelectArtifact={onSelectArtifact} />
        </div>
      </ScrollArea>
    </div>
  )
}

function ArtifactBody({
  entry,
  read,
}: {
  entry: ArtifactEntry
  read: import('../../shared/types').ArtifactsReadResult | null
}) {
  const { t } = useTranslation()

  if (!read) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (!read.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {t('artifacts.readFailed')}
      </div>
    )
  }

  if (read.type === 'markdown') {
    return (
      <div className="text-sm">
        <Markdown mode="full">{read.content}</Markdown>
      </div>
    )
  }
  if (read.type === 'json-canvas') {
    return <JsonCanvasView content={read.content} />
  }
  // json / file / unknown → monospace pre block (file fallback, ADR-0016 §3).
  return (
    <pre className="overflow-x-auto rounded-lg border border-border/40 bg-foreground/[0.02] p-4 text-xs font-mono whitespace-pre-wrap break-words">
      {read.content}
    </pre>
  )
}

// -----------------------------------------------------------------------------
// Relations section
// -----------------------------------------------------------------------------

function RelationsSection({
  uri,
  index,
  onSelectArtifact,
}: {
  uri: string
  index: ArtifactEntry[]
  onSelectArtifact: (uri: string) => void
}) {
  const { t } = useTranslation()
  const [relations, setRelations] = React.useState<ArtifactRelation[]>([])
  const [adding, setAdding] = React.useState(false)
  const [addTo, setAddTo] = React.useState('')
  const [addKind, setAddKind] = React.useState<string>(RELATION_KINDS[0])

  const load = React.useCallback(async () => {
    try {
      const result = await window.electronAPI.artifactsRelationsList({ uri })
      setRelations(result.relations)
    } catch (err) {
      console.error('[Artifacts] failed to list relations', err)
      setRelations([])
    }
  }, [uri])

  React.useEffect(() => {
    void load()
  }, [load])

  // Edge resolution lives in the shared, unit-tested helper — an unresolvable
  // other-end renders a badge, never a crash or a dropped edge.
  const edges = React.useMemo(() => describeRelationEdges(relations, uri, index), [relations, uri, index])

  const handleAdd = async () => {
    if (!addTo) return
    try {
      const result = await window.electronAPI.artifactsRelationsMutate({
        command: { type: 'add', from: uri, to: addTo, kind: addKind },
      })
      if (!result.ok) {
        toast.error(t('artifacts.relationAddFailed'))
        return
      }
      setAdding(false)
      setAddTo('')
      await load()
    } catch (err) {
      console.error('[Artifacts] add relation failed', err)
      toast.error(t('artifacts.relationAddFailed'))
    }
  }

  const handleRemove = async (relationId: string) => {
    try {
      const result = await window.electronAPI.artifactsRelationsMutate({ command: { type: 'remove', relationId } })
      if (!result.ok) {
        toast.error(t('artifacts.relationRemoveFailed'))
        return
      }
      await load()
    } catch (err) {
      console.error('[Artifacts] remove relation failed', err)
      toast.error(t('artifacts.relationRemoveFailed'))
    }
  }

  // Candidates for the add-relation picker: every indexed artifact except self.
  const candidates = React.useMemo(() => index.filter((a) => a.uri !== uri), [index, uri])

  return (
    <div className="mt-8 border-t border-border/30 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('artifacts.relations')}
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setAdding((v) => !v)}>
          <Plus className="mr-1 h-3 w-3" />
          {t('artifacts.addRelation')}
        </Button>
      </div>

      {adding && (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border/40 p-2.5">
          <select
            value={addKind}
            onChange={(e) => setAddKind(e.target.value)}
            className="h-8 rounded-md border border-border/40 bg-background px-2 text-xs"
          >
            {RELATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`artifacts.relationKind.${k}`)}
              </option>
            ))}
          </select>
          <select
            value={addTo}
            onChange={(e) => setAddTo(e.target.value)}
            className="h-8 rounded-md border border-border/40 bg-background px-2 text-xs"
          >
            <option value="">{t('artifacts.chooseArtifact')}</option>
            {candidates.map((c) => (
              <option key={c.uri} value={c.uri}>
                {c.title}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-[11px]" disabled={!addTo} onClick={handleAdd}>
              {t('artifacts.add')}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {relations.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('artifacts.noRelations')}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {edges.map(({ relation: rel, otherUri, otherTitle: title, resolved }) => {
            return (
              <div key={rel.id} className="flex items-center gap-2 rounded-md border border-border/40 px-2 py-1.5 text-xs">
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {t(`artifacts.relationKind.${rel.kind}`, { defaultValue: rel.kind })}
                </Badge>
                {resolved ? (
                  <button
                    onClick={() => onSelectArtifact(otherUri)}
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    title={otherUri}
                  >
                    {title}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={otherUri}>
                    <span className="truncate">{title}</span>
                    <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
                      {t('artifacts.unresolvable')}
                    </Badge>
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-destructive"
                  title={t('common.delete')}
                  onClick={() => handleRemove(rel.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
