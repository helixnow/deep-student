import { expect, it } from 'vitest';
import { sanitize_unicode } from '../api.ts';
it('test_sanitize_zero_width', () => {
  expect(sanitize_unicode('a\u200bb')).toBe('ab'); expect(sanitize_unicode('test\ufeff')).toBe('test'); expect(sanitize_unicode('\u200cabc\u200d')).toBe('abc');
});
it('test_sanitize_fullwidth', () => {
  expect(sanitize_unicode('path／to／file')).toBe('path/to/file'); expect(sanitize_unicode('file．txt')).toBe('file.txt'); expect(sanitize_unicode('C：＼Users')).toBe('C:\\Users');
});
it('test_sanitize_bidi', () => { expect(sanitize_unicode('a\u202eb')).toBe('ab'); expect(sanitize_unicode('\u202atest\u202c')).toBe('test'); });
it('test_sanitize_isolation', () => { expect(sanitize_unicode('a\u2066b\u2069c')).toBe('abc'); });
it('test_sanitize_invisible_operators', () => { expect(sanitize_unicode('a\u2061b\u2062c')).toBe('abc'); });
it('test_sanitize_normal_text', () => { for (const value of ['hello world', '文件名.txt', '/path/to/file']) expect(sanitize_unicode(value)).toBe(value); });
