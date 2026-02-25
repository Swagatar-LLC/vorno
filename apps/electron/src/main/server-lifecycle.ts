import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { app } from 'electron';

let serverProcess: ChildProcess | null = null;

/**
 * Get the path to the server entry point.
 */
function getServerEntryPath(): string {
  const basePath = app.isPackaged ? app.getAppPath() : process.cwd();
  // Try monorepo structure first
  let serverPath = join(basePath, 'apps', 'server', 'src', 'index.ts');
  if (!existsSync(serverPath) && !app.isPackaged) {
    // Try from apps/electron (monorepo root is two levels up)
    const monorepoRoot = join(basePath, '..', '..');
    serverPath = join(monorepoRoot, 'apps', 'server', 'src', 'index.ts');
  }
  return serverPath;
}

/**
 * Get the bun executable path.
 */
function getBunExecutable(): string {
  if (app.isPackaged) {
    const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const bunBasePath = process.platform === 'win32' ? process.resourcesPath : app.getAppPath();
    return join(bunBasePath, 'vendor', 'bun', bunBinary);
  }
  return 'bun';
}

/**
 * Check if the server process is currently running.
 */
export function isServerRunning(): boolean {
  return serverProcess !== null && !serverProcess.killed;
}

/**
 * Start the HTTP server as a child process.
 */
export function startServer(): { success: boolean; error?: string } {
  if (isServerRunning()) {
    return { success: true }; // Already running
  }

  const serverPath = getServerEntryPath();
  if (!existsSync(serverPath)) {
    return { success: false, error: `Server entry point not found: ${serverPath}` };
  }

  const bunExe = getBunExecutable();

  try {
    serverProcess = spawn(bunExe, ['run', serverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Inherit auth environment variables from the Electron process
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      },
      detached: false,
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[server] ${data.toString().trim()}`);
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[server] ${data.toString().trim()}`);
    });

    serverProcess.on('exit', (code, signal) => {
      console.log(`[server] Process exited (code: ${code}, signal: ${signal})`);
      serverProcess = null;
    });

    serverProcess.on('error', (err) => {
      console.error(`[server] Process error:`, err.message);
      serverProcess = null;
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start server';
    return { success: false, error: message };
  }
}

/**
 * Stop the HTTP server child process gracefully.
 */
export async function stopServer(): Promise<{ success: boolean; error?: string }> {
  if (!serverProcess || serverProcess.killed) {
    serverProcess = null;
    return { success: true };
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Force kill if graceful shutdown takes too long
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
      serverProcess = null;
      resolve({ success: true });
    }, 5000);

    serverProcess!.on('exit', () => {
      clearTimeout(timeout);
      serverProcess = null;
      resolve({ success: true });
    });

    // Send SIGTERM for graceful shutdown
    serverProcess!.kill('SIGTERM');
  });
}

/**
 * Get server process info.
 */
export function getServerInfo(): { running: boolean; pid?: number } {
  if (isServerRunning() && serverProcess) {
    return { running: true, pid: serverProcess.pid };
  }
  return { running: false };
}

/**
 * Cleanup on app quit.
 */
export async function cleanupServer(): Promise<void> {
  if (isServerRunning()) {
    await stopServer();
  }
}
