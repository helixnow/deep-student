import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf-8');

describe('settings quiet hover contract', () => {
  it('centralizes quiet hover tokens for settings navigation and data tables', () => {
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
    // settingsMobileSheetCloseButtonClassName 已随旧版移动端设置 Sheet 一起下线
    //（统一移动壳 UnifiedMobileHeader + MobileSlidingLayout），不再是公共 token。
    expect(settingsCommon).not.toContain('settingsMobileSheetCloseButtonClassName');
  });

  it('keeps settings navigation rows quiet without hover text changes', () => {
    const navigationSources = [
      readSource('src/features/settings/components/VendorSidebar.tsx'),
      readSource('src/features/settings/components/EngineSettingsSection.tsx'),
    ].join('\n');
    const sources = [
      navigationSources,
      readSource('src/features/settings/components/VendorDetailPanel.tsx'),
    ].join('\n');

    expect(sources).toContain('settingsQuietInteractiveRowClassName');
    expect(sources).toContain('settingsQuietIdleRowClassName');
    expect(sources).toContain('settingsQuietSelectedRowClassName');
    expect(sources).toContain('settingsQuietButtonIdleRowClassName');
    expect(navigationSources).not.toContain('hover:bg-muted/50 hover:text-foreground');
    expect(navigationSources).not.toContain('hover:bg-muted/30');
  });

  it('keeps the app shell free of raw hover/focus hex overrides', () => {
    // 旧版移动端设置 Sheet（settingsMobileSheetCloseButtonClassName）已随统一
    // 移动壳（UnifiedMobileHeader + MobileSlidingLayout）移除，App.tsx 不再引用该 token；
    // 仅保留“禁止裸色值”负向断言。
    const app = readSource('src/App.tsx');

    expect(app).not.toContain('hover:bg-[#F1F3F6]');
    expect(app).not.toContain('hover:text-[#111111]');
    expect(app).not.toContain('focus-visible:ring-[#6AA5FF]');
  });

  it('uses tokenized quiet hover for data governance table rows', () => {
    const sources = [
      readSource('src/features/settings/components/data-governance/OverviewTab.tsx'),
      readSource('src/features/settings/components/data-governance/BackupTab.tsx'),
      readSource('src/features/settings/components/data-governance/AuditTab.tsx'),
      readSource('src/features/settings/components/data-governance/SyncTab.tsx'),
    ].join('\n');

    expect(sources).toContain('settingsQuietTableRowClassName');
    expect(sources).not.toContain('hover:bg-muted/30');
  });
});
