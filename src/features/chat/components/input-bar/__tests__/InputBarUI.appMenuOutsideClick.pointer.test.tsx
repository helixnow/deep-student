/**
 * 附件面板「更多」菜单（AppMenu）pointerdown→pointerup→click 全链回归测试（卡 1）
 *
 * 【修复前应红 / 修复后应绿】
 * 基线 98bbf3f1 上：InputBarUI 的 document 级 pointerdown 外点监听
 * （handleClickOutside）只豁免 panelContainerRef / composerPanelOverlayRef /
 * inputContainerRef 三个容器；而 AppMenu 的内容层 createPortal 到 document.body
 * （带 data-app-menu-id 属性），不在任何一个豁免容器内。于是在菜单项上按下
 * （pointerdown）的瞬间就触发 closeAllPanels() → onSetPanelState('attachment', false)，
 * 附件面板在 click 之前被关掉，菜单项的动作（资源库 / 拍照 / 全部清除）永远
 * 到不了 click。本文件的用例在基线上应为红；卡 1 落地（外点判定豁免
 * closest('[data-app-menu-id]') 命中的 portal 节点）后应为绿。
 *
 * 父代理本轮不跑测试，本文件只提交源码，未执行。
 *
 * 覆盖两条路径（保守哲学，不做「按钮存在」式弱断言）：
 * 1. 真实菜单路径：打开 attachment 内联面板 → 点开「更多」AppMenu →
 *    在真实 portal 菜单项上 dispatch pointerdown（document 监听会收到）→
 *    断言面板未被 pointerdown 关闭 → pointerup + click → 断言对应动作被调用。
 * 2. 合成 portal 节点路径：手动往 document.body 挂 [data-app-menu-id] 节点，
 *    只测外点判定本身（不依赖 AppMenu 在 jsdom 里的完整渲染）。
 * 另附 source 契约（R9 随机制修订）：豁免字面量已收敛为常量 + 归属注册表——
 * COMPOSER_OWNED_OVERLAY_SELECTOR = '[data-app-menu-id]'，谓词
 * isWithinComposerTerritory 走 isOwnedOverlayTarget(ownerId, node) 查询，
 * 并保留 node.closest(COMPOSER_OWNED_OVERLAY_SELECTOR) 作 fail-open 回退。
 * 契约认常量与注册表调用，不再锁内联 closest('[data-app-menu-id]') 形态。
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { AttachmentMeta, PanelStates } from '../../../core/types/common';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

// 📱 移动端布局断点：走内联面板 + 折叠「更多」菜单（P1-4）分支
vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: true,
    isFullscreenContent: false,
  }),
}));

// 设备能力 → canCapturePhoto=true，让「拍照」菜单项出现。
// R3 能力三分离后拍照入口不再走 pointer: coarse 媒体查询（jsdom 的 UA 非
// Android/iOS 会判 false），改 mock 能力模块本身。
vi.mock('../inputBarCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inputBarCapabilities')>();
  return { ...actual, canCapturePhoto: () => true };
});

function panelStatesWith(open: Partial<PanelStates>): PanelStates {
  return { ...createDefaultPanelStates(), ...open };
}

/** 无 sourceId / 无 blob previewUrl：清除路径不会触碰 cancelPdfProcessing / revokeObjectURL */
const plainAttachment: AttachmentMeta = {
  id: 'att_doc',
  name: '讲义.txt',
  type: 'document',
  mimeType: 'text/plain',
  size: 512,
  status: 'ready',
};

function renderInputBar(overrides: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  const onSetPanelState = vi.fn();
  const onClearAttachments = vi.fn();
  const props: React.ComponentProps<typeof InputBarUI> = {
    inputValue: '',
    canSend: false,
    canAbort: false,
    isStreaming: false,
    attachments: [],
    panelStates: panelStatesWith({ attachment: true }),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onAddAttachment: vi.fn(),
    onUpdateAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments,
    onSetPanelState,
    placeholder: '输入消息',
    ...overrides,
  };

  render(<InputBarUI {...props} />);
  return { onSetPanelState, onClearAttachments };
}

/**
 * 打开附件面板头部的「更多」AppMenu，并校验内容层确实是 body 上的
 * [data-app-menu-id] portal（即 pointerdown 目标位于 InputBarUI 三个
 * 豁免容器之外 —— 正是基线 bug 的触发前提）。
 */
