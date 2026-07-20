import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const themeColors = readFileSync(
  resolve(process.cwd(), 'src/styles/theme-colors.css'),
  'utf-8',
);

describe('light sidebar translucency', () => {
  it('uses a low-strength tint over the native vibrancy material', () => {
    const nativeMaterial = themeColors.match(
      /(:where\(:root\[data-sidebar-translucent="true"\]\[data-macos-vibrancy="true"\]\)[\s\S]*?\n\})/,
    )?.[1];

    expect(nativeMaterial).toContain('hsl(var(--nav-background) / 0.88)');
  });

  it('keeps the native vibrancy transparency chain available in light mode', () => {
    expect(themeColors).toContain(
      ':where(:root[data-sidebar-translucent="true"][data-macos-vibrancy="true"])',
    );
    expect(themeColors).toContain(
      ':root[data-sidebar-translucent="true"][data-macos-vibrancy="true"] #root',
    );
  });

});
