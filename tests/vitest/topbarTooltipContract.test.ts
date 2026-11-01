import { describe, expect, it } from 'vitest';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

/**
 * 旧版 Topbar.tsx 已删除（2026-07）；侧栏折叠开关随桌面壳自绘标题栏迁入
 * App.tsx 的 DesktopSidebarAccessory。契约意图不变：
 * 侧栏开关必须用 CommonTooltip（而非原生 title）并保留 aria-label。
 */
describe('desktop shell sidebar toggle tooltip contract', () => {
  const appSource = readAppShellSource();

  it('uses CommonTooltip for the sidebar toggle instead of native title', () => {
    expect(appSource).toContain("import { CommonTooltip } from '@/components/shared/CommonTooltip';");
    expect(appSource).toContain('function DesktopSidebarAccessory({');
    expect(appSource).toContain('<CommonTooltip content={label} position="bottom">');
    expect(appSource).toContain('aria-label={label}');
    expect(appSource).not.toContain('title={label}');
    expect(appSource).not.toContain('title={sidebarCollapsed');
  });
});
