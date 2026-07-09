/**
 * Trigger-server tray (PLAN-012 §4) — macOS menu-bar presence that supervises the
 * embedded HTTP trigger server with truthful state and start/stop.
 *
 * The tray reads the supervisor directly (same process, no IPC) and rebuilds its
 * menu on every state change. VOR-11 scope (Quit item, close-to-tray, login item)
 * is deliberately OUT — this menu only supervises the server.
 *
 * darwin-first: creation is gated on platform by the caller. `Tray` is
 * cross-platform, so the design carries to Windows/Linux behind a follow-up.
 */

import { Tray, Menu, clipboard, type MenuItemConstructorOptions } from 'electron';
import { i18n } from '@craft-agent/shared/i18n';
import { renderTrayIcon } from './tray-icon';
import type { TriggerServerSupervisor } from './supervisor';
import type { RemoteAccessStatus } from '../../shared/types';

export interface TriggerServerTrayOptions {
  supervisor: TriggerServerSupervisor;
  /** Focus/create the main window and navigate to settings/remote-access. */
  onOpenSettings: () => void;
  /** Focus/create the main window. */
  onShowWindow: () => void;
}

export class TriggerServerTray {
  private tray: Tray | null = null;
  private readonly supervisor: TriggerServerSupervisor;
  private readonly onOpenSettings: () => void;
  private readonly onShowWindow: () => void;

  constructor(opts: TriggerServerTrayOptions) {
    this.supervisor = opts.supervisor;
    this.onOpenSettings = opts.onOpenSettings;
    this.onShowWindow = opts.onShowWindow;
  }

  /** Create the tray icon + menu. Call once, after the supervisor exists. */
  create(): void {
    if (this.tray) return;
    const status = this.supervisor.getStatus();
    this.tray = new Tray(renderTrayIcon(status.state));
    this.refresh();
  }

  /** Rebuild the icon, tooltip, and menu from current supervisor state. */
  refresh(): void {
    if (!this.tray) return;
    const status = this.supervisor.getStatus();
    this.tray.setImage(renderTrayIcon(status.state));
    this.tray.setToolTip(this.statusLine(status));
    this.tray.setContextMenu(Menu.buildFromTemplate(this.buildTemplate(status)));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  // -------------------------------------------------------------------------

  private statusLine(status: RemoteAccessStatus): string {
    switch (status.state) {
      case 'running':
        return i18n.t('tray.statusRunning', { host: status.host, port: status.port });
      case 'starting':
        return i18n.t('tray.statusStarting');
      case 'stopping':
        return i18n.t('tray.statusStopping');
      case 'error':
        return i18n.t('tray.statusError');
      default:
        return i18n.t('tray.statusStopped');
    }
  }

  private buildTemplate(status: RemoteAccessStatus): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [
      { label: this.statusLine(status), enabled: false },
    ];

    if (status.state === 'running') {
      items.push({
        label: i18n.t('tray.activeSessions', { count: status.activeSessions }),
        enabled: false,
      });
    }
    if (status.state === 'error' && status.lastError) {
      items.push({ label: status.lastError, enabled: false });
    }

    items.push({ type: 'separator' });

    if (status.state === 'running') {
      items.push({ label: i18n.t('tray.stop'), click: () => void this.supervisor.stop() });
      items.push({
        label: i18n.t('tray.copyUrl'),
        click: () => clipboard.writeText(`http://${status.host}:${status.port}`),
      });
    } else if (status.state === 'error') {
      items.push({ label: i18n.t('tray.retry'), click: () => void this.supervisor.start() });
    } else if (status.state === 'stopped') {
      items.push({ label: i18n.t('tray.start'), click: () => void this.supervisor.start() });
    } else {
      // starting / stopping — transient, no action offered
      items.push({ label: i18n.t('tray.start'), enabled: false });
    }

    items.push({ type: 'separator' });
    items.push({ label: i18n.t('tray.settings'), click: () => this.onOpenSettings() });
    items.push({ label: i18n.t('tray.showWindow'), click: () => this.onShowWindow() });

    return items;
  }
}
