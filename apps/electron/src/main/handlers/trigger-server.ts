/**
 * fork(PLAN-012): craft-fork:triggerServer:* IPC handlers.
 *
 * Main-process-only (LOCAL_ONLY) because the supervisor is main-process runtime
 * state. Both the tray and RemoteAccessSettingsPage drive this one supervisor, so
 * their views stay coherent. CREATE_API_KEY returns { fullKey, info } — the only
 * time the plaintext key crosses IPC; the renderer shows it once and drops it.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { TriggerServerSupervisor } from '../trigger-server/supervisor';
import type { RemoteAccessConfig, RemoteAccessApiKeyPermissions } from '../../shared/types';

export const TRIGGER_SERVER_HANDLED_CHANNELS = [
  RPC_CHANNELS.triggerServer.GET_CONFIG,
  RPC_CHANNELS.triggerServer.UPDATE_CONFIG,
  RPC_CHANNELS.triggerServer.GET_STATUS,
  RPC_CHANNELS.triggerServer.START,
  RPC_CHANNELS.triggerServer.STOP,
  RPC_CHANNELS.triggerServer.CREATE_API_KEY,
  RPC_CHANNELS.triggerServer.REVOKE_API_KEY,
] as const;

export function registerTriggerServerHandlers(
  server: RpcServer,
  supervisor: TriggerServerSupervisor,
): void {
  server.handle(RPC_CHANNELS.triggerServer.GET_CONFIG, async () => {
    return supervisor.getConfig();
  });

  server.handle(RPC_CHANNELS.triggerServer.UPDATE_CONFIG, async (_ctx, updates: Partial<RemoteAccessConfig>) => {
    if (typeof updates?.port === 'number' && (updates.port < 1024 || updates.port > 65535)) {
      throw new Error(`Port must be between 1024 and 65535, got ${updates.port}`);
    }
    return supervisor.updateConfig(updates ?? {});
  });

  server.handle(RPC_CHANNELS.triggerServer.GET_STATUS, async () => {
    return supervisor.getStatus();
  });

  server.handle(RPC_CHANNELS.triggerServer.START, async () => {
    return supervisor.start();
  });

  server.handle(RPC_CHANNELS.triggerServer.STOP, async () => {
    await supervisor.stop();
  });

  server.handle(
    RPC_CHANNELS.triggerServer.CREATE_API_KEY,
    async (_ctx, name: string, permissions: RemoteAccessApiKeyPermissions) => {
      if (!name || typeof name !== 'string') {
        throw new Error('API key name is required');
      }
      return supervisor.createApiKey(name, {
        workspaceIds: permissions?.workspaceIds ?? [],
        permissionPolicy: permissions?.permissionPolicy ?? 'allow-safe',
        maxConcurrentSessions: permissions?.maxConcurrentSessions ?? 3,
      });
    },
  );

  server.handle(RPC_CHANNELS.triggerServer.REVOKE_API_KEY, async (_ctx, keyId: string) => {
    const revoked = supervisor.revokeApiKey(keyId);
    if (!revoked) throw new Error(`API key not found: ${keyId}`);
  });
}
