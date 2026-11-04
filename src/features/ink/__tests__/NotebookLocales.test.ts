import { describe, expect, it } from 'vitest';
import zh from '@/locales/zh-CN/ink.json';
import en from '@/locales/en-US/ink.json';

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof entry === 'string' ? [[path, entry]] : Object.entries(flatten(entry as Record<string, unknown>, path));
  }));
}

describe('notebook and full-screen workspace translations', () => {
  it('provides matching non-empty Chinese/English notebook keys and interpolation contracts', () => {
    const chinese = flatten(zh.notebook);
    const english = flatten(en.notebook);
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    for (const [key, value] of Object.entries(chinese)) {
      expect(value.trim()).not.toBe('');
      expect(english[key].trim()).not.toBe('');
      expect(english[key].match(/\{\{\w+\}\}/g) ?? []).toEqual(value.match(/\{\{\w+\}\}/g) ?? []);
    }
  });

  it('includes all four keys consumed by the real InkWorkspace without relying on Chinese defaults', () => {
    const expected = ['documentMismatch', 'unsupportedSchema', 'openFullscreen', 'exitBlocked'];
    expect(Object.keys(zh.workspace).sort()).toEqual([...expected].sort());
    expect(Object.keys(en.workspace).sort()).toEqual([...expected].sort());
    expect(zh.workspace.unsupportedSchema).toContain('{{version}}');
    expect(en.workspace.unsupportedSchema).toContain('{{version}}');
    for (const key of expected as Array<keyof typeof zh.workspace>) {
      expect(zh.workspace[key]).not.toBe(en.workspace[key]);
      expect(en.workspace[key]).toMatch(/[A-Za-z]/);
    }
  });
});
