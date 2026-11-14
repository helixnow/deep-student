import { describe, expect, it } from 'vitest';
import { readAppShellSource } from '@/app/__tests__/appShellSources';
import { readOfficialShellEntries, shellViewsWhere } from '@/app/__tests__/officialShellEntries';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings desktop header controls contract', () => {
  const appSource = readAppShellSource();
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');

  // 设置 / 待办展开侧栏时由各自壳侧栏提供返回入口，标题栏不重复渲染导航控件；
  // 但侧栏收起时壳侧栏（含返回入口）随之隐藏，标题栏必须保留开关与前进/后退，否则页面无出口
  //（回归：对话页收起侧栏 → 后退进入设置页 → 无任何出口）。
  it('hides desktop chat navigation controls in settings/todo only while the sidebar is expanded', async () => {
    const { views } = await readOfficialShellEntries();
    expect(shellViewsWhere(views, (shell) => shell.sidebarOwnsBackNavigation === true)).toEqual(['settings', 'todo']);
    expect(appSource).toContain('const shouldShowDesktopHeaderNavControls =\n    !(activeShell?.sidebarOwnsBackNavigation ?? false) || leftPanelCollapsed;');
    expect(appSource).toContain('{shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
    expect(appSource).not.toContain('{leftPanelCollapsed && shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
    expect(appSource).not.toContain('{!leftPanelCollapsed && shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}');
  });

  it('hides the desktop sidebar toggle in settings only while the sidebar is expanded', async () => {
    expect(appSource).toContain('const shouldShowDesktopSidebarToggle = !activeShell?.hideExpandedSidebarToggle || leftPanelCollapsed;');
    const { views } = await readOfficialShellEntries();
    expect(shellViewsWhere(views, (shell) => shell.hideExpandedSidebarToggle === true)).toEqual(['settings']);
    expect(appSource).toContain('{shouldShowDesktopSidebarToggle ? (\n        <DesktopSidebarAccessory');
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
