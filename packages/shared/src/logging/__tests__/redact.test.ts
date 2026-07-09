import { describe, test, expect } from 'bun:test';
import { redactSecrets } from '../redact.ts';

describe('redactSecrets', () => {
  test('redacts Anthropic API keys', () => {
    const out = redactSecrets('using key sk-ant-api03-AbCdEf123456789 for request');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts fork trigger-server API keys (craft_sk_*)', () => {
    const out = redactSecrets('created craft_sk_a1b2c3d4e5f6g7h8 for workspace');
    expect(out).not.toContain('craft_sk_a1b2c3d4e5f6g7h8');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts bearer tokens but keeps the header shape', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out.toLowerCase()).toContain('bearer [redacted]');
  });

  test('redacts key=value and "key": "value" assignments', () => {
    expect(redactSecrets('apiKey=supersecret123')).toBe('apiKey=[REDACTED]');
    expect(redactSecrets('ANTHROPIC_API_KEY=abcd1234efgh')).toContain('[REDACTED]');
    expect(redactSecrets('"token": "abcd1234"')).not.toContain('abcd1234');
    expect(redactSecrets('password: hunter42x')).toBe('password: [REDACTED]');
    expect(redactSecrets('refresh_token=1//0abcdefghij')).not.toContain('0abcdefghij');
  });

  test('redacts GitHub, Slack, and AWS shapes', () => {
    expect(redactSecrets('ghp_abcdefghijklmnopqrst123456')).toBe('[REDACTED]');
    expect(redactSecrets('xoxb-1234567890-abcdefghijk')).toBe('[REDACTED]');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
  });

  test('leaves ordinary log lines untouched', () => {
    const lines = [
      '[trigger-server] running on 127.0.0.1:34871',
      'session created workspace=main tokens=1234',
      'autostart (enabled=true)',
      'revoked API key id=key_123 name=laptop',
      'GET /api/workspaces -> 401',
    ];
    for (const line of lines) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  test('is idempotent', () => {
    const once = redactSecrets('apiKey=supersecret123 and Bearer abcdefgh12345678');
    expect(redactSecrets(once)).toBe(once);
  });

  test('redacts multiple secrets in one line', () => {
    const out = redactSecrets('key sk-ant-api03-XyZ123456789 token=abcd1234 Bearer efgh5678ijkl9012');
    expect(out).not.toContain('sk-ant-api03-XyZ123456789');
    expect(out).not.toContain('abcd1234');
    expect(out).not.toContain('efgh5678ijkl9012');
  });
});
