/**
 * fork(PLAN-022): connection-error screen.
 *
 * Shown when the RPC transport is unreachable at startup (the browser WebUI
 * loaded and authenticated, but the WS-RPC connection can't be established, so
 * getSetupNeeds() throws). Previously this state fell through to the onboarding
 * walkthrough "to be safe" — a misleading dead end that hid an infrastructure
 * failure as first-run state (LEARNING-028). This full-screen surface names the
 * problem and offers Retry, which re-runs the init flow.
 *
 * Styling reuses the workspace-picker primitives so it reads as a native
 * first-screen state. Product name comes from branding — never hardcoded.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PRODUCT_NAME } from '@craft-agent/shared/branding'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from './workspace/primitives'

export interface ConnectionErrorScreenProps {
  /** Re-run the init flow. May be async; the button shows a spinner while it runs. */
  onRetry: () => void | Promise<void>
}

export function ConnectionErrorScreen({ onRetry }: ConnectionErrorScreenProps) {
  const { t } = useTranslation()
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      <AddWorkspaceContainer>
        <AddWorkspaceStepHeader
          title={t('connectionError.title', { product: PRODUCT_NAME })}
          description={t('connectionError.description', { product: PRODUCT_NAME })}
        />
        <div className="mt-6 w-full">
          <AddWorkspacePrimaryButton
            onClick={handleRetry}
            loading={retrying}
            loadingText={t('connectionError.retrying')}
          >
            {t('common.retry')}
          </AddWorkspacePrimaryButton>
        </div>
      </AddWorkspaceContainer>
    </div>
  )
}
