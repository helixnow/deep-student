import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell two-column surface contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const shellStylesSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');

  it('lets the dedicated sidebar titlebar layer own the left surface', () => {
    expect(appSource).toContain("data-sidebar-visible={isDesktopSidebarSurfaceVisible ? 'true' : 'false'}");
    const visibleTitlebarBlock = shellStylesSource.match(
      /\.desktop-shell-titlebar\[data-sidebar-visible="true"\]\s*\{[^}]*\}/
    )?.[0] ?? '';

    expect(visibleTitlebarBlock).toContain('linear-gradient(');
    expect(visibleTitlebarBlock).toContain('transparent 0');
    expect(visibleTitlebarBlock).toContain('transparent var(--shell-navigation-width)');
    expect(visibleTitlebarBlock).not.toContain('var(--shell-navigation-surface)');
    expect(visibleTitlebarBlock).toContain('var(--shell-navigation-width)');
    expect(visibleTitlebarBlock).toContain('var(--shell-workspace-panel)');
    expect(shellStylesSource).toMatch(
      /\.desktop-shell-sidebar-titlebar-surface\s*\{[\s\S]*?background:\s*var\(--shell-navigation-surface\);/,
    );
  });

  it('keeps the header cells transparent so the shell reads as left column plus right column', () => {
    expect(shellStylesSource).toMatch(/\.desktop-shell-header-cell--nav\s*\{[\s\S]*background:\s*transparent;/);
    expect(shellStylesSource).toMatch(/\.desktop-shell-header-cell--workspace\s*\{[\s\S]*background:\s*transparent;/);
  });

  it('does not split the right column into separate rounded top and bottom cards', () => {
    const workspaceHeaderVisibleBlock = shellStylesSource.match(/\.desktop-shell-header-cell--workspace\[data-sidebar-visible="true"\]\s*\{[^}]*\}/)?.[0] ?? '';
    const workspaceVisibleBlock = shellStylesSource.match(/\.desktop-shell-workspace\[data-sidebar-visible="true"\]\s*\{[^}]*\}/)?.[0] ?? '';

    expect(workspaceHeaderVisibleBlock).not.toContain('border-top-left-radius');
    expect(workspaceVisibleBlock).not.toContain('border-bottom-left-radius');
  });
});
