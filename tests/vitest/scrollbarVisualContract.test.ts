import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getHtmlTheme, getHtmlThemeServerSnapshot } from '@/lib/scroll-theme';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
const nativeScrollbarSource = readFileSync(
  resolve(process.cwd(), 'src/styles/native-feel/scrollbars.css'),
  'utf-8',
);
const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
const scrollThemeSource = readFileSync(resolve(process.cwd(), 'src/lib/scroll-theme.ts'), 'utf-8');

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('scrollbar visual contract', () => {
  it('uses a light handle on dark app surfaces and a dark handle on light app surfaces', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(getHtmlTheme()).toBe('os-theme-light');

    document.documentElement.dataset.theme = 'light';
    expect(getHtmlTheme()).toBe('os-theme-dark');
    expect(getHtmlThemeServerSnapshot()).toBe('os-theme-dark');
    expect(scrollThemeSource).toContain('if (typeof document === "undefined") return "os-theme-dark";');
  });

  it('loads the library baseline before project scrollbar overrides', () => {
    const libraryImport = appSource.indexOf("import 'overlayscrollbars/overlayscrollbars.css';");
    const projectStylesImport = appSource.indexOf("import './styles/tailwind.css';");

    expect(libraryImport).toBeGreaterThanOrEqual(0);
    expect(projectStylesImport).toBeGreaterThan(libraryImport);
  });

  it('defines distinct default, hover, and active colors for both themes', () => {
    expect(themeSource).toContain('--scrollbar-thumb-active:');
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--scrollbar-thumb:/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--scrollbar-thumb-hover:/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--scrollbar-thumb-active:/);
  });

  it('keeps a generous hit area with a restrained four-pixel visual thumb', () => {
    expect(nativeScrollbarSource).toContain('width: 10px;');
    expect(nativeScrollbarSource).toContain('height: 10px;');
    expect(nativeScrollbarSource).toContain('border: 3px solid transparent;');
    expect(nativeScrollbarSource).toContain('background-color: var(--scrollbar-thumb-active);');
  });

  it('bridges OverlayScrollbars states to project tokens and quiets touch-only devices', () => {
    expect(nativeScrollbarSource).toMatch(
      /\.os-theme-dark,\s*\.os-theme-light\s*\{[\s\S]*--os-handle-bg:\s*var\(--scrollbar-thumb\);/,
    );
    expect(nativeScrollbarSource).toContain('--os-handle-bg-active: var(--scrollbar-thumb-active);');
    expect(nativeScrollbarSource).toContain('@media (hover: none) and (pointer: coarse)');
  });
});
