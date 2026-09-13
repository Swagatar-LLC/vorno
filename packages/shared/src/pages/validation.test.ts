/**
 * Refresh-cron validation: the spec is checked on WRITE with the same engine
 * the scheduler matches with (croner), so a stored cron can no longer be
 * unparseable (silently never fires) or run more often than the policy floor
 * (subprocess spawn per run).
 */

import { describe, it, expect } from 'bun:test';
import {
  PAGE_REFRESH_MIN_INTERVAL_MS,
  PageActionDescriptorSchema,
  PageRefreshSpecSchema,
  validatePageConfig,
} from './validation.ts';

function refreshSpec(cron: string, timezone?: string) {
  return { cron, script: 'scripts/refresh.ts', grantId: 'grant_refresh', ...(timezone ? { timezone } : {}) };
}

describe('PageRefreshSpecSchema cron validation', () => {
  it('accepts real schedules at or above the 5-minute floor', () => {
    expect(PAGE_REFRESH_MIN_INTERVAL_MS).toBe(5 * 60 * 1000);
    for (const cron of ['*/5 * * * *', '*/15 * * * *', '0 * * * *', '0 9 * * 1-5', '30 6 1 * *']) {
      expect(PageRefreshSpecSchema.safeParse(refreshSpec(cron)).success).toBe(true);
    }
    expect(PageRefreshSpecSchema.safeParse(refreshSpec('0 9 * * *', 'Europe/Budapest')).success).toBe(true);
  });

  it('rejects unparseable expressions and invalid timezones', () => {
    for (const cron of ['not a cron', '61 * * * *', 'a b c d e']) {
      const result = PageRefreshSpecSchema.safeParse(refreshSpec(cron));
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('Invalid cron expression');
    }
    const badTz = PageRefreshSpecSchema.safeParse(refreshSpec('0 9 * * *', 'Mars/Olympus-Mons'));
    expect(badTz.success).toBe(false);
  });

  it('rejects expressions that never fire instead of storing a silent no-op', () => {
    const result = PageRefreshSpecSchema.safeParse(refreshSpec('0 0 30 2 *')); // Feb 30
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toContain('never fires');
  });

  it('rejects schedules below the minimum interval, including bursty and seconds-granularity patterns', () => {
    for (const cron of [
      '* * * * *', // every minute
      '*/2 * * * *', // every 2 minutes
      '0,1 0 * * *', // daily burst: two runs 60s apart
      '*/30 * * * * *', // 6-field: every 30 seconds
    ]) {
      const result = PageRefreshSpecSchema.safeParse(refreshSpec(cron));
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('too frequently');
    }
  });

  it('requires a declared grant before a refresh can persist', () => {
    const { grantId: _grantId, ...withoutGrant } = refreshSpec('*/10 * * * *');
    expect(PageRefreshSpecSchema.safeParse(withoutGrant).success).toBe(false);
  });

  it('surfaces cron issues through validatePageConfig at refresh.cron', () => {
    const config = {
      schemaVersion: 1,
      id: 'page_1',
      slug: 'dash',
      name: 'Dash',
      kind: 'live',
      createdAt: 1,
      updatedAt: 1,
      refresh: refreshSpec('* * * * *'),
    };
    const result = validatePageConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'refresh.cron')).toBe(true);

    expect(validatePageConfig({ ...config, refresh: refreshSpec('*/10 * * * *') }).valid).toBe(true);
  });
});

