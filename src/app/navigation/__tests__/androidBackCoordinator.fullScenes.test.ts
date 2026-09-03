/**
 * Android 返回键协调器全场景矩阵（0824 Wave2-C 第 7 轮 · 测试员-back）
 *
 * 与既有两份测试的分工：
 * - menuThenPanel.test.ts：菜单叠面板序列 + AppMenu/InputBarUI 注册点 source 契约；
 * - order.source.test.ts：排序表达式与注册点的源码契约；
 * - 本文件：以纯函数 mock handler 驱动 handleAndroidBack()，把六类运行时
 *   场景铺成一张矩阵，逐一锁死分发语义（不渲染任何产品组件）：
 *     1. 仅面板开：back 关面板并消费；再 back 交还 native（false）。
 *     2. 仅菜单开：同上（菜单与面板同为 overlay 档，行为对称）。
 *     3. 菜单 + 面板叠开：LIFO——先关后开的菜单、面板仍开；三按序列
 *        true/true/false。
 *     4. visibility 守卫让行：registerVisibilityGuardedBackHandler 的宿主
 *        元素不可见（断连 / 无布局盒 / visibility:hidden）时 handler 返回
 *        false 让行，事件继续沿栈下发；可见时正常消费。
 *     5. Radix 让行（Escape 兜底）：未显式注册 handler 的 Radix 浮层
 *        （role="dialog"[data-state="open"] 等）在 view/navigation 档之前
 *        被 Escape 兜底关闭；显式 overlay handler 仍最先执行；
 *        hasOpenRadixOverlayBesides 支撑「全屏 Sheet 容器给上层浮层让行」。
 *     6. 无 handler：空栈且无打开浮层时返回 false（native moveTaskToBack）。
 *
 * jsdom 注意事项（影响断言写法）：
 * - jsdom 不做布局，任何元素 getClientRects() 恒为空列表 →
 *   isElementVisibleForBack 对「可见」宿主的判定必须 stub getClientRects；
 *   反过来，「无布局盒」场景无需 stub，jsdom 默认即命中。
 * - dismissTopOverlayViaEscape 把 Escape 派发到 document.activeElement
 *   （jsdom 下默认 body）并冒泡到 document——本文件用 document 级 keydown
 *   监听器模拟 Radix 的关闭行为。
 *
 * 本轮只写不跑（禁 vitest 执行）；基线 androidBackCoordinator.ts@0f5435a7。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACK_PRIORITY,
  handleAndroidBack,
  hasOpenRadixOverlayBesides,
  isElementVisibleForBack,
  registerBackHandler,
  registerVisibilityGuardedBackHandler,
} from '../androidBackCoordinator';

// ---------------------------------------------------------------------------
// 协调器持有模块级 handler 栈；每个用例注册的 handler 统一登记、用例结束后
// 全部注销。DOM 侧（Radix 假浮层、document 监听器）同样统一回收，
// 避免跨用例污染（断言失败提前 return 时也能清干净）。
// ---------------------------------------------------------------------------
const cleanups: Array<() => void> = [];

function track<T extends () => void>(cleanup: T): T {
  cleanups.push(cleanup);
  return cleanup;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  document.body.innerHTML = '';
});

/**
 * 模拟一个「打开中的 overlay」（面板 / 菜单通用）：
 * - open=true 时 handler 关闭自身并消费事件（返回 true）；
 * - 关闭动作同步注销 handler（对应组件 open=false 的 effect cleanup）；
 * - 若关闭后仍被调用（陈旧 handler 场景）返回 false 让行。
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

  return { handler, isOpen: () => open };
}

/** 挂到 body 且带非空布局盒的元素（jsdom 需手动 stub getClientRects） */
function mountVisibleElement(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.getClientRects = () =>
    [{ width: 10, height: 10 } as DOMRect] as unknown as DOMRectList;
  return el;
}

/**
 * 模拟一个未显式注册 back handler 的 Radix Dialog：
 * role="dialog" + data-state="open"，并在 document 上挂 Escape 监听器
 * 模拟 Radix 自身的关闭逻辑（收到 Escape → data-state 置 closed）。
 */
function mountRadixDialog() {
  const el = document.createElement('div');
  el.setAttribute('role', 'dialog');
  el.setAttribute('data-state', 'open');
  document.body.appendChild(el);

  const escapesSeen: string[] = [];
  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    escapesSeen.push(key);
    if (key === 'Escape') el.setAttribute('data-state', 'closed');
  };
  document.addEventListener('keydown', onKeyDown);
  track(() => document.removeEventListener('keydown', onKeyDown));

  return {
    element: el,
    escapesSeen,
    isOpen: () => el.getAttribute('data-state') === 'open',
  };
}

