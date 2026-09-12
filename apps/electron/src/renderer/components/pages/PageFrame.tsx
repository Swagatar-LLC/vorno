import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type {
  LoadedPage,
  PageActionRequest,
  PageActionResult,
  PageDataSnapshot,
  PageKind,
  PageRenderLease,
} from '@craft-agent/shared/pages/types'
import { isPageGrantUsable } from '@craft-agent/shared/pages/types'
import {
  PageActionRateLimiter,
  buildPageActionResultMessage,
  buildPageDataMessage,
  buildPageGrantsMessage,
  buildPageInitMessage,
  descriptorSignature,
  grantIdsEqual,
  isMutatingPageAction,
  isSafeExternalUrl,
  parsePageBridgeMessage,
  reconcileGrantSummaries,
  toGrantSummary,
  type PageBridgeIncoming,
  type PageGrantRequestEntry,
  type PageGrantSummary,
} from '../../../shared/page-bridge'

/**
 * The dedicated sandboxed Page renderer + trusted bridge host.
 *
 * Security posture (per the Pages design, §7):
 * - `sandbox`: static pages get the empty set (no scripts at all);
 *   interactive/live get exactly `allow-scripts allow-forms`.
 *   NEVER `allow-same-origin` — scripts + same-origin would let page JS reach
 *   this document and the electronAPI adapter. The frame's origin is opaque.
 * - The srcDoc content is rendered EXACTLY as returned by `pages:createLease`
 *   (the lease is bound to that content's digest); nothing is injected.
 *   The lease nonce travels via postMessage `init` after load, and the page
 *   echoes it on every privileged request.
 * - Every incoming message must come from this frame's contentWindow with an
 *   opaque origin and parse against the strict schema in shared/page-bridge.
 * - Mutating actions additionally require a host-minted activation ticket. The
 *   classification is the SHARED one (only api GET is exempt), and the ticket
 *   is minted by Electron main from a gesture main itself observed — see
 *   roadmap/evidence/SUV-0065 for why no renderer-visible activation signal is
 *   trustworthy here. This component asks; it cannot vouch.
 * - Grant requests never mint anything by themselves: `pages:requestGrant`
 *   reaches the Electron-main host's native confirmation surface, then the
 *   host binds an accepted descriptor to the current content digest. Denied
 *   descriptors are remembered per render so a page cannot re-prompt in a loop.
 * - Per-frame budget: bounded in-flight actions and a 30/minute window. The
 *   server-side PageActionBroker independently re-validates lease, nonce,
 *   replay, grant, and timeout — this component is the first gate, not the
 *   only one.
 */

interface PageFrameProps {
  workspaceId: string
  page: LoadedPage
  lease: PageRenderLease
  /** Exact content string returned with the lease (digest-bound) */
  content: string
  /**
   * Data snapshot handed to the page in `init`. Live pages also receive
   * replacement snapshots via `data` messages when this prop changes.
   */
  snapshot: PageDataSnapshot | null
  className?: string
}

function sandboxForKind(kind: PageKind): string {
  return kind === 'static' ? '' : 'allow-scripts allow-forms'
}

/**
 * Transient user activation as the RENDERER sees it.
 *
 * Kept for `open-url` only, and deliberately not used to gate privileged
 * actions: the SUV-0065 experiment measured this reading as `true` after a
 * click anywhere in the window, so it is a courtesy check against timer-driven
 * link-outs, never proof that the Page was clicked.
 */
function hasUserActivation(): boolean {
  const nav = navigator as Navigator & { userActivation?: { isActive?: boolean } }
  return nav.userActivation?.isActive === true
}

/**
 * A render may hold at most this many distinct descriptors awaiting consent.
 * Each one costs a native prompt the user has to answer in order, so a page
 * that asks for a hundred capabilities at once gets a bounded prefix rather
 * than a hundred-deep modal queue. Dropping is not denial: once the queue
 * drains, a later request for the same descriptor is accepted normally.
 */
const MAX_QUEUED_GRANT_REQUESTS_PER_RENDER = 8

