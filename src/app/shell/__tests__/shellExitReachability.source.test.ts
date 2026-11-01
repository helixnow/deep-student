import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

/**
 * 「进得去就出得来」契约：任何视图在任何壳形态下都要留一个可见可点的出口。
 * 桌面侧（设置/待办收起侧栏）见 desktopSidebarShell.source.test.ts；这里覆盖
 * 移动壳缺顶栏、以及收起态标题栏控件的预留宽度。
 */
const appSource = readAppShellSource();
const viewContentsSource = readFileSync(
  resolve(process.cwd(), 'src/app/hooks/useViewLayerContents.tsx'),
  'utf8',
);

describe('shell exit reachability', () => {
  it('wraps the super-agent view in MobilePageScaffold so narrow windows keep a back button', () => {
    // 回归：Super-agent 页不注册 useMobileHeader、不带 MobileSlidingLayout，移动抽屉也无入口；
    // 从桌面宽度拉窄到 <768 后，若不包脚手架，页面没有统一顶栏 → 无返回出口。
    const block = viewContentsSource.slice(
      viewContentsSource.indexOf('const superAgentContent = useMemo('),
      viewContentsSource.indexOf('[isSuperAgentActive]);'),
    );
    expect(block).toContain('<MobilePageScaffold>');
    expect(block).toContain('<LazySuperAgentPage isActive={isSuperAgentActive} />');
  });

  it('keeps the mobile header back fallback for every non-home view', () => {
    expect(appSource).toContain("const mobileHeaderCanGoBack = unifiedCanGoBack || currentView !== 'chat-v2';");
    expect(appSource).toContain("if (isSmallScreenRef.current && currentViewRef.current !== 'chat-v2') {");
  });

  it('reserves titlebar width for every control shown while the sidebar is collapsed', () => {
    // 收起态标题栏前导控件 = 侧栏开关 + DesktopHeaderNavControls 内的按钮（后退/前进/新建会话）。
    // desktopCollapsedControlCount 决定工作区标题的左侧让位（desktopTitlebarLeadingInset），
    // 少算会让标题/工具栏与控件（以及 macOS 红绿灯右侧）重叠。
    const navControlsStart = appSource.indexOf('function DesktopHeaderNavControls(');
    const navControlsEnd = appSource.indexOf('type CurrentView = NavigationCurrentView;', navControlsStart);
    expect(navControlsStart).toBeGreaterThan(-1);
    expect(navControlsEnd).toBeGreaterThan(navControlsStart);
    const navButtons = appSource.slice(navControlsStart, navControlsEnd).match(/<DsButton\b/g) ?? [];
    const countMatch = appSource.match(/const desktopCollapsedControlCount = (\d+);/);
    expect(countMatch).not.toBeNull();
    expect(Number(countMatch?.[1])).toBeGreaterThanOrEqual(navButtons.length + 1);
    expect(appSource).toContain('? (isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer : 0) + 16 + desktopCollapsedLeadingWidth');
    expect(appSource).toContain('const desktopFloatingAccessoryOffset = isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer + 16 : 16;');
  });
});