describe('script path bounds in action descriptors', () => {
  const scriptAction = (script: string) => ({ kind: 'script' as const, script });

  it('accepts a realistic path and rejects one past the cap', () => {
    // Every sibling descriptor field was already capped; this one was the way to
    // push unbounded text into a host consent dialog.
    const longest = `scripts/${'a'.repeat(500 - 'scripts/'.length)}`;
    expect(longest).toHaveLength(500);
    expect(PageActionDescriptorSchema.safeParse(scriptAction('scripts/refresh.ts')).success).toBe(true);
    expect(PageActionDescriptorSchema.safeParse(scriptAction(longest)).success).toBe(true);

    const tooLong = PageActionDescriptorSchema.safeParse(scriptAction(`${longest}b`));
    expect(tooLong.success).toBe(false);
    expect(tooLong.error!.issues.some(issue => issue.message.includes('cannot exceed 500 characters'))).toBe(true);

    // Far past the cap, which is the shape that actually shows up in abuse.
    expect(PageActionDescriptorSchema.safeParse(scriptAction('x'.repeat(50_000))).success).toBe(false);
  });

  it('applies the same bound to refresh specs, which share the schema', () => {
    expect(PageRefreshSpecSchema.safeParse({
      cron: '*/10 * * * *', grantId: 'grant_refresh', script: 'x'.repeat(501),
    }).success).toBe(false);
  });

  it('still rejects escapes and absolute paths within the cap', () => {
    for (const script of ['../outside.ts', '/etc/passwd', 'C:\\windows\\x.ts', 'a/../../b.ts']) {
      expect(PageActionDescriptorSchema.safeParse(scriptAction(script)).success).toBe(false);
    }
  });
});

/**
 * SUV-0064 — the session-callback descriptor.
 *
 * This schema is the last gate before a privileged capability is persisted, and
 * the one place a page's request is compared against a shape rather than
 * against state. Everything state-dependent — does this session exist, does
 * this workspace own it — is answered server-side and is deliberately not here.
 */
describe('PageActionDescriptorSchema session arm', () => {
  const valid = { kind: 'session', sessionId: 'sess_target', message: 'Refresh the numbers.' };

  it('accepts a pinned target and body', () => {
    expect(PageActionDescriptorSchema.safeParse(valid).success).toBe(true);
  });

  it('requires both fields — neither is optional', () => {
    // A descriptor missing either one is not a capability: a target with no
    // body has nothing to send, and a body with no target has nowhere to go.
    expect(PageActionDescriptorSchema.safeParse({ kind: 'session', sessionId: 'sess_target' }).success).toBe(false);
    expect(PageActionDescriptorSchema.safeParse({ kind: 'session', message: 'hi' }).success).toBe(false);
    expect(PageActionDescriptorSchema.safeParse({ kind: 'session', sessionId: '', message: 'hi' }).success).toBe(false);
    expect(PageActionDescriptorSchema.safeParse({ kind: 'session', sessionId: 'sess_target', message: '' }).success).toBe(false);
  });

  it('rejects a smuggled action, status, or target selector rather than stripping it', () => {
    // Stripping would hand back an approved send-message grant for a request
    // that asked for something else, with no way for the page to tell. This arm
    // is `.strict()` precisely so that cannot happen.
    for (const extra of [
      { action: 'set-status' },
      { action: 'set-labels' },
      { status: 'done' },
      { allowClosed: true },
      { target: { label: 'anything' } },
      { sessionId: 'sess_target', target: { id: 'sess_other' } },
    ]) {
      expect(PageActionDescriptorSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it('bounds the pinned body at the length a human can actually read in a sheet', () => {
    const longest = 'x'.repeat(1000);
    expect(PageActionDescriptorSchema.safeParse({ ...valid, message: longest }).success).toBe(true);

    const tooLong = PageActionDescriptorSchema.safeParse({ ...valid, message: `${longest}y` });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error!.issues.some(issue => issue.message.includes('cannot exceed 1000 characters'))).toBe(true);

    // Far past the cap is the shape abuse actually takes — a body nobody reads
    // is a body nobody consented to.
    expect(PageActionDescriptorSchema.safeParse({ ...valid, message: 'x'.repeat(200_000) }).success).toBe(false);
  });

  it('bounds the target id, which also reaches host chrome', () => {
    expect(PageActionDescriptorSchema.safeParse({ ...valid, sessionId: 'x'.repeat(128) }).success).toBe(true);
    expect(PageActionDescriptorSchema.safeParse({ ...valid, sessionId: 'x'.repeat(129) }).success).toBe(false);
  });

  it('rejects non-string fields instead of coercing them', () => {
    for (const bad of [42, null, {}, ['sess_target'], true]) {
      expect(PageActionDescriptorSchema.safeParse({ ...valid, sessionId: bad }).success).toBe(false);
      expect(PageActionDescriptorSchema.safeParse({ ...valid, message: bad }).success).toBe(false);
    }
  });
});
