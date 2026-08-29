/**
 * Android 返回键序列集成测试：菜单开 → back → 面板仍开 → back → 面板关
 * （0824 Wave2-C 第 2 轮 · 测试-back 链）
 *
 * 场景（移动端 Chat 页真实层级）：
 * 1. InputBarUI 组合面板（attachment）打开 → InputBarUI 注册 overlay handler
 * 2. 其上再打开 AppMenu → AppMenu 注册 overlay handler（后注册，栈顶）
 * 3. 第一次 handleAndroidBack()：只关菜单，面板必须仍开
 * 4. 第二次 handleAndroidBack()：关面板
 * 5. 第三次 handleAndroidBack()：无人消费，返回 false（native moveTaskToBack）
 *
 * 修复前预期（回归场景，任一条命中即本测试失败）：
 * - AppMenu 是自绘浮层（非 Radix），协调器的 Escape 兜底探测不到它；若
 *   AppMenu 未注册 handler，第一次 back 会越过打开中的菜单直接命中
 *   InputBarUI 的面板 handler——「菜单还开着，底下的面板先被关了」。
 * - 若 InputBarUI 未注册 handler，第二次 back 无人消费直接落回 native，
 *   「面板还开着，应用先退后台」。
 * - 若协调器同优先级按 FIFO 排序，第一次 back 先关面板、菜单残留，层级颠倒。
 *
 * 修复后预期（本文件断言）：真实组件（非 mock handler）通过
 * registerBackHandler 接入协调器，两次 back 严格按「后开先关」出栈，
 * 第三次 back 交还 native。
 *
 * jsdom 适配说明：AppMenu 的 handler 带离屏让行守卫
 * `el.offsetParent === null → return false`（宿主视图被隐藏时不吞返回键）。
 * jsdom 不做布局、offsetParent 恒为 null，会让菜单 handler 永远让行、
 * 测不到目标路径；本文件把 offsetParent stub 成 parentElement（已挂载
 * 即视为在屏）。守卫本身的存在由
 * androidBackCoordinator.menuThenPanel.test.ts 的 source 契约锁定。
 *
 * 面板开关探针说明（R9 修订）：InputBarUI 的 useDeferredOpen 在面板关闭后
 * 仍保留节点 220ms 做退场动画（data-panel-motion="closing"，之后才卸载），
 * 「节点是否在 DOM」不能当「面板是否打开」——back 关面板后的瞬间节点必然
 * 还在。探针改看 data-panel-motion：open/opening 为开，closing/closed/已卸载
 * 为关（与 ComposerInlinePanel.focusOrder.test.tsx 的展开态判定一致）。
 */

import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
import { AppMenu } from '@/components/ui/app-menu/AppMenu';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { PanelStates } from '../../../core/types/common';

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

// 📱 移动端布局断点：InputBarUI 只在 isMobile 时注册返回键 handler
vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: true,
    isFullscreenContent: false,
  }),
}));

// jsdom 无布局：offsetParent 恒为 null 会触发 AppMenu handler 的离屏让行
// 守卫。已挂载元素一律视为在屏（返回 parentElement），守卫的 inert 分支
// 不受影响（closest('[inert]') 在 jsdom 可用）。
const originalOffsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetParent'
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
});

afterAll(() => {
  if (originalOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent);
  }
});

interface HarnessHandle {
  openMenu: () => void;
}

function createInputBarProps(): Omit<
  React.ComponentProps<typeof InputBarUI>,
  'panelStates' | 'onSetPanelState'
> {
  return {
    inputValue: '',
    canSend: false,
    canAbort: false,
    isStreaming: false,
    attachments: [],
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onAddAttachment: vi.fn(),
    onUpdateAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments: vi.fn(),
    placeholder: '输入消息',
  };
}

