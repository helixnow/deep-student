import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('archive session toast settings navigation contract', () => {
  it('routes the toast settings action to Settings data governance trash', () => {
    const pendingSettingsSource = readFileSync(resolve(process.cwd(), 'src/utils/pendingSettingsTab.ts'), 'utf-8');
    const settingsSource = readFileSync(resolve(process.cwd(), 'src/components/Settings.tsx'), 'utf-8');
    const dashboardSource = readFileSync(resolve(process.cwd(), 'src/components/settings/DataGovernanceDashboard.tsx'), 'utf-8');

    expect(pendingSettingsSource).toContain('openArchivedSessionsSettings');
    expect(pendingSettingsSource).toContain("tab: 'data-governance'");
    expect(pendingSettingsSource).toContain("dataGovernanceTab: 'trash'");
    expect(pendingSettingsSource).toContain("new CustomEvent('navigate-to-tab'");
    expect(pendingSettingsSource).toContain("new CustomEvent('SETTINGS_NAVIGATE_TAB'");

    expect(settingsSource).toContain('consumePendingSettingsRoute');
    expect(settingsSource).toContain('dataGovernanceTabTarget');
    expect(settingsSource).toContain('dataGovernanceTab');
    expect(settingsSource).toContain('tabTarget={dataGovernanceTabTarget}');

    expect(dashboardSource).toContain('tabTarget?: DataGovernanceTabTarget | null');
    expect(dashboardSource).toContain('setActiveTab(tabTarget.tab)');
  });
});
