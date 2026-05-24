import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell migration contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
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

  it('routes desktop shell surfaces through semantic tokens (flat-white architecture)', () => {
    // 2026-05 方向 C：所有 shell 表面合流到 --background，侧边栏是唯一非白区域。
    expect(themeSource).toContain('--shell-backdrop');
    expect(themeSource).toContain('--shell-titlebar-surface');
    expect(themeSource).toContain('--shell-navigation-surface');
    expect(themeSource).toContain('--shell-workspace-surface');
    expect(themeSource).toContain('--shell-panel: hsl(var(--background));');
    expect(themeSource).toContain('--shell-panel-strong: hsl(var(--background));');
    expect(themeSource).toContain('--shell-backdrop: hsl(var(--background));');
    expect(themeSource).toContain('--shell-titlebar: hsl(var(--background));');
    expect(themeSource).toContain('--shell-nav-item-hover');
    expect(themeSource).toContain('--shell-nav-item-active');
  });

  it('treats window controls and cached view layers as shell primitives', () => {
    expect(windowControlsSource).toContain('data-shell-window-controls');
    expect(rendererSource).toContain('data-view-layer-shell');
  });

  it('keeps the desktop workspace header cell on the same shell panel color as the content area below it', () => {
    expect(appCssSource).toContain('.desktop-shell-header-cell--workspace');
    expect(appCssSource).toContain('background: var(--shell-workspace-panel);');
    expect(appCssSource).not.toContain('.desktop-shell-header-cell--workspace {\n  background: var(--shell-workspace-surface);');
    expect(appCssSource).not.toContain('box-shadow: inset 14px 0 22px -24px hsl(var(--foreground) / 0.32);');
  });

  it('lets the main chat pane sit flush under the desktop header without a top rim shadow', () => {
    expect(appCssSource).toContain('.study-shell-pane--flush-top');
    expect(appCssSource).toContain('border-top: 0;');
    expect(appCssSource).toContain('box-shadow: none;');
    expect(appCssSource).toContain('.study-shell-toolbar--seamless');
    expect(appCssSource).toContain('border-bottom: 0;');
  });
});