function openAttachmentMoreMenu() {
  const root = screen.getByTestId('input-bar-v2-root');
  const inlinePanel = root.querySelector('[data-composer-panel-inline="attachment"]');
  expect(inlinePanel).not.toBeNull();

  fireEvent.click(screen.getByTestId('attachment-panel-more'));

  const menu = screen.getByRole('menu');
  expect(menu).toHaveAttribute('data-app-menu-id');
  // portal 直接挂在 body 上（附件面板树里没有 [data-overlay-container] 祖先），
  // 不在 input-bar 根节点内 → document 级 pointerdown 监听按基线逻辑会判为"外点"
  expect(menu.parentElement).toBe(document.body);
  expect(root.contains(menu)).toBe(false);

  return { root, menu, items: within(menu).getAllByRole('menuitem') };
}

/** 手工构造带 type 的指针事件：不依赖 jsdom 是否实现 PointerEvent 构造器 */
function firePointer(el: Element, type: 'pointerdown' | 'pointerup') {
  return fireEvent(
    el,
    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true })
  );
}

/**
 * 核心红/绿断言：pointerdown 落在菜单项上之后，面板不能被 closeAllPanels 关闭。
 * panelStates 是受控 prop，「被关闭」的可观测信号就是 onSetPanelState('attachment', false)。
 * 基线 98bbf3f1：pointerdown 即触发该调用 → 断言失败（红）。
 */
