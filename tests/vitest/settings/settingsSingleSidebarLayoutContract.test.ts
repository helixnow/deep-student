import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings single sidebar layout contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

  it('keeps the global ModernSidebar out of the visible desktop sidebar slot while settings is active', () => {
    expect(appSource).toContain("const desktopShellSidebarKind = currentView === 'settings'");
    // 侧栏改为分层常驻：settings 激活 settings 层，主 ModernSidebar 仍挂载以保住会话
    // 缓存，但由 DesktopShellSidebarLayers 置 hidden + inert（行为见其单测），
    // 因此桌面上任何时刻仍只有一个可见、可聚焦的侧栏。
    expect(appSource).toContain("['main', sidebarElement],");
    expect(appSource).toContain("['settings', settingsShellSidebarElement],");
    expect(appSource).toContain('<SettingsShellSidebar');
    expect(appSource).toContain('<ModernSidebar');
    // 桌面外壳只保留一个侧栏挂载点
    expect(appSource.match(/<DesktopShellSidebarLayers/g)).toHaveLength(1);
    expect(appSource).not.toContain('desktopShellSidebarElement');
  });

  it('uses the real collapsed sidebar width for settings instead of reserving a stale default column', () => {
    expect(appSource).toContain('const desktopNavigationWidth = workbenchActive');
    // 侧栏滑出动画引入 desktopSidebarPresentationWidth（motion 宽度回退到 shellSidebarWidth），
    // 折叠时布局列宽仍立即归零。
    expect(appSource).toContain(': !isSmallScreen && leftPanelCollapsed ? 0 : desktopSidebarPresentationWidth;');
    expect(appSource).not.toContain("currentView !== 'settings' && leftPanelCollapsed ? 0 : shellSidebarWidth");
    expect(appSource).toContain("'--shell-navigation-width': `${desktopNavigationWidth}px`");
  });
});
