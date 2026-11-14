// @vitest-environment node
/**
 * Host 状态的读模型：降级原因的解析（Host 错误码 + W32 的 CONSENT_REQUIRED）、安全模式开关与订阅。
 */
import { describe, expect, it, vi } from 'vitest';
import { CONSENT_REQUIRED, parseHostDegradedReason, UiHostStatusService } from '../services/host-status';

describe('parseHostDegradedReason', () => {
  it('keeps Host load codes and their detail', () => {
    expect(parseHostDegradedReason('CONFIG_INVALID: theme must be a string')).toEqual({
      code: 'CONFIG_INVALID', detail: 'theme must be a string', consentRequired: false,
    });
    expect(parseHostDegradedReason('UNSUPPORTED_ON_PLATFORM: plugin "x" supports desktop, not mobile')).toEqual({
      code: 'UNSUPPORTED_ON_PLATFORM', detail: 'plugin "x" supports desktop, not mobile', consentRequired: false,
    });
  });

  it('recognises the formal Host CONSENT_REQUIRED prefix and preserves its detail', () => {
    expect(CONSENT_REQUIRED).toBe('CONSENT_REQUIRED');
    expect(parseHostDegradedReason('CONSENT_REQUIRED: consent record missing')).toEqual({
      code: 'CONSENT_REQUIRED', detail: 'consent record missing', consentRequired: true,
    });
    expect(parseHostDegradedReason('CONSENT_REQUIRED: version or permissions changed')).toEqual({
      code: 'CONSENT_REQUIRED', detail: 'version or permissions changed', consentRequired: true,
    });
    expect(parseHostDegradedReason('CONSENT_REQUIRED: ')).toEqual({
      code: 'CONSENT_REQUIRED', detail: '', consentRequired: true,
    });
  });

  it.each(['SERVICE_MISSING', 'APPLY_FAILED'] as const)('parses %s without losing the original detail', code => {
    const detail = 'missing service "db"\n  original error: boom';
    expect(parseHostDegradedReason(`${code}: ${detail}`)).toEqual({ code, detail, consentRequired: false });
  });

  it('leaves legacy reasons (missing service, apply failure) as detail only', () => {
    expect(parseHostDegradedReason('missing service "db"')).toEqual({ detail: 'missing service "db"', consentRequired: false });
    expect(parseHostDegradedReason('boom')).toEqual({ detail: 'boom', consentRequired: false });
  });
});

describe('UiHostStatusService', () => {
  it('tracks safe mode from the v2 inventory and only notifies on changes', () => {
    const service = new UiHostStatusService();
    const listener = vi.fn();
    service.subscribe(listener);
    expect(service.safeMode).toBe(false);

    service.update({ plugins: [{ id: 'dstu.anki' }], degraded: [], safeMode: true });
    expect(service.safeMode).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    service.update({ plugins: [{ id: 'dstu.anki' }], degraded: [], safeMode: true });
    expect(listener).toHaveBeenCalledOnce();

    service.update({ plugins: [{ id: 'dstu.anki' }], degraded: [] });
    expect(service.safeMode).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('exposes parsed degradation and consent per host plugin', () => {
    const service = new UiHostStatusService();
    service.update({
      plugins: [{ id: 'dstu.anki' }, { id: 'acme.notes' }],
      degraded: [
        { id: 'acme.notes', reason: 'CONSENT_REQUIRED: consent record missing' },
        { id: 'dstu.anki', reason: 'CONFIG_INVALID: bad value' },
      ],
    });
    expect(service.state('acme.notes')).toBe('degraded');
    expect(service.consentRequired('acme.notes')).toBe(true);
    expect(service.degraded('acme.notes')).toEqual({ code: 'CONSENT_REQUIRED', detail: 'consent record missing', consentRequired: true });
    expect(service.consentRequired('dstu.anki')).toBe(false);
    expect(service.degraded('dstu.anki')?.code).toBe('CONFIG_INVALID');
    expect(service.degraded('missing.plugin')).toBeUndefined();
    expect(service.availability(['dstu.anki', 'acme.notes'])).toBe('degraded');
  });
});
