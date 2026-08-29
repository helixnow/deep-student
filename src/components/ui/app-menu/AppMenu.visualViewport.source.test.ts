/**
 * AppMenu 定位的 visualViewport 感知契约（source-level）。
 *
 * 背景：软键盘弹出时 window.innerHeight 不变、只有 visualViewport.height
 * 缩小；定位若只读 innerWidth/innerHeight 且只监听 window resize/scroll，
 * 菜单会被键盘遮住且不重定位。对照 ComposerPanelOverlay 的正确实现，
 * AppMenu 边界钳位改用 visualViewport 尺寸，并补挂 visualViewport
 * resize/scroll（passive）监听，同时保留 window 监听作兜底。
 *
 * 用 source 断言而非 jsdom 渲染：jsdom 无真实 visualViewport 行为，
 * 契约的核心是"读哪个尺寸、挂了哪些监听、清理是否配对"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appMenuSource = readFileSync(
  resolve(process.cwd(), 'src/components/ui/app-menu/AppMenu.tsx'),
  'utf-8'
);
const utilSource = readFileSync(
  resolve(process.cwd(), 'src/components/ui/visualViewport.ts'),
  'utf-8'
);
const appMenuCss = readFileSync(
  resolve(process.cwd(), 'src/components/ui/app-menu/AppMenu.css'),
  'utf-8'
);

describe('AppMenu positioning visualViewport contract', () => {
  it('uses the shared visualViewport util instead of raw window.inner* for bounds', () => {
    expect(appMenuSource).toContain(
      "import { addVisualViewportChangeListener, getVisualViewportSize } from '../visualViewport';"
    );
    // 主菜单 + 子菜单两处定位都读可视视口尺寸
    expect(appMenuSource.match(/getVisualViewportSize\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    // 定位计算里不再直接读 window.innerWidth / window.innerHeight
    expect(appMenuSource).not.toMatch(/window\.inner(Width|Height)/);
  });

  it('subscribes to visualViewport changes in both menu and submenu positioning effects', () => {
    expect(
      appMenuSource.match(/addVisualViewportChangeListener\(updatePosition\)/g)?.length
    ).toBe(2);
    // 清理配对：每次订阅都有对应的解除
    expect(
      appMenuSource.match(/removeVisualViewportListener\(\)/g)?.length
    ).toBe(2);
  });

  it('keeps window resize/scroll listeners as fallback (now passive)', () => {
    expect(
      appMenuSource.match(/window\.addEventListener\('resize', updatePosition, \{ passive: true \}\)/g)?.length
    ).toBe(2);
    expect(
      appMenuSource.match(
        /window\.addEventListener\('scroll', updatePosition, \{ capture: true, passive: true \}\)/g
      )?.length
    ).toBe(2);
    // removeEventListener 的 capture 标志与挂载时一致
    expect(
      appMenuSource.match(/window\.removeEventListener\('scroll', updatePosition, true\)/g)?.length
    ).toBe(2);
  });

  it('util falls back to window.inner* and registers passive visualViewport listeners', () => {
    expect(utilSource).toContain('vv?.width ?? window.innerWidth');
    expect(utilSource).toContain('vv?.height ?? window.innerHeight');
    expect(utilSource).toContain("vv.addEventListener('resize', handler, { passive: true })");
    expect(utilSource).toContain("vv.addEventListener('scroll', handler, { passive: true })");
    // 不支持 visualViewport 时返回 no-op，桌面端行为不受影响
    expect(utilSource).toContain('if (!vv) return () => {};');
  });

  it('caps mobile menus to the live visual viewport instead of letting them scroll off-screen', () => {
    expect(appMenuSource.match(/availableHeight/g)?.length).toBeGreaterThanOrEqual(2);
    expect(appMenuSource).toContain("'--app-menu-available-height'");
    expect(appMenuCss).toContain(
      'max-height: var(--app-menu-available-height, calc(100dvh - 16px));'
    );
    expect(appMenuCss).toContain('overscroll-behavior: contain;');
  });

  it('does not touch open/close, click timing, portal target, or Android back registration', () => {
    // portal 目标仍是 overlay 容器兜底 document.body
    expect(appMenuSource).toContain('portalContainerRef.current ?? document.body');
    // Android back 注册保持 overlay 优先级
    expect(appMenuSource).toContain('BACK_PRIORITY.overlay');
    // 菜单项点击后仍立即关闭（执行时机不变）
    expect(appMenuSource).toContain('ctx?.setOpen(false);');
  });
});
