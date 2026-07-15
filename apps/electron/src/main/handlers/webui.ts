/**
 * fork(PLAN-020): craft-fork:webui:* IPC handlers.
 *
 * Main-process-only (LOCAL_ONLY) — the WebUiSupervisor is main-process runtime
 * state. Both the tray and the Remote Access settings page (WebUiSection) drive
 * this one supervisor, so their views stay coherent. Mirrors the PLAN-012
 * trigger-server handler registration.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { loadServerConfig } from '@craft-agent/http-trigger/core';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { WebUiSupervisor } from '../webui/supervisor';
import type { WebUiRemoteConfig } from '../../shared/types';

export const WEBUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.webui.GET_CONFIG,
  RPC_CHANNELS.webui.UPDATE_CONFIG,
  RPC_CHANNELS.webui.GET_STATUS,
  RPC_CHANNELS.webui.START,
  RPC_CHANNELS.webui.STOP,
  RPC_CHANNELS.webui.REGENERATE_PASSWORD,
] as const;

export function registerWebUiHandlers(
  server: RpcServer,
  supervisor: WebUiSupervisor,
): void {
  server.handle(RPC_CHANNELS.webui.GET_CONFIG, async () => {
    return supervisor.getConfig();
  });

  server.handle(
    RPC_CHANNELS.webui.UPDATE_CONFIG,
    async (_ctx, updates: Partial<Pick<WebUiRemoteConfig, 'enabled' | 'port' | 'host' | 'tunnel'>>) => {
      if (typeof updates?.port === 'number') {
        const port = updates.port;
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error(`Port must be an integer between 1024 and 65535, got ${port}`);
        }
        // Reject collision with the trigger-server's configured port — the two
        // listeners are independent and must never share a port.
        const triggerPort = loadServerConfig().port;
        if (port === triggerPort) {
          throw new Error(`Port ${port} is already used by the trigger server`);
        }
      }
      // fork(PLAN-022): validate host is a non-empty string — the UI only sends
      // known values (127.0.0.1 / 0.0.0.0 / a preserved custom IP), but guard the
      // IPC boundary against empties that would break bind.
      if (updates?.host !== undefined && (typeof updates.host !== 'string' || updates.host.trim() === '')) {
        throw new Error('Host must be a non-empty string');
      }
      // fork(PLAN-022): validate the secure-tunnel provider at the IPC boundary —
      // only the closed union ('none' | 'tailscale') is accepted.
      if (updates?.tunnel !== undefined) {
        const provider = updates.tunnel?.provider;
        if (provider !== 'none' && provider !== 'tailscale') {
          throw new Error(`Unknown tunnel provider: ${String(provider)}`);
        }
      }
      return supervisor.updateConfig(updates ?? {});
    },
  );

  server.handle(RPC_CHANNELS.webui.GET_STATUS, async () => {
    return supervisor.getStatus();
  });

  server.handle(RPC_CHANNELS.webui.START, async () => {
    return supervisor.start();
  });

  server.handle(RPC_CHANNELS.webui.STOP, async () => {
    await supervisor.stop();
  });

  server.handle(RPC_CHANNELS.webui.REGENERATE_PASSWORD, async () => {
    return supervisor.regeneratePassword();
  });
}
