import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings single sidebar layout contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

  it('does not render the global ModernSidebar while the settings view is active on desktop', () => {
    expect(appSource).toContain("const desktopShellSidebarElement = currentView === 'settings'");
    expect(appSource).toContain('<SettingsShellSidebar');
    expect(appSource).toContain('<ModernSidebar');
  });

  it('uses the real collapsed sidebar width for settings instead of reserving a stale default column', () => {
    expect(appSource).toContain("const desktopNavigationWidth = !isSmallScreen && leftPanelCollapsed ? 0 : shellSidebarWidth;");
    expect(appSource).not.toContain("currentView !== 'settings' && leftPanelCollapsed ? 0 : shellSidebarWidth");
    expect(appSource).toContain("'--shell-navigation-width': `${desktopNavigationWidth}px`");
  });
});
