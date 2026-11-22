import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeBundleNamespace, toBundles } from '../toBundles';
import zhCNBundles from '../zh-CN';
import enUSBundles from '../en-US';

const listLocaleNamespaces = (locale: 'zh-CN' | 'en-US'): string[] =>
  readdirSync(resolve(process.cwd(), 'src/locales', locale))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();

const getNested = (obj: Record<string, unknown> | undefined, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object' && segment in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, obj);

describe('locales/bundles normalization & mobile/demo completeness', () => {
  it('strips every Vite glob path shape to a clean i18next namespace', () => {
    // mobile/vite.app.ts produces "../zh-CN/<ns>.json" (no "/locales/" segment!)
    expect(normalizeBundleNamespace('../zh-CN/settings.json')).toBe('settings');
    expect(normalizeBundleNamespace('../en-US/chatV2.json')).toBe('chatV2');
    // root Vite / demo config produces "../../locales/zh-CN/<ns>.json"
    expect(normalizeBundleNamespace('../../locales/zh-CN/learningHub.json')).toBe('learningHub');
    expect(normalizeBundleNamespace('./locales/en-US/common.json')).toBe('common');
    // Windows backslash paths & future BCP-47 locales
    expect(normalizeBundleNamespace('..\\zh-CN\\settings.json')).toBe('settings');
    expect(normalizeBundleNamespace('../ja-JP/settings.json')).toBe('settings');
    expect(normalizeBundleNamespace('../zh-Hans/settings.json')).toBe('settings');
    // Nested namespaces & bare filenames
    expect(normalizeBundleNamespace('/src/locales/zh-CN/nested/panel.json')).toBe('nested/panel');
    expect(normalizeBundleNamespace('settings.json')).toBe('settings');
  });

  it('toBundles maps mobile-style relative glob keys without leaking path prefixes', () => {
    const result = toBundles({
      '../zh-CN/chatV2.json': { input_bar: { placeholder: '请输入问题...' } },
      '../zh-CN/settings.json': { title: '系统设置' },
      '../zh-CN/learningHub.json': { apps: { allFiles: '全部文件' } },
    });

    expect(Object.keys(result).sort()).toEqual(['chatV2', 'learningHub', 'settings']);
    expect(result.settings).toEqual({ title: '系统设置' });
  });

  it.each([
    ['zh-CN', zhCNBundles],
    ['en-US', enUSBundles],
  ] as const)('%s bundle registers every locale JSON namespace with no path-prefix leaks', (locale, bundles) => {
    const expected = listLocaleNamespaces(locale);
    const actual = Object.keys(bundles).sort();

    expect(actual).toEqual(expected);
    for (const ns of actual) {
      expect(ns).not.toContain('..');
      expect(ns).not.toContain('/');
      expect(ns).not.toContain('\\');
      expect(ns).not.toMatch(/\.json$/);
    }

    // Critical keys shown across mobile Chat, Settings, and Learning Hub screens
    expect(typeof getNested(bundles.analysis, 'input_bar.placeholder')).toBe('string');
    expect(typeof getNested(bundles.chatV2, 'messageList.empty.primaryAction')).toBe('string');
    expect(typeof getNested(bundles.settings, 'title')).toBe('string');
    expect(typeof getNested(bundles.settings, 'tabs.about')).toBe('string');
    expect(typeof getNested(bundles.learningHub, 'finder.quickAccess.materials')).toBe('string');
    expect(typeof getNested(bundles.learningHub, 'apps.allFiles')).toBe('string');
  });
});
