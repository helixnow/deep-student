/**
 * 0824 Wave2-C R4「读屏顺序」运行时断言：移动端内联面板展开后的
 * region 语义与 Tab（DOM）顺序。
 *
 * 与 ComposerInlinePanel.focusOrder.source.test.ts 配套：
 * - 本文件只覆盖当前应为绿的运行时行为（open 面板的 region/aria-label、
 *   无 inert/aria-hidden 祖先、DOM 顺序 = Tab 顺序）；
 * - closing/closed 时 inert 的断言留在 source 测试里（卡 3 落地后转绿），
 *   避免本文件在卡 3 之前红掉。
 *
 * 实际 Tab 顺序（源码 DOM 顺序，自上而下）：
 *   打开的内联面板 → 输入区 textarea → 底部工具栏（发送按钮）
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
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

// 📱 移动端布局断点：内联面板只在移动端渲染
vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: true,
    isFullscreenContent: false,
  }),
}));

function renderInputBar(overrides: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  const props: React.ComponentProps<typeof InputBarUI> = {
    inputValue: '',
    canSend: false,
    canAbort: false,
    isStreaming: false,
    attachments: [],
    panelStates: createDefaultPanelStates(),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onAddAttachment: vi.fn(),
    onUpdateAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments: vi.fn(),
    onSetPanelState: vi.fn(),
    placeholder: '输入消息',
    ...overrides,
  };

  return render(<InputBarUI {...props} />);
}

function panelStatesWith(open: Partial<PanelStates>): PanelStates {
  return { ...createDefaultPanelStates(), ...open };
}

/** a 在文档序上位于 b 之前（Tab 无正 tabindex 时即 Tab 顺序） */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function getOpenInlinePanelRegion(root: HTMLElement): HTMLElement {
  const inlineWrapper = root.querySelector<HTMLElement>(
    '[data-composer-panel-inline="attachment"]'
  );
  expect(inlineWrapper).not.toBeNull();
  // useDeferredOpen 初帧为 opening，rAF 后到 open；两者都属于展开态
  expect(['opening', 'open']).toContain(inlineWrapper!.getAttribute('data-panel-motion'));
  const region = inlineWrapper!.querySelector<HTMLElement>('[role="region"]');
  expect(region).not.toBeNull();
  return region!;
}

describe('ComposerInlinePanel focus order & screen reader semantics (runtime)', () => {
  it('exposes the OPEN inline panel as a labelled region, not hidden from AT', () => {
    renderInputBar({ panelStates: panelStatesWith({ attachment: true }) });

    const root = screen.getByTestId('input-bar-v2-root');
    const region = getOpenInlinePanelRegion(root);

    // region 必须有非空 aria-label（读屏地标可命名、可跳转）
    const label = region.getAttribute('aria-label');
    expect(label?.trim()).toBeTruthy();

    // 展开中的面板不允许被任何祖先 inert / aria-hidden 抠掉
    expect(region.closest('[inert]')).toBeNull();
    expect(region.closest('[aria-hidden="true"]')).toBeNull();
    expect(region.getAttribute('aria-hidden')).not.toBe('true');
  });

  it('keeps DOM (= tab) order: inline panel → textarea → toolbar send button', () => {
    renderInputBar({ panelStates: panelStatesWith({ attachment: true }) });

    const root = screen.getByTestId('input-bar-v2-root');
    const region = getOpenInlinePanelRegion(root);
    const textarea = screen.getByTestId('input-bar-v2-textarea');
    const sendButton = screen.getByTestId('btn-send');

    // 面板里必须真的有可聚焦控件，顺序断言才落在真实 Tab 停靠点上
    // （附件面板空态也有"添加文件/更多"等按钮），而不是只断言按钮存在
    const focusableInPanel = region.querySelector(
      'button, [href], input, select, textarea, [tabindex]'
    );
    expect(focusableInPanel).not.toBeNull();

    // 实际源码 DOM 顺序：内联面板在输入区上方长出 →
    // Tab 依次经过 面板内控件 → 输入 textarea → 工具栏（发送按钮收尾）
    expect(precedes(region, textarea)).toBe(true);
    expect(precedes(textarea, sendButton)).toBe(true);
    expect(precedes(focusableInPanel!, textarea)).toBe(true);

    // 没有正 tabindex 重排：Tab 顺序即上面断言的 DOM 顺序
    const positiveTabIndexes = Array.from(root.querySelectorAll('[tabindex]')).filter(
      (el) => Number(el.getAttribute('tabindex')) > 0
    );
    expect(positiveTabIndexes).toEqual([]);
  });
});
