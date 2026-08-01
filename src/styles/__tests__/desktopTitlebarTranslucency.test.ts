import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const shellStylesSource = readFileSync(
  resolve(process.cwd(), 'src/shared/styles/app.css'),
  'utf8',
);
const themeStylesSource = readFileSync(
  resolve(process.cwd(), 'src/styles/theme-colors.css'),
  'utf8',
);
const sidebarTranslucencySource = readFileSync(
  resolve(process.cwd(), 'src/utils/sidebarTranslucency.ts'),
  'utf8',
);

describe('desktop titlebar navigation material', () => {
  it('routes the sidebar titlebar surface through the same navigation glass layer as the sidebar', () => {
    expect(appSource).not.toContain('desktop-shell-sidebar-titlebar-surface');
  });

  it('uses one continuous navigation surface across the titlebar and sidebar', () => {
    const visibleTitlebarBlock = shellStylesSource.match(
      /\.desktop-shell-titlebar\[data-sidebar-visible="true"\]\s*\{[^}]*\}/,
    )?.[0] ?? '';

    expect(visibleTitlebarBlock).toContain('var(--shell-navigation-surface) 0');
    expect(visibleTitlebarBlock).toContain('var(--shell-navigation-surface) var(--shell-navigation-width)');
  });

  it('only clears the legacy titlebar material and never re-enables it', () => {
    expect(sidebarTranslucencySource).toContain('不再额外挂载原生');
    expect(sidebarTranslucencySource).toContain('clearNativeTitlebarSidebarMaterial');
    expect(sidebarTranslucencySource).toContain('enabled: false');
    expect(sidebarTranslucencySource).not.toContain('shouldUseNativeTitlebarMaterial');
    expect(themeStylesSource).not.toContain('hsl(var(--nav-background) / 0.82)');
  });
});
