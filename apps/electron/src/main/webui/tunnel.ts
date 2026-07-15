/**
 * fork(PLAN-022): secure-tunnel provider manager for the WebUI listener.
 *
 * Leg 4 productizes what PLAN-005 did as dev tooling: instead of binding a
 * headless server to the Tailscale IP by hand, the packaged app manages a
 * `tailscale serve` rule that fronts the loopback WebUI port with HTTPS (and,
 * thanks to the single-port WS proxy from leg 1, ONE serve rule covers HTTP+WS
 * because `serve` upgrades ws→wss automatically for the proxied `/ws` path).
 *
 * Design: an extensible provider abstraction keyed on `provider: 'none' |
 * 'tailscale'`. Only tailscale is implemented — the shape is deliberately
 * minimal (no provider registry) so cloudflared et al. can slot in later.
 *
 * The tailscale CLI is invoked via `execFile` (NEVER a shell — no interpolation)
 * with a bounded timeout. The `exec` seam is injectable so unit tests exercise
 * detect/up/off/error paths without a real binary. All CLI failures degrade
 * gracefully: absent CLI → actionable install guidance; `serve` failure (not
 * logged in, HTTPS not enabled on the tailnet) → stderr-derived guidance in the
 * tunnel status. Never a crash.
 *
 * Commands (verified against tailscale.com/kb/1242 `tailscale serve` reference,
 * 2026-07-15; CLI ≥1.52 syntax):
 *   up:     tailscale serve --bg --https=443 http://127.0.0.1:<port>
 *   off:    tailscale serve --https=443 off
 *   status: tailscale status --json      → .Self.DNSName for the ts.net URL
 */

import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SupervisorLogger } from '../trigger-server/supervisor';
import type { TunnelProvider, WebUiTunnelStatus } from '../../shared/types';

/** Standard macOS Tailscale.app bundle CLI path (the CLI ships inside the app). */
const MACOS_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** Serve HTTPS on the default tailnet port. */
const HTTPS_PORT = 443;

/** Bound every CLI call so a wedged daemon can't hang the app. */
const CLI_TIMEOUT_MS = 15_000;

const NOOP_LOGGER: SupervisorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Result of running the CLI (the fields the manager inspects). */
export interface TunnelExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Injectable exec seam. Rejects with an error whose `.code === 'ENOENT'` when
 * the binary is missing; otherwise resolves/rejects mirroring `execFile`. Tests
 * supply a fake; production uses `defaultExec` (real `execFile`).
 */
export type TunnelExec = (
  file: string,
  args: string[],
) => Promise<TunnelExecResult>;

/**
 * Injectable binary-locator seam. Returns the tailscale CLI path or null when no
 * CLI is found. Tests supply a fake; production uses `defaultLocateBinary`
 * (PATH probe + macOS app-bundle path).
 */
export type LocateTailscale = () => Promise<string | null>;

export interface TunnelManagerOptions {
  log?: SupervisorLogger;
  /** Test seam: run the CLI (defaults to real execFile with a timeout). */
  exec?: TunnelExec;
  /** Test seam: locate the tailscale binary (defaults to PATH + macOS bundle). */
  locateBinary?: LocateTailscale;
}

