import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings desktop collapse contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const shellSidebarSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/SettingsShellSidebar.tsx'),
    'utf-8'
  );

  it('passes the desktop left-panel collapsed state through to SettingsSidebar', () => {
    expect(appSource).toContain('globalLeftPanelCollapsed={leftPanelCollapsed}');
    expect(shellSidebarSource).toContain('globalLeftPanelCollapsed={globalLeftPanelCollapsed}');
    expect(shellSidebarSource).not.toContain('globalLeftPanelCollapsed={isSmallScreen ? globalLeftPanelCollapsed : false}');
  });
});
