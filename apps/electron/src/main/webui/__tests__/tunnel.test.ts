/**
 * fork(PLAN-022): TunnelManager unit tests.
 *
 * Exercises detect (present/absent), serve up, serve off, and error → guidance
 * paths through the injectable `exec` + `locateBinary` seams — no real tailscale
 * binary is invoked.
 */
import { describe, test, expect } from 'bun:test';
import { TunnelManager, type TunnelExec, type TunnelExecResult } from '../tunnel';

/** A fake exec that records calls and returns/throws per a route table. */
function makeFakeExec(routes: Array<{
  match: (file: string, args: string[]) => boolean;
  result?: TunnelExecResult;
  error?: unknown;
}>) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: TunnelExec = async (file, args) => {
    calls.push({ file, args });
    const route = routes.find((r) => r.match(file, args));
    if (!route) throw Object.assign(new Error('unmatched'), { code: 'ENOENT' });
    if (route.error) throw route.error;
    return route.result ?? { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const STATUS_JSON = JSON.stringify({ Self: { DNSName: 'my-machine.tail-scale.ts.net.' } });

describe('TunnelManager', () => {
  test('provider "none" is a no-op that reports stopped', async () => {
    const { exec, calls } = makeFakeExec([]);
    const mgr = new TunnelManager({ exec });
    const status = await mgr.up('none', 3848);
    expect(status).toEqual({ provider: 'none', state: 'stopped' });
    expect(calls.length).toBe(0);
  });

  test('CLI absent → unavailable status with guidance, no crash', async () => {
    const mgr = new TunnelManager({
      exec: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
      locateBinary: async () => null,
    });
    const status = await mgr.up('tailscale', 3848);
    expect(status.state).toBe('unavailable');
    expect(status.provider).toBe('tailscale');
    expect(status.message).toBe('tailscale-cli-missing');
  });

  test('serve up runs the right command and resolves the ts.net URL', async () => {
    const { exec, calls } = makeFakeExec([
      { match: (_f, a) => a[0] === 'serve' && a.includes('--bg'), result: { stdout: '', stderr: '' } },
      { match: (_f, a) => a[0] === 'status', result: { stdout: STATUS_JSON, stderr: '' } },
    ]);
    const mgr = new TunnelManager({ exec, locateBinary: async () => 'tailscale' });

    const status = await mgr.up('tailscale', 3848);

    expect(status.state).toBe('running');
    expect(status.url).toBe('https://my-machine.tail-scale.ts.net');

    // Exact serve command shape.
    const serveCall = calls.find((c) => c.args[0] === 'serve')!;
    expect(serveCall.args).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:3848']);
  });

  test('serve up succeeds even when status URL resolution fails', async () => {
    const { exec } = makeFakeExec([
      { match: (_f, a) => a[0] === 'serve', result: { stdout: '', stderr: '' } },
      { match: (_f, a) => a[0] === 'status', error: Object.assign(new Error('bad'), { stderr: 'daemon offline' }) },
    ]);
    const mgr = new TunnelManager({ exec, locateBinary: async () => 'tailscale' });
    const status = await mgr.up('tailscale', 3848);
    expect(status.state).toBe('running');
    expect(status.url).toBeUndefined();
  });

  test('serve failure surfaces stderr-derived guidance as error state', async () => {
    const { exec } = makeFakeExec([
      {
        match: (_f, a) => a[0] === 'serve',
        error: Object.assign(new Error('exit 1'), {
          stderr: 'HTTPS must be enabled for your tailnet\nsee https://tailscale.com',
        }),
      },
    ]);
    const mgr = new TunnelManager({ exec, locateBinary: async () => 'tailscale' });
    const status = await mgr.up('tailscale', 3848);
    expect(status.state).toBe('error');
    expect(status.message).toBe('HTTPS must be enabled for your tailnet');
  });

  test('down runs `serve --https=443 off` and reports stopped', async () => {
    const { exec, calls } = makeFakeExec([
      { match: (_f, a) => a[0] === 'serve', result: { stdout: '', stderr: '' } },
    ]);
    const mgr = new TunnelManager({ exec, locateBinary: async () => 'tailscale' });
    await mgr.down('tailscale');
    const offCall = calls.find((c) => c.args.includes('off'))!;
    expect(offCall.args).toEqual(['serve', '--https=443', 'off']);
    expect(mgr.getStatus()).toEqual({ provider: 'tailscale', state: 'stopped' });
  });

  test('down is best-effort: a failing off command does not throw', async () => {
    const { exec } = makeFakeExec([
      { match: (_f, a) => a[0] === 'serve', error: Object.assign(new Error('boom'), { stderr: 'nope' }) },
    ]);
    const mgr = new TunnelManager({ exec, locateBinary: async () => 'tailscale' });
    await mgr.down('tailscale'); // must resolve, not reject
    expect(mgr.getStatus().state).toBe('stopped');
  });

  test('down with provider "none" is a no-op', async () => {
    const { exec, calls } = makeFakeExec([]);
    const mgr = new TunnelManager({ exec });
    await mgr.down('none');
    expect(calls.length).toBe(0);
    expect(mgr.getStatus()).toEqual({ provider: 'none', state: 'stopped' });
  });

  test('default locateBinary probes PATH first via `version`', async () => {
    // A fake exec that answers `version` (PATH hit) — no macOS bundle needed.
    const { exec, calls } = makeFakeExec([
      { match: (f, a) => f === 'tailscale' && a[0] === 'version', result: { stdout: '1.99', stderr: '' } },
      { match: (_f, a) => a[0] === 'serve', result: { stdout: '', stderr: '' } },
      { match: (_f, a) => a[0] === 'status', result: { stdout: STATUS_JSON, stderr: '' } },
    ]);
    const mgr = new TunnelManager({ exec }); // no locateBinary → default
    const status = await mgr.up('tailscale', 3848);
    expect(status.state).toBe('running');
    // The version probe ran, and it used the PATH name.
    expect(calls[0]).toEqual({ file: 'tailscale', args: ['version'] });
  });
});
