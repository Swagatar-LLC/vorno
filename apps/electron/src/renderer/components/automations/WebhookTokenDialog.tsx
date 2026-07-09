/**
 * WebhookTokenDialog — fork(PLAN-014)
 *
 * Shows a freshly minted webhook ingest URL (WITH the capability token) exactly
 * once. The token is never retrievable again — the dialog nudges the user to copy
 * it now. Reused by both create and rotate flows.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Check, TriangleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

export interface WebhookTokenDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Full ingest URL including the plaintext token. */
  tokenUrl: string
  /** True when this is a rotation (old URL now dead) rather than first creation. */
  rotated?: boolean
}

export function WebhookTokenDialog({ open, onOpenChange, tokenUrl, rotated }: WebhookTokenDialogProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(tokenUrl).then(() => {
      setCopied(true)
      toast.success(t('webhooks.urlCopied'))
      setTimeout(() => setCopied(false), 1500)
    })
  }, [tokenUrl, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('webhooks.tokenDialogTitle')}</DialogTitle>
          <DialogDescription>
            {rotated ? t('webhooks.tokenDialogRotatedDescription') : t('webhooks.tokenDialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-[8px] bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('webhooks.tokenDialogWarning')}</span>
        </div>

        <div className="flex items-center gap-2">
          <code className="flex-1 select-all break-all rounded-[8px] bg-foreground/5 px-2.5 py-2 font-mono text-xs">
            {tokenUrl}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            title={t('webhooks.copyUrl')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-background shadow-minimal transition-colors hover:bg-foreground/[0.03]"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-8 items-center rounded-[8px] bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
          >
            {t('webhooks.doneCopying')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
