/**
 * Tests for buildClaudeSubprocessEnv in agent/options.ts
 *
 * Guards the env contract for the spawned Claude Code CLI:
 * - CLAUDECODE stripped (nested-session detection)
 * - Bedrock routing vars stripped
 * - DISABLE_GROWTHBOOK pinned so remote feature gates cannot flip subagent
 *   semantics (blocking vs async Task launches) mid-flight (LEARNING-008)
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../src/agent/options.ts';

const TOUCHED_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'DISABLE_GROWTHBOOK',
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of TOUCHED_VARS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of TOUCHED_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('buildClaudeSubprocessEnv', () => {
  it('strips CLAUDECODE from the subprocess env', () => {
    process.env.CLAUDECODE = '1';
    const env = buildClaudeSubprocessEnv();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it('strips Claude-specific Bedrock routing vars', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'token';
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://bedrock.example';
    const env = buildClaudeSubprocessEnv();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
  });

  it('pins DISABLE_GROWTHBOOK=1 so subagent launches stay blocking by default', () => {
    delete process.env.DISABLE_GROWTHBOOK;
    const env = buildClaudeSubprocessEnv();
    expect(env.DISABLE_GROWTHBOOK).toBe('1');
  });

  it('respects a DISABLE_GROWTHBOOK value already present in the environment', () => {
    process.env.DISABLE_GROWTHBOOK = 'preset';
    const env = buildClaudeSubprocessEnv();
    expect(env.DISABLE_GROWTHBOOK).toBe('preset');
  });

  it('respects a DISABLE_GROWTHBOOK value passed via envOverrides', () => {
    delete process.env.DISABLE_GROWTHBOOK;
    const env = buildClaudeSubprocessEnv({ DISABLE_GROWTHBOOK: 'override' });
    expect(env.DISABLE_GROWTHBOOK).toBe('override');
  });
});
