/**
 * Deferred-save / next-turn-injection guards for the follow-up send queue.
 *
 * These live under `apps/webui` on purpose. The webui ships the *same* renderer
 * bundle as the desktop app (`apps/webui/vite.config.ts` aliases `@` →
 * `apps/electron/src/renderer`), but only the webui suite is CI-gated at zero
 * failures (`bun run test:webui` → `.github/workflows/validate-pr.yml`), and the
 * webui is where the bug bites hardest: its `sessionCommand` round-trip and its
 * `message_annotations_updated` echo both cross a WebSocket proxy, so the window
 * between "server saved the annotation" and "the composer can see it" is
 * hundreds of milliseconds instead of a frame.
 *
 * Incident this suite is derived from: 260724-light-delta, 2026-07-25 — a
 * follow-up created at 01:01:41 was omitted from the 01:04:50 send and later
 * injected itself into two subsequent turns.
 */

import { describe, expect, test } from 'bun:test'
import {
  ECHO_PENDING_TTL_MS,
  SAVE_AND_SEND_MAX_FRAMES,
  buildServerAnnotationIdIndex,
  composeOutgoingMessage,
  mergePendingFollowUps,
  pruneEchoPendingFollowUps,
  resolveSaveAndSendDecision,
  type EchoPendingFollowUp,
} from '../../../../electron/src/renderer/components/app-shell/follow-up-send-queue'
import type { PendingFollowUpAnnotation } from '../../../../electron/src/renderer/components/app-shell/ChatDisplay.follow-ups'

const MSG = 'msg-1784951146533-jztmef'
const ANN = 'ann-1784955701660-0yhril'

function followUp(overrides: Partial<PendingFollowUpAnnotation> = {}): PendingFollowUpAnnotation {
  return {
    messageId: MSG,
    annotationId: ANN,
    note: 'The wording is fantastic, thank you for the reminder.',
    selectedText: '#119 (add DIR-04 to ROADMAP.md)',
    createdAt: 1_784_955_701_660,
    ...overrides,
  }
}

function echoPending(overrides: Partial<EchoPendingFollowUp> = {}): EchoPendingFollowUp {
  return { ...followUp(), recordedAt: 1_784_955_701_660, ...overrides }
}

const NO_ECHO = new Map<string, Set<string>>()

describe('mergePendingFollowUps — the deferred-save window', () => {
  test('a server-ACKed follow-up is visible to the composer before its echo arrives', () => {
    // This is the whole bug in one assertion. Server state is still empty
    // because `message_annotations_updated` has not been applied yet; the
    // composer must still see the follow-up.
    const merged = mergePendingFollowUps({
      serverDerived: [],
      echoPending: [echoPending()],
      serverAnnotationIdsByMessage: NO_ECHO,
      now: 1_784_955_701_700,
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]!.annotationId).toBe(ANN)
  })

  test('the echoed copy wins once it lands — no duplicate chip, no stale note text', () => {
    const merged = mergePendingFollowUps({
      serverDerived: [followUp({ note: 'edited after saving' })],
      echoPending: [echoPending({ note: 'text captured at add time' })],
      serverAnnotationIdsByMessage: buildServerAnnotationIdIndex([
        { id: MSG, annotations: [{ id: ANN }] },
      ]),
      now: 1_784_955_701_700,
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]!.note).toBe('edited after saving')
  })

  test('order is by creation time so [#1]/[#2] numbering matches the chip row', () => {
    const merged = mergePendingFollowUps({
      serverDerived: [followUp({ annotationId: 'ann-b', createdAt: 200 })],
      echoPending: [echoPending({ annotationId: 'ann-a', createdAt: 100 })],
      serverAnnotationIdsByMessage: NO_ECHO,
      now: 300,
    })

    expect(merged.map(f => f.annotationId)).toEqual(['ann-a', 'ann-b'])
  })

  test('an unrelated message echoing does not evict a still-unechoed follow-up', () => {
    const merged = mergePendingFollowUps({
      serverDerived: [],
      echoPending: [echoPending()],
      serverAnnotationIdsByMessage: buildServerAnnotationIdIndex([
        { id: 'msg-other', annotations: [{ id: 'ann-other' }] },
      ]),
      now: 1_784_955_701_700,
    })

    expect(merged).toHaveLength(1)
  })
})

