/**
 * Android 返回键「菜单叠面板」序列 —— 协调器栈语义单元测试 + 产品注册点契约
 * （0824 Wave2-C 第 2 轮 · 测试-back 链）
 *
 * 目标序列（移动端 Chat 页）：
 *   组合面板开（InputBarUI 注册 overlay handler）
 *     → 其上再开 AppMenu（AppMenu 注册 overlay handler）
 *     → 第一次 back：只关菜单，面板仍开
 *     → 第二次 back：关面板
 *     → 第三次 back：无人消费，返回 false（native moveTaskToBack）
 *
 * 修复前预期（回归场景，任一条命中即本测试失败）：
 * - AppMenu / InputBarUI 未注册 overlay handler：AppMenu 是自绘浮层（非
 *   Radix），协调器的 Escape 兜底探测不到它；InputBarUI 组合面板同理。
 *   back 会越过打开中的浮层直接落到 view/navigation handler 甚至 native
 *   moveTaskToBack——「菜单还开着，应用先退后台」。
 * - 同优先级排序若是 FIFO（先注册先执行）：第一次 back 会先关底下的面板、
 *   菜单反而残留，层级顺序颠倒。
 *
 * 修复后预期（本文件断言）：
 * - registerBackHandler 同优先级栈语义：后注册者先执行（seq 大者在前），
 *   「最后打开的 overlay 最先关闭」。
 * - handler 关闭自身后必须注销（组件在 open=false 的 effect cleanup 中调用
 *   注销函数），第二次 back 不会命中已关闭浮层的陈旧 handler。
 * - handler 返回 false 让行（如 AppMenu 宿主视图离屏时），事件继续传给
 *   下一个 handler，而不是被吞掉。
 * - 全部浮层关闭后 handleAndroidBack() 返回 false，交还 native。
 *
 * 本轮只写不跑（禁 vitest 执行）；断言基于 androidBackCoordinator.ts@98bbf3f1
 * 的导出签名（registerBackHandler / handleAndroidBack / BACK_PRIORITY）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACK_PRIORITY,
  handleAndroidBack,
  registerBackHandler,
} from '../androidBackCoordinator';

// ---------------------------------------------------------------------------
// 协调器持有模块级 handler 栈；每个用例注册的 handler 统一登记、用例结束后
// 全部注销，避免跨用例污染（断言失败提前 return 时也能清干净）。
// ---------------------------------------------------------------------------
const cleanups: Array<() => void> = [];

function track(unregister: () => void): () => void {
  cleanups.push(unregister);
  return unregister;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * 模拟一个「打开中的 overlay」：
 * - open=true 时 handler 关闭自身并消费事件（返回 true）；
 * - 关闭动作同步注销 handler（对应组件里 open=false 触发 effect cleanup）；
 * - open=false 后若仍被调用（陈旧 handler 场景）返回 false 让行。
 */
function createOverlay(name: string, calls: string[]) {
  let open = true;
  let unregister: (() => void) | null = null;

  const handler = vi.fn(() => {
    calls.push(name);
    if (!open) return false;
    open = false;
    unregister?.();
    unregister = null;
    return true;
  });

  unregister = track(registerBackHandler(handler, BACK_PRIORITY.overlay));

  return {
    handler,
    isOpen: () => open,
  };
}

