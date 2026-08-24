import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom 环境下 import.meta.url 不是 file: scheme，new URL 相对定位会抛
// "The URL must be of scheme file"；与其他 source 契约测试一致改用 cwd 解析。
const source = readFileSync(resolve(process.cwd(), 'src/i18n.ts'), 'utf8');

describe('i18n lazy-loading source contract', () => {
  it('refreshes React bindings when resource bundles are added', () => {
    expect(source).toMatch(
      /react:\s*\{[\s\S]*?useSuspense:\s*false,\s*bindI18nStore:\s*['"]added['"]/,
    );
  });

  it('deduplicates concurrent locale loads without making failures permanent', () => {
    expect(source).not.toContain('LOADED_LOCALES');
    expect(source).toContain(
      'const DEFERRED_LOCALE_STATES = new Map<SupportedLanguage, DeferredLocaleState>();',
    );
    expect(source).toContain('if (state.inFlight) return state.inFlight;');
    expect(source).toContain('if (state.loadedNamespaces.has(ns)) continue;');
    expect(source).toContain('const batch = Promise.allSettled(tasks).then(() => undefined);');
    expect(source).toContain('state.inFlight = null;');

    const addBundleIndex = source.indexOf('i18n.addResourceBundle(');
    const markLoadedIndex = source.indexOf('state.loadedNamespaces.add(ns);');
    expect(addBundleIndex).toBeGreaterThan(-1);
    expect(markLoadedIndex).toBeGreaterThan(addBundleIndex);
  });

  it('subscribes to language changes before bootstrap loading begins', () => {
    const listenerIndex = source.indexOf("i18n.on('languageChanged'");
    const bootstrapIndex = source.indexOf('void (async () => {');

    expect(listenerIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(listenerIndex);
    expect(source).toContain('requestDeferredNamespaces(normalized);');
    expect(source).toContain('const activeLang = normalizeSupportedLanguage(i18n.language);');
    expect(source).toContain('await loadDeferredNamespaces(activeLang);');
  });
});
