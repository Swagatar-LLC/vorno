/**
 * CreateWebhookDialog — fork(PLAN-014)
 *
 * Minimal create flow for a new inbound webhook: name + slug. On submit it mints
 * a hook (default prompt action referencing the payload path) via
 * `upsertWebhook` and hands the one-time token URL to WebhookTokenDialog. Further
 * editing (matcher, labels, actions) happens through the normal automations
 * editor once the hook exists.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { WebhookTokenDialog } from './WebhookTokenDialog'

export interface CreateWebhookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
}

/** Derive a slug candidate from a display name: lowercase, hyphenated, [a-z0-9-]. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function CreateWebhookDialog({ open, onOpenChange, workspaceId }: CreateWebhookDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [slugDirty, setSlugDirty] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [tokenUrl, setTokenUrl] = React.useState<string | null>(null)

  // Reset form whenever the dialog opens.
  React.useEffect(() => {
    if (open) {
      setName('')
      setSlug('')
      setSlugDirty(false)
      setBusy(false)
    }
  }, [open])

  const effectiveSlug = slugDirty ? slug : slugify(name)
  const slugValid = /^[a-z0-9-]{1,64}$/.test(effectiveSlug)
  const canSubmit = name.trim().length > 0 && slugValid && !busy

  const handleCreate = React.useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      const result = await window.electronAPI.upsertWebhook({
        workspaceId,
        name: name.trim(),
        slug: effectiveSlug,
      })
      onOpenChange(false)
      if (result.tokenUrl) {
        setTokenUrl(result.tokenUrl)
      } else {
        toast.success(t('webhooks.created'))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('webhooks.createFailed'))
      setBusy(false)
    }
  }, [canSubmit, workspaceId, name, effectiveSlug, onOpenChange, t])

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('webhooks.createTitle')}</DialogTitle>
            <DialogDescription>{t('webhooks.createDescription')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-foreground/70">{t('webhooks.fieldName')}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('webhooks.fieldNamePlaceholder')}
                autoFocus
                className="h-8 rounded-[8px] border border-border bg-background px-2.5 text-sm outline-none focus:border-foreground/30"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-foreground/70">{t('webhooks.fieldSlug')}</span>
              <input
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugDirty(true)
                  setSlug(e.target.value)
                }}
                placeholder="my-hook"
                className="h-8 rounded-[8px] border border-border bg-background px-2.5 font-mono text-sm outline-none focus:border-foreground/30"
              />
              <span className="text-[11px] text-foreground/40">{t('webhooks.fieldSlugHint')}</span>
            </label>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-8 items-center rounded-[8px] bg-background px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.03]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={!canSubmit}
              className="inline-flex h-8 items-center rounded-[8px] bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {t('webhooks.createButton')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {tokenUrl && (
        <WebhookTokenDialog
          open={tokenUrl !== null}
          onOpenChange={(o) => {
            if (!o) setTokenUrl(null)
          }}
          tokenUrl={tokenUrl}
        />
      )}
    </>
  )
}
