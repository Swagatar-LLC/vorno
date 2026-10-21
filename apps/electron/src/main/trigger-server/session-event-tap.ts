/**
 * fork(PLAN-057): per-session tap on the SessionManager event sink.
 *
 * SessionManager emits every SessionEvent through its single event sink
 * (RPC_CHANNELS.sessions.EVENT). `tap.wrapSink(sink)` returns a sink that
 * forwards every call unchanged and also hands session events to listeners
 * subscribed for that sessionId, so the REST route-through can follow a turn
 * without modifying SessionManager.
 */

import type { SessionEvent } from '@craft-agent/shared/protocol';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { EventSink } from '@craft-agent/server-core/transport';

export type SessionEventListener = (event: SessionEvent) => void;

export interface SessionEventTap {
  wrapSink(sink: EventSink): EventSink;
  /** Returns an unsubscribe function. */
  subscribe(sessionId: string, listener: SessionEventListener): () => void;
}

export function createSessionEventTap(): SessionEventTap {
  const listeners = new Map<string, Set<SessionEventListener>>();

  return {
    wrapSink(sink) {
      const wrapped: EventSink = (channel, target, ...args) => {
        // Deliver to the normal sink first: the tap must never delay or drop UI events.
        sink(channel, target, ...args);
        if (channel !== RPC_CHANNELS.sessions.EVENT) return;
        const event = args[0] as SessionEvent | undefined;
        const set = event?.sessionId ? listeners.get(event.sessionId) : undefined;
        if (!set) return;
        for (const listener of [...set]) {
          try { listener(event!); } catch { /* a listener must not break event delivery */ }
        }
      };
      return wrapped;
    },
    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) { set = new Set(); listeners.set(sessionId, set); }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0 && listeners.get(sessionId) === set) listeners.delete(sessionId);
      };
    },
  };
}