describe('androidBackCoordinator · 菜单叠面板序列（栈语义）', () => {
  it('面板先注册、菜单后注册：第一次 back 只关菜单，面板仍开', () => {
    const calls: string[] = [];
    // 注册顺序即打开顺序：先开组合面板（InputBarUI），再开 AppMenu
    const panel = createOverlay('panel', calls);
    const menu = createOverlay('menu', calls);

    const consumed = handleAndroidBack();

    expect(consumed).toBe(true);
    // 栈语义：后注册的菜单 handler 先执行；面板 handler 根本不该被触碰
    expect(calls).toEqual(['menu']);
    expect(menu.isOpen()).toBe(false);
    expect(panel.isOpen()).toBe(true);
  });

  it('第二次 back 关面板，第三次 back 无人消费返回 false（native 接管）', () => {
    const calls: string[] = [];
    const panel = createOverlay('panel', calls);
    const menu = createOverlay('menu', calls);

    expect(handleAndroidBack()).toBe(true); // 关菜单
    expect(handleAndroidBack()).toBe(true); // 关面板

    expect(calls).toEqual(['menu', 'panel']);
    expect(menu.isOpen()).toBe(false);
    expect(panel.isOpen()).toBe(false);
    // 菜单 handler 已在自身关闭时注销，第二次 back 不允许再命中它
    expect(menu.handler).toHaveBeenCalledTimes(1);

    // 全部浮层已关：第三次 back 前端不消费，交还 native moveTaskToBack
    expect(handleAndroidBack()).toBe(false);
  });

  it('顶层 handler 返回 false 让行时，事件继续传给下一个 overlay handler', () => {
    // 对应 AppMenu 宿主视图被 inert / display:none 隐藏的场景：
    // 菜单 handler 主动让行（返回 false），back 应关掉当前活跃层（面板）
    const calls: string[] = [];
    const panel = createOverlay('panel', calls);
    const yieldingMenu = vi.fn(() => false);
    track(registerBackHandler(yieldingMenu, BACK_PRIORITY.overlay));

    const consumed = handleAndroidBack();

    expect(consumed).toBe(true);
    expect(yieldingMenu).toHaveBeenCalledTimes(1);
    expect(panel.isOpen()).toBe(false);
    expect(calls).toEqual(['panel']);
  });

  it('overlay 档优先于 view/navigation 档，与注册先后无关', () => {
    const calls: string[] = [];
    // 故意先注册低优先级 handler：优先级排序必须压过注册顺序
    track(
      registerBackHandler(() => {
        calls.push('navigation');
        return true;
      }, BACK_PRIORITY.navigation)
    );
    track(
      registerBackHandler(() => {
        calls.push('view');
        return true;
      }, BACK_PRIORITY.view)
    );
    const panel = createOverlay('panel', calls);

    expect(handleAndroidBack()).toBe(true);
    expect(calls).toEqual(['panel']);
    expect(panel.isOpen()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// source 契约：锁死产品侧两个注册点。任一方注册被删/降级，上面的纯函数
// 测试依然会绿（它们只驱动协调器本身），所以必须用源码契约把「AppMenu 与
// InputBarUI 都以 overlay 档接入协调器」钉死。
// ---------------------------------------------------------------------------
describe('androidBackCoordinator · 产品注册点 source 契约', () => {
  const readSource = (relPath: string) =>
    readFileSync(resolve(process.cwd(), relPath), 'utf-8');

  const appMenuSource = readSource('src/components/ui/app-menu/AppMenu.tsx');
  const inputBarSource = readSource(
    'src/features/chat/components/input-bar/InputBarUI.tsx'
  );

  it('AppMenu 打开时以 overlay 档注册返回键 handler', () => {
    expect(appMenuSource).toContain(
      "import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';"
    );
    // 打开时注册 + effect cleanup 注销（return registerBackHandler(...)）
    expect(appMenuSource).toMatch(
      /return registerBackHandler\(\(\) => \{[\s\S]*?\}, BACK_PRIORITY\.overlay\);/
    );
    // 离屏让行守卫：宿主视图 inert / 隐藏时不吞返回键
    expect(appMenuSource).toContain("el.closest('[inert]')");
    expect(appMenuSource).toContain('el.offsetParent === null');
  });

  it('InputBarUI 组合面板打开时以 overlay 档注册返回键 handler', () => {
    // 用正则而非精确字符串：卡 4 在同一 import 里追加了
    // hasOpenRadixOverlayBesides（Radix 浮层让行守卫），成员列表允许扩展
    expect(inputBarSource).toMatch(
      /import\s*\{[^}]*registerBackHandler[^}]*BACK_PRIORITY[^}]*\}\s*from\s*'@\/app\/navigation\/androidBackCoordinator'/
    );
    // 移动端 + 有面板打开才注册；handler 关闭全部组合面板并消费事件
    expect(inputBarSource).toMatch(
      /if \(!isMobile \|\| !hasAnyPanelOpen\) return;[\s\S]*?return registerBackHandler\(\(\) => \{[\s\S]*?closeAllPanelsRef\.current\(\);[\s\S]*?return true;[\s\S]*?\}, BACK_PRIORITY\.overlay\);/
    );
  });
});
