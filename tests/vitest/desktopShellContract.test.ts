import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell migration contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
  const windowControlsSource = readFileSync(resolve(process.cwd(), 'src/components/WindowControls.tsx'), 'utf-8');
  const rendererSource = readFileSync(resolve(process.cwd(), 'src/app/components/ViewLayerRenderer.tsx'), 'utf-8');
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');

  it('defines window chrome, navigation, and workspace shell layers', () => {
    expect(appSource).toContain('data-shell-role="app-shell"');
    expect(appSource).toContain('data-shell-layer="window-chrome"');
    expect(appSource).toContain('data-shell-layer="workspace"');
    expect(sidebarSource).toContain('data-shell-layer="navigation"');
  });

  it('routes desktop shell surfaces through semantic tokens', () => {
    expect(themeSource).toContain('--shell-backdrop');
    expect(themeSource).toContain('--shell-titlebar-surface');
    expect(themeSource).toContain('--shell-navigation-surface');
    expect(themeSource).toContain('--shell-workspace-surface');
    expect(themeSource).toContain('--shell-nav-item-hover');
    expect(themeSource).toContain('--shell-nav-item-active');
  });

  it('treats window controls and cached view layers as shell primitives', () => {
    expect(windowControlsSource).toContain('data-shell-window-controls');
    expect(rendererSource).toContain('data-view-layer-shell');
  });
});
