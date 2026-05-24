import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AppMenu checked indicator contract', () => {
  const styleSource = readFileSync(resolve(process.cwd(), 'src/components/ui/app-menu/AppMenu.css'), 'utf-8');
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
  const componentSource = readFileSync(resolve(process.cwd(), 'src/components/ui/app-menu/AppMenu.tsx'), 'utf-8');

  it('keeps checked indicators on the menu row text color instead of primary blue', () => {
    const checkRule = styleSource.match(/\.app-menu-item-check\s*\{[^}]+\}/)?.[0] ?? '';

    // 新架构：--app-menu-row-foreground 通过 --menu-shell-foreground 解析，
    // 后者在 theme-colors.css 链接到 --composer-panel-foreground → --text-primary。
    expect(styleSource).toMatch(/--app-menu-row-foreground:\s*var\(--menu-shell-foreground\);/);
    expect(themeSource).toMatch(/--menu-shell-foreground:\s*var\(--composer-panel-foreground\);/);
    expect(themeSource).toMatch(/--composer-panel-foreground:\s*var\(--text-primary\);/);

    expect(styleSource).toMatch(/\.app-menu-item-checked\s*\{[\s\S]*color:\s*var\(--app-menu-row-foreground\);/);
    expect(checkRule).toMatch(/color:\s*currentColor;/);
    expect(checkRule).not.toMatch(/color:\s*hsl\(var\(--primary\)\);/);
  });

  it('renders checked indicators as right-side row accessories', () => {
    const contentIndex = componentSource.indexOf('<span className="app-menu-item-content">{children}</span>');
    const checkIndex = componentSource.indexOf('<span className="app-menu-item-check">');

    expect(contentIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeGreaterThan(contentIndex);
  });

  it('uses the Phosphor check icon for checked menu items', () => {
    expect(componentSource).toMatch(/import\s*\{\s*Check\s+as\s+PhosphorCheck\s*\}\s*from '@phosphor-icons\/react';/);
    expect(componentSource).toContain('<PhosphorCheck className="w-4 h-4" weight="bold" />');
    expect(componentSource).not.toMatch(/import\s*\{[^}]*\bCheck\b[^}]*\}\s*from 'lucide-react';/);
  });
});