/** Default `execFile`-based exec with a hard timeout, promisified. */
function defaultExec(file: string, args: string[]): Promise<TunnelExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: CLI_TIMEOUT_MS, windowsHide: true },
      (err: ExecFileException | null, stdout, stderr) => {
        if (err) {
          // Attach captured stderr so the caller can surface guidance.
          (err as ExecFileException & { stderr?: string }).stderr =
            stderr?.toString() ?? '';
          reject(err);
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

/**
 * Default binary locator: prefer a `tailscale` on PATH (works for Homebrew /
 * Linux installs), else fall back to the standard macOS app-bundle CLI path.
 * Probed via a cheap `--version` call so we know it actually runs, not just that
 * a PATH entry resolved.
 */
function makeDefaultLocateBinary(exec: TunnelExec): LocateTailscale {
  return async () => {
    // PATH probe: `tailscale version` resolves via PATH; ENOENT ⇒ not on PATH.
    try {
      await exec('tailscale', ['version']);
      return 'tailscale';
    } catch {
      // Fall through to the macOS app-bundle path.
    }
    if (existsSync(MACOS_APP_CLI)) {
      return MACOS_APP_CLI;
    }
    return null;
  };
}

/**
 * Extract a single-line, user-facing guidance string from a failed CLI call.
 * tailscale writes actionable messages to stderr ("HTTPS must be enabled",
 * "not logged in", etc.); we surface the first non-empty line verbatim.
 */
function guidanceFromError(err: unknown): string {
  const stderr =
    (err as { stderr?: string })?.stderr?.trim() ??
    (err instanceof Error ? err.message : String(err));
  const firstLine = stderr.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return firstLine || 'tailscale serve failed';
}

/**
 * Manages the lifecycle of a secure tunnel in front of the WebUI port. Currently
 * implements the tailscale provider; `provider: 'none'` is a no-op. The manager
 * is stateless across calls except for the last computed status (for getStatus).
 */
export class TunnelManager {
  private readonly log: SupervisorLogger;
  private readonly exec: TunnelExec;
  private readonly locateBinary: LocateTailscale;

  /** Last computed status, for synchronous getStatus() reads by the supervisor. */
  private status: WebUiTunnelStatus = { provider: 'none', state: 'stopped' };

  constructor(opts: TunnelManagerOptions = {}) {
    this.log = opts.log ?? NOOP_LOGGER;
    this.exec = opts.exec ?? defaultExec;
    this.locateBinary = opts.locateBinary ?? makeDefaultLocateBinary(this.exec);
  }

  /** The last computed tunnel status (updated by up()/down()). */
  getStatus(): WebUiTunnelStatus {
    return this.status;
  }

  /**
   * Bring the tunnel up in front of `port` for the given provider.
   *
   * - provider 'none' → clears status to stopped (no CLI touched).
   * - provider 'tailscale' → locate the CLI (unavailable+guidance if absent),
   *   run `serve --bg --https=443 http://127.0.0.1:<port>`, then resolve the
   *   public ts.net URL from `tailscale status --json`.
   *
   * Never throws — every failure is folded into the returned status.
   */
  async up(provider: TunnelProvider, port: number): Promise<WebUiTunnelStatus> {
    if (provider === 'none') {
      this.status = { provider: 'none', state: 'stopped' };
      return this.status;
    }
    // provider === 'tailscale'
    this.status = { provider, state: 'starting' };

    const bin = await this.locateBinary();
    if (!bin) {
      this.status = {
        provider,
        state: 'unavailable',
        message: 'tailscale-cli-missing',
      };
      this.log.warn('[webui] tailscale CLI not found — tunnel unavailable');
      return this.status;
    }

    try {
      await this.exec(bin, [
        'serve',
        '--bg',
        `--https=${HTTPS_PORT}`,
        `http://127.0.0.1:${port}`,
      ]);
    } catch (err) {
      const message = guidanceFromError(err);
      this.status = { provider, state: 'error', message };
      this.log.error(`[webui] tailscale serve failed: ${message}`);
      return this.status;
    }

    // Resolve the public URL from `tailscale status --json` (best-effort — the
    // serve rule is already up even if we can't read the DNS name back).
    const url = await this.resolveUrl(bin);
    this.status = { provider, state: 'running', url };
    this.log.info(`[webui] tailscale serve up${url ? ` at ${url}` : ''}`);
    return this.status;
  }

  /**
   * Tear down the serve rule (best-effort — logs failures, never throws). A
   * provider of 'none' or a missing CLI is a no-op success. Always leaves the
   * status at 'stopped'.
   */
  async down(provider: TunnelProvider): Promise<void> {
    if (provider === 'none') {
      this.status = { provider: 'none', state: 'stopped' };
      return;
    }
    const bin = await this.locateBinary();
    if (!bin) {
      this.status = { provider, state: 'stopped' };
      return;
    }
    try {
      await this.exec(bin, ['serve', `--https=${HTTPS_PORT}`, 'off']);
      this.log.info('[webui] tailscale serve cleared');
    } catch (err) {
      // Best-effort teardown: a stale rule is preferable to a crash on stop.
      this.log.warn(`[webui] tailscale serve off failed: ${guidanceFromError(err)}`);
    }
    this.status = { provider, state: 'stopped' };
  }

  /**
   * Read the machine's public HTTPS URL from `tailscale status --json`
   * (Self.DNSName is the fully-qualified `<machine>.<tailnet>.ts.net.` name).
   * Returns undefined if the CLI call fails or the field is absent — the serve
   * rule is still up; we just couldn't surface a clickable URL.
   */
  private async resolveUrl(bin: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec(bin, ['status', '--json']);
      const parsed = JSON.parse(stdout) as { Self?: { DNSName?: string } };
      const dnsName = parsed.Self?.DNSName?.replace(/\.$/, '');
      if (dnsName) return `https://${dnsName}`;
    } catch (err) {
      this.log.warn(`[webui] could not resolve tailscale URL: ${guidanceFromError(err)}`);
    }
    return undefined;
  }
}
