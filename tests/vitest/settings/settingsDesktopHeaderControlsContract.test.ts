import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings desktop header controls contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');

  it('does not render desktop chat navigation controls while the settings view is active', () => {
    expect(appSource).toContain("const shouldShowDesktopHeaderNavControls = currentView !== 'settings' && currentView !== 'todo';");
    expect(appSource).toContain('{shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
    expect(appSource).not.toContain('{leftPanelCollapsed && shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
    expect(appSource).not.toContain('{!leftPanelCollapsed && shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
  });

  it('keeps only the right desktop workspace titlebar seamless without changing the left navigation titlebar', () => {
    expect(appCssSource).toMatch(/\.desktop-shell-header-cell--workspace\s*\{[\s\S]*border:\s*0;[\s\S]*box-shadow:\s*none;/);
    expect(appCssSource).toMatch(/\.desktop-shell-header-cell--nav\s*\{[\s\S]*background:\s*var\(--shell-navigation-surface\);[\s\S]*border-right:\s*0;/);
    expect(appSource).not.toContain('data-current-view={currentView}');
    expect(appCssSource).not.toContain('.desktop-shell-titlebar[data-current-view="settings"] .desktop-shell-header-cell--nav');
  });

  it('does not let legacy settings shell styles draw the desktop workspace seam', () => {
    const settingsBlocks = Array.from(appCssSource.matchAll(/(?:^|\n)(?:\.dark\s+)?\.settings\s*\{([\s\S]*?)\n\}/g));

    expect(settingsBlocks.length).toBeGreaterThan(0);
    for (const [, body] of settingsBlocks) {
      const boxShadowValues = Array.from(body.matchAll(/box-shadow:\s*([^;]+);/g)).map((match) => match[1].trim());
      const borderValues = Array.from(body.matchAll(/(?:^|\n)\s*border:\s*([^;]+);/g)).map((match) => match[1].trim());

      expect(boxShadowValues).toContain('none');
      expect(boxShadowValues.every((value) => value === 'none')).toBe(true);
      expect(borderValues).not.toContain(expect.stringMatching(/^1px\b/));
    }
    expect(appCssSource).toMatch(/\.settings\s*\{[\s\S]*background:\s*var\(--shell-workspace-panel\);[\s\S]*border:\s*0;[\s\S]*box-shadow:\s*none;/);
  });
});
