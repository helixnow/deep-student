import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ui shell interaction state contract', () => {
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const windowControlsSource = readFileSync(resolve(process.cwd(), 'src/components/WindowControls.tsx'), 'utf-8');
  const mobileHeaderSource = readFileSync(resolve(process.cwd(), 'src/components/layout/UnifiedMobileHeader.tsx'), 'utf-8');
  const tabBarSource = readFileSync(resolve(process.cwd(), 'src/components/layout/BottomTabBar.tsx'), 'utf-8');
  const unifiedSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/UnifiedSidebar.tsx'), 'utf-8');

  it('keeps explicit desktop shell interaction hooks for window controls and selected sidebar rows', () => {
    const sidebarSelectedBlock = appCssSource.match(/\.sidebar-shell-item\[data-selected="true"\]\s*\{[^}]+\}/)?.[0] ?? '';

    expect(windowControlsSource).toContain('data-shell-window-controls');
    expect(windowControlsSource).toContain('data-shell-window-button="minimize"');
    expect(windowControlsSource).toContain('data-shell-window-button="maximize"');
    expect(windowControlsSource).toContain('data-shell-window-button="close"');
    expect(appCssSource).toContain('.sidebar-shell-item[data-selected="true"]');
    expect(appCssSource).toMatch(/\.sidebar-shell-item:hover,[\s\S]*background:\s*var\(--interactive-hover\);/);
    expect(appCssSource).toMatch(/\.sidebar-shell-item\[data-selected="true"\]\s*\{[\s\S]*background:\s*var\(--interactive-selected\);/);
    expect(sidebarSelectedBlock).not.toContain('border-color');
    expect(sidebarSelectedBlock).not.toContain('box-shadow');
  });

  it('keeps mobile shell components on accessible header and tab semantics', () => {
    expect(mobileHeaderSource).toContain('data-mobile-shell="header"');
    expect(mobileHeaderSource).toContain("aria-label={t('common:mobile_header.back')}");
    expect(tabBarSource).toContain('data-mobile-shell="tabbar"');
    expect(tabBarSource).toContain('role="tablist"');
    expect(tabBarSource).toContain('aria-selected={isActive}');
  });

  it('keeps unified sidebar search, nav, and utility actions on shared shell primitives', () => {
    expect(unifiedSidebarSource).toContain('sidebar-shell-search');
    expect(unifiedSidebarSource).toContain('sidebar-shell-item');
    expect(unifiedSidebarSource).toContain('variant="nav"');
    expect(unifiedSidebarSource).toContain('variant="utility"');
  });
});
