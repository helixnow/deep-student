import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 会话列表滚动壳已从 ModernSidebar 迁移到 WorkbenchSidebar（os 重构），
// 本测试对应 nightly 的 ModernSidebar.scrollbarVisibility.test.ts 意图。
const sidebarSource = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/components/sidebar/WorkbenchSidebar.tsx'),
  'utf8',
);
const shellCss = readFileSync(
  resolve(process.cwd(), 'src/shared/styles/app.css'),
  'utf8',
);

describe('WorkbenchSidebar session scrollbar', () => {
  it('does not apply the session fade mask to the OverlayScrollbars host', () => {
    expect(sidebarSource).not.toContain(
      'viewportClassName="desktop-shell-sidebar-session-scroll-viewport h-full w-full"',
    );
    expect(shellCss).not.toContain('.desktop-shell-sidebar-session-scroll-viewport {');
  });

  it('shows the session scrollbar only while the user is scrolling', () => {
    expect(sidebarSource).toContain('scrollAutoHide="scroll"');
    expect(sidebarSource).toContain('scrollAutoHideSuspend={false}');
  });
});
