import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar scroll contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
  const primitiveSource = readFileSync(resolve(process.cwd(), 'src/features/workbench/components/sidebar/WorkbenchSidebar.tsx'), 'utf-8');
  const appCss = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');

  it('keeps primary workspace navigation fixed while only session groups scroll', () => {
    expect(sidebarSource).toContain('data-sidebar-fixed-region="primary-navigation"');
    expect(sidebarSource).toContain('<WorkbenchSidebarFixed');
    expect(sidebarSource).toContain('<WorkbenchSidebarScroll>');
    expect(sidebarSource.indexOf('<WorkbenchSidebarFixed')).toBeLessThan(sidebarSource.indexOf('<WorkbenchSidebarScroll>'));
    expect(primitiveSource).toContain('data-sidebar-scroll-region');
    expect(primitiveSource).toContain("'sessions'");
    expect(primitiveSource).toContain('<CustomScrollArea');
  });

  it('does not paint overlay pseudo-elements or mask fades over the session scroll region', () => {
    // 会话列表边缘渐隐（mask-image 方案）已随 os 重构移除：滚动壳只负责滚动，
    // 不再叠加可能拦截交互或遮挡内容的伪元素/遮罩。
    expect(primitiveSource).toContain('desktop-shell-sidebar-session-scroll');
    expect(appCss).not.toContain('.desktop-shell-sidebar-session-scroll::before');
    expect(appCss).not.toContain('.desktop-shell-sidebar-session-scroll::after');
    expect(appCss).not.toContain('.desktop-shell-sidebar-session-scroll-viewport');
    expect(appCss).not.toContain('--desktop-shell-sidebar-session-fade-size');
  });

  it('keeps the session viewport free of the legacy fade mask class', () => {
    expect(primitiveSource).not.toContain('desktop-shell-sidebar-session-scroll-viewport');
    expect(primitiveSource).toContain('viewportClassName="h-full w-full"');
  });

  it('shows the session scrollbar only while the user is scrolling', () => {
    expect(primitiveSource).toContain('scrollAutoHide="scroll"');
    expect(primitiveSource).toContain('scrollAutoHideSuspend={false}');
  });
});
