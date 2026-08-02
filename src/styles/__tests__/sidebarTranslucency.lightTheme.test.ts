import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const themeColors = readFileSync(
  resolve(process.cwd(), 'src/styles/theme-colors.css'),
  'utf-8',
);

describe('light sidebar translucency', () => {
  it('keeps the WebView navigation surface transparent over native vibrancy', () => {
    const nativeMaterial = themeColors.match(
      /(:where\(:root\[data-sidebar-translucent="true"\]\[data-macos-vibrancy="true"\]\)[\s\S]*?\n\})/,
    )?.[1];

    expect(nativeMaterial).toContain('--shell-navigation-surface: transparent');
    expect(nativeMaterial).toContain('--sidebar-study-surface: transparent');
  });

  it('keeps the native vibrancy transparency chain available in light mode', () => {
    expect(themeColors).toContain(
      ':where(:root[data-sidebar-translucent="true"][data-macos-vibrancy="true"])',
    );
    expect(themeColors).toContain(
      ':root[data-sidebar-translucent="true"][data-macos-vibrancy="true"] #root',
    );
  });

  it('uses the same transparent native surface contract in dark mode', () => {
    const darkNativeMaterial = themeColors.match(
      /(:root\.dark\[data-sidebar-translucent="true"\]\[data-macos-vibrancy="true"\][\s\S]*?\n\})/,
    )?.[1];

    expect(darkNativeMaterial).toContain('--shell-navigation-surface: transparent');
    expect(darkNativeMaterial).toContain('--sidebar-study-surface: transparent');
  });

});
