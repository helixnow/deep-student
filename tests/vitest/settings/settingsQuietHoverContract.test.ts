import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf-8');

describe('settings quiet hover contract', () => {
  it('centralizes quiet hover tokens for settings navigation, mobile shell controls, and data tables', () => {
    const settingsCommon = readSource('src/features/settings/components/SettingsCommon.tsx');

    expect(settingsCommon).toContain('settingsQuietHoverClassName');
    expect(settingsCommon).toContain('settingsQuietRowBaseClassName');
    expect(settingsCommon).toContain('hover:bg-[color:var(--sidebar-quiet-hover)]');
    expect(settingsCommon).toContain('settingsQuietActiveSurfaceClassName');
    expect(settingsCommon).toContain('settingsQuietSelectedRowClassName');
    expect(settingsCommon).toContain('bg-[color:var(--sidebar-quiet-active)]');
    expect(settingsCommon).toContain('settingsQuietButtonIdleRowClassName');
    expect(settingsCommon).toContain('settingsQuietButtonSelectedRowClassName');
    expect(settingsCommon).toContain('hover:!text-muted-foreground');
    expect(settingsCommon).toContain('settingsQuietTableRowClassName');
    expect(settingsCommon).toContain('settingsMobileSheetCloseButtonClassName');
  });

  it('keeps settings navigation rows quiet without hover text changes', () => {
    const sources = [
      readSource('src/features/settings/components/ApisTab.tsx'),
      readSource('src/features/settings/components/EngineSettingsSection.tsx'),
    ].join('\n');

    expect(sources).toContain('settingsQuietInteractiveRowClassName');
    expect(sources).toContain('settingsQuietIdleRowClassName');
    expect(sources).toContain('settingsQuietSelectedRowClassName');
    expect(sources).toContain('settingsQuietButtonIdleRowClassName');
    expect(sources).not.toContain('hover:bg-muted/50 hover:text-foreground');
    expect(sources).not.toContain('hover:bg-muted/30');
  });

  it('uses tokenized quiet hover for the mobile settings sheet close control', () => {
    const app = readSource('src/App.tsx');

    expect(app).toContain('settingsMobileSheetCloseButtonClassName');
    expect(app).not.toContain('hover:bg-[#F1F3F6]');
    expect(app).not.toContain('hover:text-[#111111]');
    expect(app).not.toContain('focus-visible:ring-[#6AA5FF]');
  });

  it('uses tokenized quiet hover for data governance table rows', () => {
    const sources = [
      readSource('src/features/settings/components/data-governance/OverviewTab.tsx'),
      readSource('src/features/settings/components/data-governance/BackupTab.tsx'),
      readSource('src/features/settings/components/data-governance/MigrationTab.tsx'),
      readSource('src/features/settings/components/data-governance/AuditTab.tsx'),
      readSource('src/features/settings/components/data-governance/SyncTab.tsx'),
    ].join('\n');

    expect(sources).toContain('settingsQuietTableRowClassName');
    expect(sources).not.toContain('hover:bg-muted/30');
  });
});