export function PageFrame({ workspaceId, page, lease, content, snapshot, className }: PageFrameProps) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const snapshotRef = useRef(snapshot)
  const limiterRef = useRef<PageActionRateLimiter | null>(null)
  if (!limiterRef.current) limiterRef.current = new PageActionRateLimiter()

  const pageSlug = page.config.slug
  const kind = page.config.kind

  // ------------------------------------------------------------------
  // Grants (usable = bound to the rendered digest and not expired).
  // Seeded from config at mount; grows via in-dialog approvals and via
  // config updates (e.g. grants issued from another surface).
  // ------------------------------------------------------------------
  const usableConfigGrants = useCallback((): PageGrantSummary[] => {
    const now = Date.now()
    return (page.config.grants ?? [])
      .filter(g => isPageGrantUsable(g, lease.contentDigest, now))
      .map(toGrantSummary)
  }, [page.config.grants, lease.contentDigest])

  const [grants, setGrants] = useState<PageGrantSummary[]>(usableConfigGrants)
  const grantsRef = useRef(grants)
  grantsRef.current = grants

  const deniedRef = useRef<Set<string>>(new Set())
  /** Serialized per-render requests keep one Page from filling host chrome. */
  const grantRequestQueueRef = useRef<PageGrantRequestEntry[]>([])
  const pendingGrantSignaturesRef = useRef<Set<string>>(new Set())
  const grantRequestInFlightRef = useRef(false)
  /**
   * Which render the queue currently belongs to. A consent round trip outlives
   * the render that started it, so every queue decision reads this instead of
   * a value captured in a closure.
   */
  const renderGenerationRef = useRef(0)
  /** The live lease, so a drain still running after a re-render uses the new one. */
  const leaseRef = useRef(lease)
  leaseRef.current = lease
  /** Approvals from this render the config watcher hasn't confirmed yet. */
  const locallyIssuedRef = useRef<Set<string>>(new Set())

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    // '*' is required: an opaque-origin frame cannot be addressed by origin.
    // The payload never contains credentials, and only THIS frame's window
    // object receives it.
    iframeRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  const postInit = useCallback(() => {
    postToFrame(
      buildPageInitMessage({ slug: pageSlug, kind }, lease.nonce, snapshotRef.current, grantsRef.current),
    )
  }, [postToFrame, pageSlug, kind, lease.nonce])

  const postGrants = useCallback(
    (next: PageGrantSummary[]) => {
      setGrants(next)
      grantsRef.current = next
      postToFrame(buildPageGrantsMessage(next))
    },
    [postToFrame],
  )

  // Reconcile against the config (the source of truth): grants issued from
  // other surfaces appear, revoked grants disappear — so page buttons disable
  // live. In-dialog approvals the watcher hasn't confirmed yet are kept via
  // locallyIssuedRef (reconcileGrantSummaries releases them on confirmation).
  useEffect(() => {
    const next = reconcileGrantSummaries(grantsRef.current, usableConfigGrants(), locallyIssuedRef.current)
    if (!grantIdsEqual(next, grantsRef.current)) {
      postGrants(next)
    }
  }, [usableConfigGrants, postGrants])

  // A denial belongs only to the rendered content. New content gets a fresh
  // digest-bound grant request rather than inheriting the old deny-memory.
  // Bumping the generation is what makes that true: a request still in flight
  // from the previous render resolves into a cleared state, and without a
  // generation its denial would be written into THIS render's deny-memory —
  // silently suppressing the first request the new content ever makes.
  useEffect(() => {
    renderGenerationRef.current += 1
    deniedRef.current.clear()
    grantRequestQueueRef.current = []
    pendingGrantSignaturesRef.current.clear()
  }, [lease.leaseId, lease.contentDigest])

  // Live pages get replacement snapshots; interactive pages keep their
  // init-time snapshot (per the kind contract).
  useEffect(() => {
    const changed = snapshotRef.current !== snapshot
    snapshotRef.current = snapshot
    if (changed && kind === 'live') {
      postToFrame(buildPageDataMessage(snapshot))
    }
  }, [snapshot, kind, postToFrame])

  const handleAction = useCallback(
    async (msg: Extract<PageBridgeIncoming, { type: 'action' }>) => {
      const limiter = limiterRef.current!
      const reject = (error: string) =>
        postToFrame(
          buildPageActionResultMessage({ requestId: msg.requestId, ok: false, error, durationMs: 0 }),
        )

      if (msg.nonce !== lease.nonce) {
        reject('nonce-mismatch: request nonce does not match the render lease')
        return
      }
      const mutating = isMutatingPageAction(msg.invocation)
      const limited = limiter.canStart(Date.now(), mutating)
      if (limited) {
        reject(`${limited}: too many page actions in flight`)
        return
      }

      limiter.start(msg.requestId, Date.now(), mutating)
      try {
        const request: PageActionRequest = {
          requestId: msg.requestId,
          pageSlug,
          leaseId: lease.leaseId,
          nonce: msg.nonce,
          grantId: msg.grantId,
          invocation: msg.invocation,
        }
        // A mutating action gets its proof of interaction from the host, for
        // this exact request, before it is sent. The broker refuses without one
        // regardless, so this is the path that makes a legitimate click work —
        // not the check that makes an illegitimate one fail.
        //
        // Only the desktop build can mint: the gesture is observed by Electron
        // main, and the WebUI has no main process to observe it. Saying so
        // here turns what would otherwise be a raw "not a function" into the
        // actual reason, and the refusal itself still comes from the broker.
        if (mutating && typeof window.electronAPI.requestPageActivation !== 'function') {
          reject('activation-unavailable: this action needs the desktop app, which can confirm a real click')
          return
        }
        const activated = mutating
          ? {
              ...request,
              activationTicket: (
                await window.electronAPI.requestPageActivation(workspaceId, pageSlug, request)
              ).ticketId,
            }
          : request
        const result: PageActionResult = await window.electronAPI.executePageAction(workspaceId, activated)
        postToFrame(buildPageActionResultMessage(result))
      } catch (err) {
        reject(err instanceof Error ? err.message : 'Action failed')
      } finally {
        limiter.finish(msg.requestId)
      }
    },
    [workspaceId, pageSlug, lease.leaseId, lease.nonce, postToFrame],
  )

  const processGrantRequestQueue = useCallback(async () => {
    if (grantRequestInFlightRef.current) return
    grantRequestInFlightRef.current = true
    try {
      while (grantRequestQueueRef.current.length > 0) {
        const entry = grantRequestQueueRef.current.shift()!
        // Bind the entry to the render it is being sent for. Anything still
        // queued after a digest change was enqueued by the new render, so the
        // live lease — not a closure-captured one — is the correct lease.
        const generation = renderGenerationRef.current
        const leaseId = leaseRef.current.leaseId
        const isCurrentRender = () => renderGenerationRef.current === generation
        const signature = descriptorSignature(entry.action)
        try {
          // The RPC host, not this renderer, owns consent and persistence.
          const grant = await window.electronAPI.requestPageGrant(workspaceId, pageSlug, {
            action: entry.action,
            ...(entry.description !== undefined ? { description: entry.description } : {}),
          }, leaseId)
          // The answer belongs to the render that asked. Applying a replaced
          // render's denial, grant, or toast here would speak for content the
          // user is no longer looking at.
          if (!isCurrentRender()) continue
          if (!grant) {
            deniedRef.current.add(signature)
            continue
          }
          locallyIssuedRef.current.add(grant.id)
          postGrants([...grantsRef.current, toGrantSummary(grant)])
          toast.success(t('toast.pageGrantsIssued'))
        } catch (err) {
          // A transient host failure is never deny-memory. The page may make
          // a later request, while this bounded queue releases the descriptor.
          if (!isCurrentRender()) continue
          toast.error(t('toast.pageGrantFailed'), {
            description: err instanceof Error ? err.message : String(err),
          })
        } finally {
          // Only release a signature this render actually reserved; the new
          // render's pending set is not this entry's to edit.
          if (isCurrentRender()) pendingGrantSignaturesRef.current.delete(signature)
        }
      }
    } finally {
      grantRequestInFlightRef.current = false
      postToFrame(buildPageGrantsMessage(grantsRef.current))
    }
  }, [workspaceId, pageSlug, postGrants, postToFrame, t])

  const handleGrantRequest = useCallback(
    (msg: Extract<PageBridgeIncoming, { type: 'grant-request' }>) => {
      if (msg.nonce !== lease.nonce) return
      const current = grantsRef.current
      const grantedSignatures = new Set(current.map(g => descriptorSignature(g.action)))
      const batchSignatures = new Set<string>()
      const remaining = msg.requests.filter(req => {
        const signature = descriptorSignature(req.action)
        if (batchSignatures.has(signature)) return false
        batchSignatures.add(signature)
        return !grantedSignatures.has(signature) &&
          !deniedRef.current.has(signature) &&
          !pendingGrantSignaturesRef.current.has(signature)
      })
      // Even a duplicate bridge request needs a grants reply; otherwise the
      // opaque frame can wait forever for a result. Distinct descriptors enter
      // the per-render queue and run one at a time after the prior decision.
      if (remaining.length === 0) {
        postToFrame(buildPageGrantsMessage(current))
        return
      }
      // The queue is a user-attention budget, not a buffer: admit up to the
      // per-render cap and let the rest go unqueued. They are neither denied
      // nor remembered, so the page can ask again once the queue drains.
      // The pending set holds queued AND in-flight signatures (the drain
      // releases one only after its decision), so it is the whole outstanding
      // count — adding the queue length again would double-count.
      const capacity = MAX_QUEUED_GRANT_REQUESTS_PER_RENDER - pendingGrantSignaturesRef.current.size
      if (capacity <= 0) {
        postToFrame(buildPageGrantsMessage(current))
        return
      }
      for (const entry of remaining.slice(0, capacity)) {
        pendingGrantSignaturesRef.current.add(descriptorSignature(entry.action))
        grantRequestQueueRef.current.push(entry)
      }
      void processGrantRequestQueue()
    },
    [lease.nonce, postToFrame, processGrantRequestQueue],
  )

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      // No allow-same-origin → the frame's origin is opaque, serialized 'null'.
      if (event.origin !== 'null') return
      const msg = parsePageBridgeMessage(event.data)
      if (!msg) return

      switch (msg.type) {
        case 'ready':
          postInit()
          break
        case 'action':
          void handleAction(msg)
          break
        case 'action-cancel':
          if (msg.nonce === lease.nonce) {
            void window.electronAPI.cancelPageAction(workspaceId, msg.requestId, lease.leaseId, lease.nonce)
          }
          break
        case 'open-url':
          // Only real link-outs: correct nonce, http(s), and a live user gesture.
          if (msg.nonce === lease.nonce && isSafeExternalUrl(msg.url) && hasUserActivation()) {
            void window.electronAPI.openUrl(msg.url)
          }
          break
        case 'grant-request':
          void handleGrantRequest(msg)
          break
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [handleAction, handleGrantRequest, postInit, lease.nonce, workspaceId])

  // Abort anything still in flight when the render goes away; the lease
  // release (PageView) invalidates the rest server-side.
  useEffect(() => {
    const limiter = limiterRef.current!
    // Capture the lease this cleanup belongs to: cancellation is lease-bound,
    // and by the time an unmount runs, `lease` may already be the next render's.
    const { leaseId, nonce } = leaseRef.current
    return () => {
      grantRequestQueueRef.current = []
      pendingGrantSignaturesRef.current.clear()
      for (const requestId of limiter.inFlightIds) {
        void window.electronAPI.cancelPageAction(workspaceId, requestId, leaseId, nonce)
      }
    }
  }, [workspaceId])

  return (
    <>
      <iframe
        ref={iframeRef}
        title={page.config.name}
        sandbox={sandboxForKind(kind)}
        referrerPolicy="no-referrer"
        srcDoc={content}
        onLoad={postInit}
        className={className ?? 'h-full w-full border-0 bg-white'}
      />
    </>
  )
}
