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

import { Tray, Menu, clipboard, shell, type MenuItemConstructorOptions } from 'electron';
import { i18n } from '@craft-agent/shared/i18n';
import { renderTrayIcon } from './tray-icon';
import type { TriggerServerSupervisor } from './supervisor';
// fork(PLAN-020): the tray also supervises the browser WebUI listener.
import type { WebUiSupervisor } from '../webui/supervisor';
import type { RemoteAccessStatus, WebUiStatus } from '../../shared/types';

// fork(PLAN-020): WebUI status line interpolates a loopback host (the listener
// binds 127.0.0.1 in v1; the URL is loopback-scoped).
const WEBUI_HOST = '127.0.0.1';

export interface TriggerServerTrayOptions {
  supervisor: TriggerServerSupervisor;
  /** fork(PLAN-020): WebUI supervisor — independent Start/Stop in the same menu. */
  webUiSupervisor: WebUiSupervisor;
  /** Focus/create the main window and navigate to settings/remote-access. */
  onOpenSettings: () => void;
  /** Focus/create the main window. */
  onShowWindow: () => void;
}

export class TriggerServerTray {
  private tray: Tray | null = null;
  private readonly supervisor: TriggerServerSupervisor;
  // fork(PLAN-020)
  private readonly webUiSupervisor: WebUiSupervisor;
  private readonly onOpenSettings: () => void;
  private readonly onShowWindow: () => void;

  constructor(opts: TriggerServerTrayOptions) {
    this.supervisor = opts.supervisor;
    this.webUiSupervisor = opts.webUiSupervisor;
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

    // fork(PLAN-020): WebUI section — independent Start/Stop for the browser
    // WebUI listener, mirroring the trigger-server items above.
    items.push({ type: 'separator' });
    const webUiStatus = this.webUiSupervisor.getStatus();
    items.push(...this.buildWebUiItems(webUiStatus));

    items.push({ type: 'separator' });
    items.push({ label: i18n.t('tray.settings'), click: () => this.onOpenSettings() });
    items.push({ label: i18n.t('tray.showWindow'), click: () => this.onShowWindow() });

    return items;
  }

  // fork(PLAN-020): WebUI submenu items, mirroring the trigger-server structure.
  private buildWebUiItems(status: WebUiStatus): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [
      { label: this.webUiStatusLine(status), enabled: false },
    ];

    if (status.state === 'running') {
      items.push({ label: i18n.t('tray.webui.stop'), click: () => void this.webUiSupervisor.stop() });
      if (status.url) {
        const url = status.url;
        items.push({ label: i18n.t('tray.webui.open'), click: () => void shell.openExternal(url) });
        items.push({ label: i18n.t('tray.webui.copyUrl'), click: () => clipboard.writeText(url) });
      }
      items.push({
        label: i18n.t('tray.webui.copyPassword'),
        click: () => {
          const password = this.webUiSupervisor.getConfig().password;
          if (password) clipboard.writeText(password);
        },
      });
    } else if (status.state === 'error') {
      items.push({ label: i18n.t('tray.webui.start'), click: () => void this.webUiSupervisor.start() });
    } else if (status.state === 'stopped') {
      items.push({ label: i18n.t('tray.webui.start'), click: () => void this.webUiSupervisor.start() });
    } else {
      // starting / stopping — transient, no action offered
      items.push({ label: i18n.t('tray.webui.start'), enabled: false });
    }

    return items;
  }

  // fork(PLAN-020)
  private webUiStatusLine(status: WebUiStatus): string {
    switch (status.state) {
      case 'running':
        return i18n.t('tray.webui.statusRunning', { host: WEBUI_HOST, port: status.port });
      case 'starting':
        return i18n.t('tray.webui.statusStarting');
      case 'stopping':
        return i18n.t('tray.webui.statusStopping');
      case 'error':
        return i18n.t('tray.webui.statusError');
      default:
        return i18n.t('tray.webui.statusStopped');
    }
  }
}