/**
 * 有状态 harness：受控托管 InputBarUI 的 panelStates 与 AppMenu 的 open，
 * 让组件自身的「打开时注册 / 关闭时注销」effect 走真实生命周期。
 * 初始态：attachment 面板已开（InputBarUI 先注册），菜单关闭。
 */
function Harness({ handleRef }: { handleRef: React.MutableRefObject<HarnessHandle | null> }) {
  const [panelStates, setPanelStates] = React.useState<PanelStates>(() => ({
    ...createDefaultPanelStates(),
    attachment: true,
  }));
  const [menuOpen, setMenuOpen] = React.useState(false);

  handleRef.current = {
    openMenu: () => setMenuOpen(true),
  };

  const setPanelState = React.useCallback((panel: keyof PanelStates, open: boolean) => {
    setPanelStates((prev) => ({ ...prev, [panel]: open }));
  }, []);

  return (
    <div>
      <span data-testid="menu-open">{String(menuOpen)}</span>
      <AppMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <button type="button">menu trigger</button>
      </AppMenu>
      <InputBarUI
        {...createInputBarProps()}
        panelStates={panelStates}
        onSetPanelState={setPanelState}
      />
    </div>
  );
}

function isAttachmentPanelOpen(): boolean {
  const root = screen.getByTestId('input-bar-v2-root');
  const panel = root.querySelector('[data-composer-panel-inline="attachment"]');
  if (!panel) return false;
  // 收起动画期（closing）节点仍在 DOM，但语义上面板已关（见文件头 R9 修订说明）
  const motion = panel.getAttribute('data-panel-motion');
  return motion === 'open' || motion === 'opening';
}

function isMenuOpen(): boolean {
  return screen.getByTestId('menu-open').textContent === 'true';
}

describe('InputBarUI × AppMenu Android 返回键序列（后开先关）', () => {
  it('菜单开→back→面板仍开→back→面板关→back 交还 native', () => {
    const handleRef: React.MutableRefObject<HarnessHandle | null> = { current: null };
    render(<Harness handleRef={handleRef} />);

    // 前置：附件面板已开（InputBarUI 的 overlay handler 已注册），菜单未开
    expect(isAttachmentPanelOpen()).toBe(true);
    expect(isMenuOpen()).toBe(false);

    // 步骤 2：面板之上再打开 AppMenu（AppMenu 的 overlay handler 后注册，位于栈顶）
    act(() => {
      handleRef.current!.openMenu();
    });
    expect(isMenuOpen()).toBe(true);
    expect(isAttachmentPanelOpen()).toBe(true);

    // 步骤 3：第一次 back —— 只关菜单，面板必须仍开
    let consumed = false;
    act(() => {
      consumed = handleAndroidBack();
    });
    expect(consumed).toBe(true);
    expect(isMenuOpen()).toBe(false);
    expect(isAttachmentPanelOpen()).toBe(true);

    // 步骤 4：第二次 back —— 关面板（菜单 handler 已随关闭注销，不得再吞事件）
    act(() => {
      consumed = handleAndroidBack();
    });
    expect(consumed).toBe(true);
    expect(isMenuOpen()).toBe(false);
    expect(isAttachmentPanelOpen()).toBe(false);

    // 步骤 5：全部浮层已关，第三次 back 前端不消费（native moveTaskToBack）
    act(() => {
      consumed = handleAndroidBack();
    });
    expect(consumed).toBe(false);
  });

  it('只开面板不开菜单：一次 back 直接关面板', () => {
    const handleRef: React.MutableRefObject<HarnessHandle | null> = { current: null };
    render(<Harness handleRef={handleRef} />);

    expect(isAttachmentPanelOpen()).toBe(true);

    let consumed = false;
    act(() => {
      consumed = handleAndroidBack();
    });
    expect(consumed).toBe(true);
    expect(isAttachmentPanelOpen()).toBe(false);

    // handler 已随面板关闭注销：再 back 不消费
    act(() => {
      consumed = handleAndroidBack();
    });
    expect(consumed).toBe(false);
  });
});
