import { describe, expect, it } from 'vitest';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

/**
 * 旧版 Topbar.tsx 已删除（2026-07）；侧栏折叠开关随桌面壳自绘标题栏迁入
 * AppShellChrome.tsx 的 DesktopSidebarAccessory。契约意图不变：
 * 侧栏开关必须用统一 Tooltip（而非原生 title）并保留 aria-label。
 */
describe('desktop shell sidebar toggle tooltip contract', () => {
  const appSource = readAppShellSource();

  it('uses Tooltip for the sidebar toggle instead of native title', () => {
    expect(appSource).toContain("import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';");
    expect(appSource).toContain('function DesktopSidebarAccessory({');
    expect(appSource).toContain('<Tooltip>');
    expect(appSource).toContain('<TooltipTrigger asChild>');
    expect(appSource).toContain('<TooltipContent side="bottom">{label}</TooltipContent>');
    expect(appSource).toContain('aria-label={label}');
    expect(appSource).not.toContain('title={label}');
    expect(appSource).not.toContain('title={sidebarCollapsed');
  });
});
