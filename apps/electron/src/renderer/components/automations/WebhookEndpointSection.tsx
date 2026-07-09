/**
 * WebhookEndpointSection — fork(PLAN-014)
 *
 * The webhook-specific management surface shown inside AutomationInfoPage for a
 * WebhookReceived automation: the ingest URL (copyable, no token), token state
 * with generate / rotate / revoke, and a delivery log read from the DELIVERIES
 * RPC. Enable/disable and matcher/action editing reuse the automation's existing
 * controls elsewhere on the page.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Check, RefreshCw, ShieldOff, KeyRound } from 'lucide-react'
import { Info_Section, Info_Table, Info_Badge } from '@/components/info'
import type { WebhookView, WebhookDelivery } from '../../../shared/types'
import { WebhookTokenDialog } from './WebhookTokenDialog'
import { formatShortRelativeTime } from './utils'

export interface WebhookEndpointSectionProps {
  workspaceId: string
  /** Matcher id of the WebhookReceived automation. */
  matcherId: string
}

export function WebhookEndpointSection({ workspaceId, matcherId }: WebhookEndpointSectionProps) {
  const { t } = useTranslation()
  const [view, setView] = React.useState<WebhookView | null | undefined>(undefined)
  const [deliveries, setDeliveries] = React.useState<WebhookDelivery[]>([])
  const [copied, setCopied] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [tokenUrl, setTokenUrl] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [hooks, dels] = await Promise.all([
        window.electronAPI.listWebhooks(workspaceId),
        window.electronAPI.getWebhookDeliveries(workspaceId, matcherId),
      ])
      setView(hooks.find((h) => h.id === matcherId) ?? null)
      setDeliveries(dels)
    } catch {
      setView(null)
    }
  }, [workspaceId, matcherId])

  React.useEffect(() => {
    void load()
    const cleanup = window.electronAPI.onAutomationsChanged(() => void load())
    return cleanup
  }, [load])

  const handleCopyUrl = React.useCallback(() => {
    if (!view) return
    navigator.clipboard.writeText(view.ingestUrl).then(() => {
      setCopied(true)
      toast.success(t('webhooks.urlCopied'))
      setTimeout(() => setCopied(false), 1500)
    })
  }, [view, t])

  const handleRotate = React.useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.electronAPI.revokeWebhookToken(workspaceId, matcherId, 'rotate')
      if (result.tokenUrl) setTokenUrl(result.tokenUrl)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('webhooks.rotateFailed'))
    } finally {
      setBusy(false)
    }
  }, [workspaceId, matcherId, load, t])

  const handleRevoke = React.useCallback(async () => {
    setBusy(true)
    try {
      await window.electronAPI.revokeWebhookToken(workspaceId, matcherId, 'clear')
      toast.success(t('webhooks.revoked'))
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('webhooks.revokeFailed'))
    } finally {
      setBusy(false)
    }
  }, [workspaceId, matcherId, load, t])

  // Not a managed webhook (e.g. matcher removed) — render nothing.
  if (view === null) return null
  if (view === undefined) {
    return (
      <Info_Section title={t('webhooks.endpointSectionTitle')}>
        <p className="text-sm text-foreground/40">{t('common.loading')}</p>
      </Info_Section>
    )
  }

  return (
    <>
      <Info_Section
        title={t('webhooks.endpointSectionTitle')}
        description={t('webhooks.endpointSectionDescription')}
      >
        <Info_Table>
          <Info_Table.Row label={t('webhooks.labelIngestUrl')}>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-xs">
                {view.ingestUrl}
                <span className="text-foreground/30">/{'{token}'}</span>
              </code>
              <button
                type="button"
                onClick={handleCopyUrl}
                title={t('webhooks.copyUrl')}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-background shadow-minimal transition-colors hover:bg-foreground/[0.03]"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </Info_Table.Row>

          <Info_Table.Row label={t('webhooks.labelToken')}>
            {view.hasToken ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <code className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-xs">
                  {view.tokenPrefix ?? '••••'}
                </code>
                <Info_Badge color="success">{t('webhooks.tokenActive')}</Info_Badge>
              </div>
            ) : (
              <Info_Badge color="muted">{t('webhooks.tokenNone')}</Info_Badge>
            )}
          </Info_Table.Row>
        </Info_Table>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleRotate}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-background px-2.5 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.03] disabled:opacity-40"
          >
            {view.hasToken ? <RefreshCw className="h-3 w-3" /> : <KeyRound className="h-3 w-3" />}
            {view.hasToken ? t('webhooks.rotateToken') : t('webhooks.generateToken')}
          </button>
          {view.hasToken && (
            <button
              type="button"
              onClick={handleRevoke}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-background px-2.5 text-xs font-medium text-red-600 shadow-minimal transition-colors hover:bg-red-500/[0.06] disabled:opacity-40 dark:text-red-400"
            >
              <ShieldOff className="h-3 w-3" />
              {t('webhooks.revokeToken')}
            </button>
          )}
        </div>
      </Info_Section>

      {/* Delivery log */}
      <Info_Section
        title={t('webhooks.deliveriesSectionTitle')}
        description={deliveries.length > 0 ? t('webhooks.deliveriesCount', { count: deliveries.length }) : undefined}
      >
        {deliveries.length === 0 ? (
          <p className="text-sm text-foreground/40">{t('webhooks.noDeliveries')}</p>
        ) : (
          <div className="divide-y divide-border/30">
            {deliveries.map((d, i) => (
              <div key={i} className="flex items-center gap-2 py-2 text-xs">
                <span
                  className={
                    d.ok
                      ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500'
                      : 'h-1.5 w-1.5 shrink-0 rounded-full bg-red-500'
                  }
                />
                <span className="shrink-0 font-medium text-foreground/70">
                  {t(`webhooks.deliveryKind.${d.kind}`)}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/50">
                  {d.outcome ?? d.error ?? d.prompt ?? d.sessionId ?? ''}
                </span>
                <span className="shrink-0 text-foreground/40">{formatShortRelativeTime(d.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Info_Section>

      {tokenUrl && (
        <WebhookTokenDialog
          open={tokenUrl !== null}
          onOpenChange={(o) => {
            if (!o) setTokenUrl(null)
          }}
          tokenUrl={tokenUrl}
          rotated
        />
      )}
    </>
  )
}
