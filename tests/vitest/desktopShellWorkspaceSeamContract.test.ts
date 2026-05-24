import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop shell workspace seam contract', () => {
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const deepStudentCssSource = readFileSync(resolve(process.cwd(), 'src/DeepStudent.css'), 'utf-8');
  const themeColorsSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');

  it('does not draw a dark-mode content-body border at the navigation/workspace join', () => {
    const darkContentBodyBlock = appCssSource.match(/\.dark\s+\.content-body\s*\{([\s\S]*?)\n\}/);

    expect(darkContentBodyBlock?.[1]).toContain('border-left: none;');
    expect(darkContentBodyBlock?.[1]).not.toMatch(/border-left:\s*1px\s+solid/);
  });

  it('keeps the dark navigation surface on the same base color as the workspace panel', () => {
    const darkThemeBlock = themeColorsSource.match(/:root\.dark\s*\{([\s\S]*?)\n\}/);

    expect(darkThemeBlock?.[1]).toContain('--sidebar: hsl(var(--background));');
    expect(darkThemeBlock?.[1]).not.toContain('--sidebar: #000000;');
  });

  it('does not let legacy navigation shell styles draw a right divider', () => {
    const navigationLayerBlock = deepStudentCssSource.match(/\[data-shell-layer="navigation"\]\s*\{([\s\S]*?)\n\}/);

    expect(navigationLayerBlock?.[1]).toContain('border-right: 0;');
    expect(navigationLayerBlock?.[1]).not.toMatch(/border-right:\s*1px\s+solid/);
  });

  it('uses a soft dark-mode navigation depth overlay instead of a hard seam', () => {
    const navigationLayerBlock = deepStudentCssSource.match(/\[data-shell-layer="navigation"\]\s*\{([\s\S]*?)\n\}/);
    const navigationDepthBlock = deepStudentCssSource.match(/\[data-shell-layer="navigation"\]::before\s*\{([\s\S]*?)\n\}/);
    const darkThemeBlock = themeColorsSource.match(/:root\.dark\s*\{([\s\S]*?)\n\}/);

    expect(navigationLayerBlock?.[1]).toContain('isolation: isolate;');
    expect(navigationDepthBlock?.[1]).toContain('background: var(--shell-navigation-depth-overlay);');
    expect(darkThemeBlock?.[1]).toContain('--shell-navigation-depth-overlay: linear-gradient(');
    expect(darkThemeBlock?.[1]).toContain('rgba(255, 255, 255, 0) 100%');
  });

  it('keeps active dark view layers on the workspace surface instead of the black nav surface', () => {
    const darkPageContainerBlock = appCssSource.match(/\.dark\s+\.page-container\s*\{([\s\S]*?)\n\}/);

    expect(darkPageContainerBlock?.[1]).toContain('background: var(--shell-workspace-panel);');
    expect(darkPageContainerBlock?.[1]).not.toContain('background: hsl(var(--nav-background));');
  });

  it('does not frame flush top workspace panes at the navigation join', () => {
    const flushTopPaneBlock = appCssSource.match(/\.study-shell-pane--flush-top\s*\{([\s\S]*?)\n\}/);

    expect(flushTopPaneBlock?.[1]).toContain('border-left: 0;');
    expect(flushTopPaneBlock?.[1]).toContain('border-right: 0;');
  });
});