function expectPanelSurvivedPointerDown(
  root: HTMLElement,
  onSetPanelState: ReturnType<typeof vi.fn>,
) {
  expect(onSetPanelState).not.toHaveBeenCalledWith('attachment', false);
  expect(root.querySelector('[data-composer-panel-inline="attachment"]')).not.toBeNull();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('InputBarUI attachment more-menu pointer chain (卡1 修复前红/修复后绿)', () => {
  it('sanity: a genuine outside pointerdown still closes the attachment panel', () => {
    // 反向对照（基线与修复后都应绿）：证明 document 级 pointerdown 监听
    // 在本 harness 里确实生效，防止主用例因监听未挂载而假绿。
    const { onSetPanelState } = renderInputBar();

    firePointer(document.body, 'pointerdown');

    expect(onSetPanelState).toHaveBeenCalledWith('attachment', false);
  });

  it('资源库: pointerdown on the real menu item keeps the panel alive, then click fires CHAT_TOGGLE_PANEL', () => {
    const { onSetPanelState } = renderInputBar();
    const { root, items } = openAttachmentMoreMenu();

    // AttachmentPanelBody 移动端「更多」菜单源码顺序：资源库 → 拍照 → 全部清除
    const resourceItem = items[0];

    const onToggleResourcePanel = vi.fn();
    window.addEventListener(COMMAND_EVENTS.CHAT_TOGGLE_PANEL, onToggleResourcePanel);
    try {
      firePointer(resourceItem, 'pointerdown');

      // 基线红点：pointerdown 已经 closeAllPanels
      expectPanelSurvivedPointerDown(root, onSetPanelState);
      expect(resourceItem.isConnected).toBe(true);

      firePointer(resourceItem, 'pointerup');
      fireEvent.click(resourceItem);

      // handleOpenResourceLibrary → window.dispatchEvent(CHAT_TOGGLE_PANEL)
      expect(onToggleResourcePanel).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(COMMAND_EVENTS.CHAT_TOGGLE_PANEL, onToggleResourcePanel);
    }
  });

  it('拍照: pointerdown→pointerup→click on the camera item triggers the hidden camera input', () => {
    const { onSetPanelState } = renderInputBar();
    const { root, items } = openAttachmentMoreMenu();

    // canCapturePhoto=true（能力模块 mock）时源码顺序第二项是「拍照」
    expect(items.length).toBeGreaterThanOrEqual(2);
    const cameraItem = items[1];
    expect(cameraItem.classList.contains('app-menu-item-destructive')).toBe(false);

    const cameraInput = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/*"][capture]'
    );
    expect(cameraInput).not.toBeNull();
    const onCameraInputClick = vi.fn();
    cameraInput!.addEventListener('click', onCameraInputClick);
    try {
      firePointer(cameraItem, 'pointerdown');

      expectPanelSurvivedPointerDown(root, onSetPanelState);
      expect(cameraItem.isConnected).toBe(true);

      firePointer(cameraItem, 'pointerup');
      fireEvent.click(cameraItem);

      // handleCameraClick → cameraInputRef.current.click()
      expect(onCameraInputClick).toHaveBeenCalledTimes(1);
    } finally {
      cameraInput!.removeEventListener('click', onCameraInputClick);
    }
  });

  it('全部清除: pointerdown→pointerup→click on the destructive item calls onClearAttachments', () => {
    const { onSetPanelState, onClearAttachments } = renderInputBar({
      attachments: [plainAttachment],
    });
    const { root, items } = openAttachmentMoreMenu();

    // 「全部清除」是唯一 destructive 菜单项（attachments.length > 0 时渲染）
    const clearItem = items.find((item) => item.classList.contains('app-menu-item-destructive'));
    expect(clearItem).toBeDefined();

    firePointer(clearItem!, 'pointerdown');

    expectPanelSurvivedPointerDown(root, onSetPanelState);
    expect(clearItem!.isConnected).toBe(true);

    firePointer(clearItem!, 'pointerup');
    fireEvent.click(clearItem!);

    expect(onClearAttachments).toHaveBeenCalledTimes(1);
  });

  it('外点判定: pointerdown inside a synthetic [data-app-menu-id] body portal must not close panels', () => {
    // 不依赖 AppMenu 完整渲染的兜底路径：直接往 body 挂 portal 节点测判定本身
    const { onSetPanelState } = renderInputBar();

    const portalNode = document.createElement('div');
    portalNode.setAttribute('data-app-menu-id', 'synthetic-menu');
    const innerButton = document.createElement('button');
    portalNode.appendChild(innerButton);
    document.body.appendChild(portalNode);
    try {
      // 命中 portal 内层节点（closest 向上找 [data-app-menu-id]）
      firePointer(innerButton, 'pointerdown');

      expect(onSetPanelState).not.toHaveBeenCalledWith('attachment', false);
    } finally {
      portalNode.remove();
    }
  });
});

describe('InputBarUI outside-click source contract (卡1)', () => {
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );

  it('keeps the panel outside-close listener on document pointerdown', () => {
    expect(inputBarSource).toContain(
      "document.addEventListener('pointerdown', handleClickOutside)"
    );
  });

  it('exempts [data-app-menu-id] portal targets inside handleClickOutside', () => {
    // 卡 1 最终落地形态（R9 修订）：外点处理经由统一谓词
    // isWithinComposerTerritory（与焦点门控共用）；豁免不再是内联
    // closest('[data-app-menu-id]')，而是常量 COMPOSER_OWNED_OVERLAY_SELECTOR
    // + OverlayCoordinator 归属查询 isOwnedOverlayTarget，closest(常量) 保留为
    // fail-open 回退。契约分三段锁：handler 必须走谓词；谓词必须同时保留
    // 归属查询与 closest 回退；selector 常量必须仍指向 [data-app-menu-id]。
    const handlerMatch = inputBarSource.match(
      /const handleClickOutside[\s\S]*?closeAllPanels\(\);\s*\};/
    );
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch![0]).toContain('isWithinComposerTerritory(e.target as Node)');

    // 谓词切片：deps 数组内容不锁死（已从 [] 漂移为 [isOwnedOverlayTarget]，
    // 后续再变也不该让本契约空转失锚）
    const predicateMatch = inputBarSource.match(
      /const isWithinComposerTerritory[\s\S]*?\},\s*\[[^\]]*\]\);/
    );
    expect(predicateMatch).not.toBeNull();
    const predicateSlice = predicateMatch![0];
    expect(predicateSlice).toContain('isOwnedOverlayTarget(COMPOSER_OVERLAY_OWNER_ID, node)');
    expect(predicateSlice).toContain('node.closest(COMPOSER_OWNED_OVERLAY_SELECTOR)');

    // 常量→字面量的最后一跳：selector 改指别处时上两段仍绿，这里兜底
    expect(inputBarSource).toMatch(
      /COMPOSER_OWNED_OVERLAY_SELECTOR\s*=\s*['"`]\[data-app-menu-id\]['"`]/
    );
  });
});
