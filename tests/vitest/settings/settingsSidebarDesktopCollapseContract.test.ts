import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings desktop collapse contract', () => {
  const settingsSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/Settings.tsx'),
    'utf-8'
  );

  it('passes the desktop left-panel collapsed state through to SettingsSidebar', () => {
    expect(settingsSource).toContain('globalLeftPanelCollapsed={globalLeftPanelCollapsed}');
    expect(settingsSource).not.toContain('globalLeftPanelCollapsed={isSmallScreen ? globalLeftPanelCollapsed : false}');
  });
});