describe('pruneEchoPendingFollowUps — never resurrect a removed follow-up', () => {
  test('drops the entry once the server echoes the message containing it', () => {
    const remaining = pruneEchoPendingFollowUps({
      echoPending: [echoPending()],
      serverAnnotationIdsByMessage: buildServerAnnotationIdIndex([
        { id: MSG, annotations: [{ id: ANN }] },
      ]),
      now: 1_784_955_701_700,
    })

    expect(remaining).toEqual([])
  })

  test('a sibling annotation echoing first does not evict our still-unechoed entry', () => {
    // Absence from the echoed set is NOT evidence of removal: a message
    // commonly already carries other annotations. Evicting here would
    // reintroduce the deferred-save bug for any second follow-up on a message.
    const remaining = pruneEchoPendingFollowUps({
      echoPending: [echoPending()],
      serverAnnotationIdsByMessage: buildServerAnnotationIdIndex([
        { id: MSG, annotations: [{ id: 'ann-someone-else' }] },
      ]),
      now: 1_784_955_701_700,
    })

    expect(remaining).toHaveLength(1)
  })

  test('a lost echo expires instead of producing an immortal chip', () => {
    const args = {
      echoPending: [echoPending({ recordedAt: 1_000 })],
      serverAnnotationIdsByMessage: NO_ECHO,
    }

    expect(pruneEchoPendingFollowUps({ ...args, now: 1_000 + ECHO_PENDING_TTL_MS })).toHaveLength(1)
    expect(pruneEchoPendingFollowUps({ ...args, now: 1_001 + ECHO_PENDING_TTL_MS })).toHaveLength(0)
  })

  test('an empty annotations echo is ambiguous and does not evict early', () => {
    // `annotations: []` is what a message looks like both before its first
    // annotation and after its last one is removed. Only the TTL can settle it.
    const remaining = pruneEchoPendingFollowUps({
      echoPending: [echoPending()],
      serverAnnotationIdsByMessage: buildServerAnnotationIdIndex([{ id: MSG, annotations: [] }]),
      now: 1_784_955_701_700,
    })

    expect(remaining).toHaveLength(1)
  })

  test('the TTL is wide enough to cover a mobile round-trip, not just a frame', () => {
    // The window this module is responsible for is the RPC + echo round-trip.
    // A sub-second TTL would reopen the bug on a stalled radio.
    expect(ECHO_PENDING_TTL_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('resolveSaveAndSendDecision — a timed-out Save & Send must not send bare', () => {
  const target = { messageId: MSG, annotationId: ANN }

  test('waits while the follow-up is not yet visible', () => {
    expect(resolveSaveAndSendDecision({ target, pending: [], frames: 0 }))
      .toEqual({ action: 'wait' })
  })

  test('sends as soon as the follow-up becomes visible', () => {
    expect(resolveSaveAndSendDecision({ target, pending: [followUp()], frames: 3 }))
      .toEqual({ action: 'send' })
  })

  test('aborts — does NOT send — when the bounded wait runs out', () => {
    // Regression guard for the next-turn injection: the pre-fix gate fell
    // through to `send` here, dispatching a message that omitted the follow-up
    // while leaving it pending, which guaranteed it rode the NEXT turn.
    expect(resolveSaveAndSendDecision({
      target,
      pending: [],
      frames: SAVE_AND_SEND_MAX_FRAMES,
    })).toEqual({ action: 'abort', reason: 'follow-up-not-visible' })
  })

  test('a follow-up on a different message does not satisfy the gate', () => {
    expect(resolveSaveAndSendDecision({
      target,
      pending: [followUp({ messageId: 'msg-1784956337645-frtd7a' })],
      frames: 1,
    })).toEqual({ action: 'wait' })
  })
})

describe('composeOutgoingMessage', () => {
  test('appends the follow-up section under a separator when there is a base message', () => {
    const composed = composeOutgoingMessage('here is my reply', [followUp()])

    expect(composed).toContain('here is my reply')
    expect(composed).toContain('**Follow-ups**')
    expect(composed).toContain('> [#1] #119 (add DIR-04 to ROADMAP.md)')
    expect(composed).toContain('→ The wording is fantastic, thank you for the reminder.')
  })

  test('returns the base message untouched when nothing is pending', () => {
    expect(composeOutgoingMessage('plain message', [])).toBe('plain message')
  })

  test('a follow-up-only send carries no leading separator', () => {
    expect(composeOutgoingMessage('', [followUp()]).startsWith('**Follow-ups**')).toBe(true)
  })
})

/**
 * End-to-end replay of the incident timeline against the merged state rules.
 * The simulator models exactly the three moving parts that produced it:
 * the server store, the (delayable) echo, and the composer's derived view.
 */
describe('incident replay — 260724-light-delta', () => {
  type Sim = {
    serverAnnotations: Map<string, Array<{ id: string; note: string }>>
    echoedAnnotations: Map<string, Set<string>>
    echoPending: EchoPendingFollowUp[]
    sent: string[]
    clock: number
  }

  function newSim(): Sim {
    return {
      serverAnnotations: new Map(),
      echoedAnnotations: new Map(),
      echoPending: [],
      sent: [],
      clock: 1_000,
    }
  }

  /** Server accepts the add; the echo is deliberately NOT delivered yet. */
  function addAnnotation(sim: Sim, messageId: string, annotationId: string, note: string): void {
    const existing = sim.serverAnnotations.get(messageId) ?? []
    sim.serverAnnotations.set(messageId, [...existing, { id: annotationId, note }])
    sim.echoPending.push(echoPending({ messageId, annotationId, note, recordedAt: sim.clock }))
  }

  /** Deliver `message_annotations_updated` for one message. */
  function deliverEcho(sim: Sim, messageId: string): void {
    sim.echoedAnnotations.set(
      messageId,
      new Set((sim.serverAnnotations.get(messageId) ?? []).map(a => a.id)),
    )
  }

  function serverDerivedFrom(sim: Sim): PendingFollowUpAnnotation[] {
    const out: PendingFollowUpAnnotation[] = []
    for (const [messageId, ids] of sim.echoedAnnotations) {
      for (const id of ids) {
        const stored = sim.serverAnnotations.get(messageId)?.find(a => a.id === id)
        if (stored) out.push(followUp({ messageId, annotationId: id, note: stored.note }))
      }
    }
    return out
  }

  function composerPending(sim: Sim): PendingFollowUpAnnotation[] {
    return mergePendingFollowUps({
      serverDerived: serverDerivedFrom(sim),
      echoPending: sim.echoPending,
      serverAnnotationIdsByMessage: sim.echoedAnnotations,
      now: sim.clock,
    })
  }

  /** What `handleSubmit` does: compose, send, then mark the batch sent. */
  function send(sim: Sim, base: string): string {
    const pending = composerPending(sim)
    const body = composeOutgoingMessage(base, pending)
    sim.sent.push(body)
    for (const f of pending) {
      const stored = sim.serverAnnotations.get(f.messageId)
      if (stored) {
        sim.serverAnnotations.set(f.messageId, stored.filter(a => a.id !== f.annotationId))
      }
      sim.echoPending = sim.echoPending.filter(e => e.annotationId !== f.annotationId)
      deliverEcho(sim, f.messageId)
    }
    return body
  }

  test('REPRODUCTION: server-echo-only derivation defers the follow-up to the next turn', () => {
    // This models the pre-fix renderer exactly: `pendingFollowUpAnnotations`
    // was derived from `session.messages[].annotations` alone, so anything the
    // echo had not delivered yet was invisible to the composer.
    const sim = newSim()
    addAnnotation(sim, MSG, ANN, 'the wording is great')
    sim.clock += 9_000

    // Turn 1: the follow-up is saved server-side but omitted from the send.
    expect(composeOutgoingMessage('ok, moving on', serverDerivedFrom(sim))).toBe('ok, moving on')

    // The echo lands after the send...
    deliverEcho(sim, MSG)

    // ...and turn 2 carries a follow-up the user believed already went out.
    expect(composeOutgoingMessage('next message', serverDerivedFrom(sim)))
      .toContain('the wording is great')
  })

  test('a send inside the add round-trip carries the follow-up (no next-turn deferral)', () => {
    const sim = newSim()
    addAnnotation(sim, MSG, ANN, 'the wording is great')
    // Echo has NOT arrived. Pre-fix, the composer's pending list was empty here
    // and the send went out bare, deferring the follow-up to the next turn.
    sim.clock += 9_000

    const first = send(sim, 'ok, moving on')
    expect(first).toContain('the wording is great')

    // ...and it is gone afterwards, so the next turn is clean.
    const second = send(sim, 'next message')
    expect(second).toBe('next message')
    expect(second).not.toContain('the wording is great')
  })

  test('a delayed echo cannot re-inject an already-sent follow-up', () => {
    const sim = newSim()
    addAnnotation(sim, MSG, ANN, 'the wording is great')
    send(sim, 'ok, moving on')

    // The echo for the original add finally shows up, out of order.
    sim.echoedAnnotations.set(MSG, new Set([ANN]))
    sim.echoedAnnotations.set(MSG, new Set())

    expect(send(sim, 'next message')).toBe('next message')
  })

  test('no follow-up-only ghost message is produced once the composer is caught up', () => {
    const sim = newSim()
    addAnnotation(sim, MSG, ANN, 'the wording is great')
    send(sim, '')

    // The ghost turn (incident msg-1784956584562-16pgqt) came from re-sending
    // an empty base with a still-pending follow-up. After a clean send there is
    // nothing left to compose, so an empty send stays empty.
    expect(composerPending(sim)).toEqual([])
    expect(composeOutgoingMessage('', composerPending(sim))).toBe('')
  })
})
