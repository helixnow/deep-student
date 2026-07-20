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

describe('desktop titlebar navigation material', () => {
  it('routes the sidebar titlebar surface through the same navigation glass layer as the sidebar', () => {
    expect(appSource).toMatch(
      /<div\s+aria-hidden="true"\s+data-shell-surface="navigation"\s+className="desktop-shell-sidebar-titlebar-surface"\s*\/>/,
    );
  });

  it('keeps the titlebar parent transparent behind the dedicated navigation glass layer', () => {
    const visibleTitlebarBlock = shellStylesSource.match(
      /\.desktop-shell-titlebar\[data-sidebar-visible="true"\]\s*\{[^}]*\}/,
    )?.[0] ?? '';

    expect(visibleTitlebarBlock).toContain('transparent 0');
    expect(visibleTitlebarBlock).toContain('transparent var(--shell-navigation-width)');
    expect(visibleTitlebarBlock).not.toContain('var(--shell-navigation-surface)');
  });

  it('compensates the macOS overlay titlebar tint for its darker native backdrop', () => {
    expect(themeStylesSource).toMatch(
      /:root\.dark\[data-sidebar-translucent="true"\]\[data-macos-vibrancy="true"\][\s\S]*?\.desktop-shell-sidebar-titlebar-surface\s*\{[^}]*background:\s*hsl\(var\(--nav-background\)\s*\/\s*0\.82\)/,
    );
    expect(themeStylesSource).toMatch(
      /:root\.dark\[data-sidebar-translucent="true"\]\[data-macos-vibrancy="true"\][\s\S]*?\.desktop-shell-titlebar\[data-sidebar-visible="true"\]\s*\{[^}]*hsl\(var\(--nav-background\)\s*\/\s*0\.82\)/,
    );
  });
});
