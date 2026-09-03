/**
 * Android 返回键 back 链源码契约（0824 Wave2-C R2）。
 *
 * 场景：Chat 组合面板打开后再打开 AppMenu，按系统返回键应「先关菜单、
 * 面板仍开；再按一次才关面板」。两者都以 BACK_PRIORITY.overlay 注册，
 * 先后顺序完全由协调器的栈语义（同优先级后注册者先执行）保证——这是
 * 跨三个文件的隐式约定，任何一环缺失都会静默破坏层级关闭顺序，且
 * jsdom 下渲染 InputBarUI/AppMenu 成本过高，故用源码契约锁住。
 *
 * 红/绿说明：
 * - 协调器若把排序改成 seq 升序（先注册先执行）或去掉 seq 比较 → 用例 1 红；
 * - AppMenu / InputBarUI 任一处缺失 registerBackHandler 注册（修复前状态）
 *   或改用非 overlay 档 / overlay±N 魔法数值 → 用例 2/3 红；
 * - 当前基线（98bbf3f1 起）三处齐全，应全绿。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const coordinatorSource = read('src/app/navigation/androidBackCoordinator.ts');
const appMenuSource = read('src/components/ui/app-menu/AppMenu.tsx');
const inputBarSource = read('src/features/chat/components/input-bar/InputBarUI.tsx');

describe('coordinator dispatch order: same priority, LIFO', () => {
  it('assigns a monotonic seq on registration and pushes onto the stack', () => {
    expect(coordinatorSource).toMatch(/seq:\s*seqCounter\+\+/);
    expect(coordinatorSource).toMatch(/handlers\.push\(entry\)/);
  });

  it('sorts by priority desc, then seq desc (later-registered first)', () => {
    // 锁住排序表达式本身：b - a 两段都是降序。改成 a.seq - b.seq
    //（先注册先执行）会破坏「后开的菜单先关」，此用例应红。
    expect(coordinatorSource).toMatch(
      /\(b\.priority\s*-\s*a\.priority\)\s*\|\|\s*\(b\.seq\s*-\s*a\.seq\)/,
    );
  });

  it('documents the AppMenu / Composer-panel same-tier contract next to BACK_PRIORITY', () => {
    expect(coordinatorSource).toContain('同档共存登记');
    expect(coordinatorSource).toMatch(/AppMenu[\s\S]{0,200}InputBarUI/);
  });
});

describe('AppMenu registers an overlay-tier back handler while open', () => {
  it('imports the coordinator API', () => {
    expect(appMenuSource).toMatch(
      /import\s*\{[^}]*registerBackHandler[^}]*\}\s*from\s*'@\/app\/navigation\/androidBackCoordinator'/,
    );
  });

  it('registers at exactly BACK_PRIORITY.overlay (no ±N magic offsets)', () => {
    // 注册调用以 BACK_PRIORITY.overlay 收尾，后面不允许跟 +/- 运算
    expect(appMenuSource).toMatch(/registerBackHandler\(/);
    expect(appMenuSource).toMatch(/\},\s*BACK_PRIORITY\.overlay\)/);
    expect(appMenuSource).not.toMatch(/BACK_PRIORITY\.overlay\s*[+-]\s*\d/);
  });

  it('only keeps the handler registered while the menu is open', () => {
    // useEffect gate：菜单关了立即注销，让位给下层面板 handler
    expect(appMenuSource).toMatch(/if\s*\(!actualOpen\)\s*return;[\s\S]{0,120}registerBackHandler/);
  });
});

describe('InputBarUI composer panels register an overlay-tier back handler while open', () => {
  it('imports the coordinator API', () => {
    expect(inputBarSource).toMatch(
      /import\s*\{[^}]*registerBackHandler[^}]*\}\s*from\s*'@\/app\/navigation\/androidBackCoordinator'/,
    );
  });

  it('registers at exactly BACK_PRIORITY.overlay (no ±N magic offsets)', () => {
    expect(inputBarSource).toMatch(/registerBackHandler\(/);
    expect(inputBarSource).toMatch(/\},\s*BACK_PRIORITY\.overlay\)/);
    expect(inputBarSource).not.toMatch(/BACK_PRIORITY\.overlay\s*[+-]\s*\d/);
  });

  it('gates registration on a panel actually being open (so a later-opened menu wins LIFO)', () => {
    expect(inputBarSource).toMatch(
      /if\s*\(!isMobile\s*\|\|\s*!hasAnyPanelOpen\)\s*return;[\s\S]{0,120}registerBackHandler/,
    );
  });
});