// ---------------------------------------------------------------------------
// 场景 1 / 2：单一 overlay（仅面板 / 仅菜单）
// ---------------------------------------------------------------------------
describe('场景 1 · 仅面板开', () => {
  it('第一次 back 关面板并消费，第二次 back 交还 native', () => {
    const calls: string[] = [];
    const panel = createOverlay('panel', calls);

    expect(handleAndroidBack()).toBe(true);
    expect(panel.isOpen()).toBe(false);
    expect(calls).toEqual(['panel']);

    // handler 已随关闭注销：第二次 back 空栈 + 无浮层 → false
    expect(handleAndroidBack()).toBe(false);
    expect(panel.handler).toHaveBeenCalledTimes(1);
  });
});

describe('场景 2 · 仅菜单开', () => {
  it('与面板行为对称：关菜单消费一次，随后交还 native', () => {
    const calls: string[] = [];
    const menu = createOverlay('menu', calls);

    expect(handleAndroidBack()).toBe(true);
    expect(menu.isOpen()).toBe(false);
    expect(calls).toEqual(['menu']);

    expect(handleAndroidBack()).toBe(false);
    expect(menu.handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 场景 3：菜单 + 面板叠开（LIFO 栈语义）
// ---------------------------------------------------------------------------
describe('场景 3 · 菜单叠面板', () => {
  it('三按序列：先关后开的菜单（面板不被触碰）→ 关面板 → 交还 native', () => {
    const calls: string[] = [];
    // 注册顺序即打开顺序：先开面板，再开菜单
    const panel = createOverlay('panel', calls);
    const menu = createOverlay('menu', calls);

    expect(handleAndroidBack()).toBe(true);
    expect(calls).toEqual(['menu']);
    expect(menu.isOpen()).toBe(false);
    expect(panel.isOpen()).toBe(true);
    expect(panel.handler).not.toHaveBeenCalled();

    expect(handleAndroidBack()).toBe(true);
    expect(calls).toEqual(['menu', 'panel']);
    expect(panel.isOpen()).toBe(false);
    // 菜单 handler 已注销，第二次 back 不允许再命中它
    expect(menu.handler).toHaveBeenCalledTimes(1);

    expect(handleAndroidBack()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 场景 4：visibility 守卫让行
// ---------------------------------------------------------------------------
describe('场景 4 · visibility 守卫', () => {
  it('isElementVisibleForBack 判定矩阵：null / 断连 / 无布局盒 / hidden / 可见', () => {
    expect(isElementVisibleForBack(null)).toBe(false);

    const detached = document.createElement('div');
    expect(isElementVisibleForBack(detached)).toBe(false);

    // 已连接但无布局盒（jsdom 默认 getClientRects 为空，等价 display:none）
    const zeroRects = document.createElement('div');
    document.body.appendChild(zeroRects);
    expect(isElementVisibleForBack(zeroRects)).toBe(false);

    // visibility:hidden 不清除布局盒 —— 有 rects 也必须判不可见
    const hidden = mountVisibleElement();
    hidden.style.visibility = 'hidden';
    expect(isElementVisibleForBack(hidden)).toBe(false);

    const visible = mountVisibleElement();
    expect(isElementVisibleForBack(visible)).toBe(true);
  });

  it('宿主不可见时守卫 handler 让行，事件下发给低优先级 handler', () => {
    const calls: string[] = [];
    track(
      registerBackHandler(() => {
        calls.push('navigation');
        return true;
      }, BACK_PRIORITY.navigation)
    );

    // 保活隐藏层（后台标签页）的浮层：宿主无布局盒
    const offscreenHost = document.createElement('div');
    document.body.appendChild(offscreenHost);
    const guarded = vi.fn(() => {
      calls.push('guarded');
      return true;
    });
    track(
      registerVisibilityGuardedBackHandler(
        { current: offscreenHost },
        guarded,
        BACK_PRIORITY.overlay
      )
    );

    expect(handleAndroidBack()).toBe(true);
    // 守卫在包装层直接让行：业务 handler 根本不被调用
    expect(guarded).not.toHaveBeenCalled();
    expect(calls).toEqual(['navigation']);
  });

  it('宿主可见时守卫 handler 正常消费，且保持 overlay 档栈序', () => {
    const calls: string[] = [];
    const lower = vi.fn(() => {
      calls.push('lower');
      return true;
    });
    track(registerBackHandler(lower, BACK_PRIORITY.overlay));

    const host = mountVisibleElement();
    const guarded = vi.fn(() => {
      calls.push('guarded');
      return true;
    });
    track(
      registerVisibilityGuardedBackHandler({ current: host }, guarded)
    );

    // 后注册的守卫 handler 先执行（栈语义与 registerBackHandler 一致）
    expect(handleAndroidBack()).toBe(true);
    expect(calls).toEqual(['guarded']);
    expect(lower).not.toHaveBeenCalled();
  });

  it('宿主中途变为 hidden：同一注册从消费转为让行', () => {
    const calls: string[] = [];
    track(
      registerBackHandler(() => {
        calls.push('fallback');
        return true;
      }, BACK_PRIORITY.navigation)
    );

    const host = mountVisibleElement();
    const guarded = vi.fn(() => {
      calls.push('guarded');
      return true;
    });
    track(registerVisibilityGuardedBackHandler({ current: host }, guarded));

    expect(handleAndroidBack()).toBe(true);
    expect(calls).toEqual(['guarded']);

    // 视图切走：visibility:hidden（布局盒仍在）
    host.style.visibility = 'hidden';
    expect(handleAndroidBack()).toBe(true);
    expect(calls).toEqual(['guarded', 'fallback']);
    expect(guarded).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 场景 5：Radix 浮层 Escape 兜底与让行
// ---------------------------------------------------------------------------
describe('场景 5 · Radix 兜底让行', () => {
  it('未显式注册的 Radix dialog 先于 view/navigation handler 被 Escape 关闭', () => {
    const dialog = mountRadixDialog();
    const view = vi.fn(() => true);
    track(registerBackHandler(view, BACK_PRIORITY.view));

    // 第一次 back：兜底探测命中 → 派发 Escape → 消费；view 不被触碰
    expect(handleAndroidBack()).toBe(true);
    expect(dialog.escapesSeen).toEqual(['Escape']);
    expect(dialog.isOpen()).toBe(false);
    expect(view).not.toHaveBeenCalled();

    // 浮层已关（data-state=closed 不再匹配选择器）：第二次 back 落到 view
    expect(handleAndroidBack()).toBe(true);
    expect(view).toHaveBeenCalledTimes(1);
    expect(dialog.escapesSeen).toEqual(['Escape']);
  });

  it('显式 overlay handler 仍最先执行，Radix 兜底不抢跑', () => {
    const dialog = mountRadixDialog();
    const calls: string[] = [];
    const menu = createOverlay('menu', calls);

    // overlay 档 handler 在前：菜单被关，Radix dialog 原样保持打开
    expect(handleAndroidBack()).toBe(true);
    expect(calls).toEqual(['menu']);
    expect(menu.isOpen()).toBe(false);
    expect(dialog.isOpen()).toBe(true);
    expect(dialog.escapesSeen).toEqual([]);
  });

  it('全部 handler 都是 overlay 档且都让行时，兜底探测在循环后补跑', () => {
    const dialog = mountRadixDialog();
    // 例如全屏 Settings Sheet 容器：发现上方还有 Radix 浮层 → 返回 false 让行
    const yieldingSheet = vi.fn(() => false);
    track(registerBackHandler(yieldingSheet, BACK_PRIORITY.overlay));

    expect(handleAndroidBack()).toBe(true);
    expect(yieldingSheet).toHaveBeenCalledTimes(1);
    expect(dialog.escapesSeen).toEqual(['Escape']);
    expect(dialog.isOpen()).toBe(false);
  });

  it('hasOpenRadixOverlayBesides：支撑容器「先关上层浮层再退自身」的让行判断', () => {
    const sheet = mountRadixDialog(); // 全屏 Sheet 容器自身也是 Radix dialog

    // 只有自己开着：不让行（该轮 back 应退出容器本身）
    expect(hasOpenRadixOverlayBesides(sheet.element)).toBe(false);

    // 其上叠了未注册的 Select 下拉等浮层：让行
    const dropdown = mountRadixDialog();
    expect(hasOpenRadixOverlayBesides(sheet.element)).toBe(true);

    // 上层浮层关闭后恢复不让行
    dropdown.element.setAttribute('data-state', 'closed');
    expect(hasOpenRadixOverlayBesides(sheet.element)).toBe(false);

    // 不传 excluded（null）时任何打开中的浮层都算数
    expect(hasOpenRadixOverlayBesides(null)).toBe(true);
  });

  it('非浮层的 data-state="open"（accordion 等）不触发兜底', () => {
    const accordion = document.createElement('div');
    accordion.setAttribute('data-state', 'open'); // 无 overlay role
    document.body.appendChild(accordion);

    expect(handleAndroidBack()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 场景 6：无 handler / 全员让行 → 交还 native
// ---------------------------------------------------------------------------
describe('场景 6 · 无人消费返回 false', () => {
  it('空栈且无打开浮层：返回 false（native moveTaskToBack）', () => {
    expect(handleAndroidBack()).toBe(false);
  });

  it('所有 handler 都返回 false 让行：逐个调用后仍返回 false', () => {
    const order: string[] = [];
    const overlay = vi.fn(() => {
      order.push('overlay');
      return false;
    });
    const view = vi.fn(() => {
      order.push('view');
      return false;
    });
    const navigation = vi.fn(() => {
      order.push('navigation');
      return false;
    });
    track(registerBackHandler(view, BACK_PRIORITY.view));
    track(registerBackHandler(navigation, BACK_PRIORITY.navigation));
    track(registerBackHandler(overlay, BACK_PRIORITY.overlay));

    expect(handleAndroidBack()).toBe(false);
    // 全链路按优先级降序走完，一个不漏
    expect(order).toEqual(['overlay', 'view', 'navigation']);
  });
});
