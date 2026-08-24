import { describe, expect, it } from 'vitest';
import {
  isAllowedGenerativeUrl,
  isDangerousGenerativeUrl,
  sanitizeGenerativeUrl,
} from '@/features/generative-ui/utils/sanitizeGenerativeUrl';

describe('isDangerousGenerativeUrl', () => {
  it('blocks javascript / vbscript / file / data:text/html', () => {
    expect(isDangerousGenerativeUrl('javascript:alert(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('JAVASCRIPT:alert(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('javascript :alert(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('vbscript:msgbox(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('file:///etc/passwd')).toBe(true);
    expect(isDangerousGenerativeUrl('data:text/html,<h1>x</h1>')).toBe(true);
    expect(isDangerousGenerativeUrl('blob:https://example.com/1')).toBe(true);
  });

  it('blocks whitespace / control-character scheme obfuscation', () => {
    expect(isDangerousGenerativeUrl('java\tscript:alert(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('java\nscript:alert(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('\u0000javascript:alert(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('java script:alert(1)')).toBe(true);
    expect(isDangerousGenerativeUrl('  //evil.example')).toBe(true);
  });

  it('blocks executable svg data URIs', () => {
    expect(isDangerousGenerativeUrl('data:image/svg+xml,<svg></svg>')).toBe(true);
  });

  it('allows data:image/png', () => {
    expect(isDangerousGenerativeUrl('data:image/png;base64,abc')).toBe(false);
    expect(isAllowedGenerativeUrl('data:image/png;base64,abc')).toBe(true);
  });

  it('allows https/http/mailto/tel/#/relative', () => {
    expect(isAllowedGenerativeUrl('https://example.com')).toBe(true);
    expect(isAllowedGenerativeUrl('http://example.com')).toBe(true);
    expect(isAllowedGenerativeUrl('mailto:a@b.com')).toBe(true);
    expect(isAllowedGenerativeUrl('tel:+123')).toBe(true);
    expect(isAllowedGenerativeUrl('#section')).toBe(true);
    expect(isAllowedGenerativeUrl('/path/page')).toBe(true);
    expect(isAllowedGenerativeUrl('./rel')).toBe(true);
    expect(isAllowedGenerativeUrl('../up')).toBe(true);
    expect(isAllowedGenerativeUrl('')).toBe(true);
  });

  it('blocks leading //', () => {
    expect(isDangerousGenerativeUrl('//evil.example')).toBe(true);
    expect(isDangerousGenerativeUrl('  //evil.example')).toBe(true);
  });
});

describe('sanitizeGenerativeUrl', () => {
  it('returns empty string for dangerous URLs', () => {
    expect(sanitizeGenerativeUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeGenerativeUrl('vbscript:msgbox(1)')).toBe('');
    expect(sanitizeGenerativeUrl('file:///tmp')).toBe('');
    expect(sanitizeGenerativeUrl('data:text/html,x')).toBe('');
    expect(sanitizeGenerativeUrl('//evil')).toBe('');
  });

  it('returns the trimmed original for safe URLs', () => {
    expect(sanitizeGenerativeUrl('  https://ok.test  ')).toBe('https://ok.test');
    expect(sanitizeGenerativeUrl('data:image/png;base64,abc')).toBe(
      'data:image/png;base64,abc',
    );
  });
});
