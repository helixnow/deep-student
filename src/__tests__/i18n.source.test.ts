import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../i18n.ts', import.meta.url), 'utf8');

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
