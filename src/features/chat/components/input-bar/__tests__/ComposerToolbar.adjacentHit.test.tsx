/**
 * 右簇相邻控件命中所有权（0824 Wave2-C R3 · TDD 先行 · jsdom 降级版）
 *
 * ⚠️ 预期状态：机制落地后应全部转绿。在基线 e90fb360 上，
 * 「rendered classNames」与「几何推演」两组断言预期为红——右簇仍用
 * after:-inset 伪元素扩区，相邻命中区互相压进对方（DOM 靠后者偷走点击）。
 * 「所有权 / 点击互不串扰」组在基线上也应为绿（机制只换命中实现，不动所有权）。
 *
 * 【jsdom 降级说明——不要假装测到真像素】
 * jsdom 不做布局：document.elementFromPoint 未实现、getBoundingClientRect 全 0、
 * ::after 伪元素不进 DOM，因此本文件**测不到真实像素命中**。降级策略：
 * 1. source/DOM 类名契约：断言真实渲染出的 className 中不再含 after:-inset
 *    （这是驱动伪元素扩区的唯一载体，类名不在 = 扩区不在）；
 * 2. getBoundingClientRect mock 几何推演：按 flex 契约（gap-2=8px、既有尺寸类）
 *    给右簇顶层项 mock 基础盒，再从**真实渲染的 className** 解析
 *    [@media(pointer:coarse)]:after:-inset-N 令牌推导有效命中盒，
 *    用「DOM 靠后者绘制在上」的绘制序命中模型验证相邻不重叠 / 不偷点。
 *    基础盒坐标是 mock 的，扩区量来自组件真实输出——测的是契约几何，不是渲染像素。
 * 真实像素级命中（含伪元素、真实字体宽度）归 Playwright CT / 设计走查负责。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposerToolbar } from '../ComposerToolbar';
import type { ComposerToolbarProps } from '../ComposerToolbar';
import type { ContextWindowUsage } from '../contextWindowUsage';

const { showGlobalNotificationMock } = vi.hoisted(() => ({
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

beforeAll(() => {
  // ThinkingDepthSlider 在 jsdom 下无 2D 上下文；返回 null 走无画布降级路径
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

const usageFixture: ContextWindowUsage = {
  usedTokens: 32_000,
  remainingTokens: 96_000,
  limitTokens: 128_000,
  usedPercent: 25,
  remainingPercent: 75,
  usedLabel: '32k',
  remainingLabel: '96k',
  source: 'api',
};

function renderToolbar(overrides: Partial<ComposerToolbarProps> = {}) {
  const props: ComposerToolbarProps = {
    isMobile: true,
    isMobileEnv: true,
    isStreaming: false,
    isPlusMenuOpen: false,
    onPlusMenuOpenChange: vi.fn(),
    attachmentCount: 0,
    onAddAttachment: vi.fn(),
    onOpenResourceLibrary: vi.fn(),
    onOpenCamera: vi.fn(),
    isCompactingContext: false,
    compactContextStatus: null,
    authorityMode: 'craft',
    permissionPreset: 'cautious',
    authorityAskBlockedHint: false,
    knowledgeBaseProactive: false,
    activeSkillCount: 0,
    hasLoadedSkills: true,
    mcpEnabled: false,
    selectedMcpServerCount: 0,
    sendShortcut: 'enter',
    isComposerEmpty: false,
    composerTextareaFocused: false,
    contextWindowUsage: usageFixture,
    runtimeModelTriggerRef: { current: null },
    onToggleThinking: vi.fn(),
    enableThinking: true,
    thinkingCanDisable: true,
    thinkingStateLabel: '推理: 高',
    thinkingDepthOptions: [
      { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
    ],
    thinkingDepthValue: 'high',
    onSetThinkingDepth: vi.fn(),
    runtimeModelOptions: [],
    hasModelPanel: true,
    onOpenRuntimeModelPanel: vi.fn(),
    onThinkingMenuWillOpen: vi.fn(),
    hasProcessingMedia: false,
    showStop: false,
    canAbort: false,
    onStop: vi.fn(),
    onSend: vi.fn(),
    disabledSend: false,
    ...overrides,
  };
  return { view: render(<ComposerToolbar {...props} />), props };
}

/** 元素（含 SVG）class 字符串，jsdom 下 SVG 的 className 不是 string */
const classOf = (el: Element): string => el.getAttribute('class') ?? '';

/** 从 cluster 直接子级中找到包含 target 的顶层项 */
function topLevelItem(target: Element, cluster: Element): Element {
  let current: Element = target;
  while (current.parentElement && current.parentElement !== cluster) {
    current = current.parentElement;
  }
  expect(current.parentElement).toBe(cluster);
  return current;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Tailwind 间距刻度 → px（-inset-2 = 8px，-inset-2.5 = 10px） */
const spacingToPx = (scale: string): number => Number.parseFloat(scale) * 4;

/**
 * 从项目子树的真实渲染 className 解析 coarse 触屏伪元素扩区量。
 * 近似：子孙元素的扩区一律按作用于项目外沿计（伪元素实际挂在子孙盒上，
 * 只会更小——该近似只会**放大**命中盒，不会漏报重叠）。
 */
function coarseAfterInsetExpansion(item: Element): { x: number; y: number } {
  const tokenPattern = /\[@media\(pointer:coarse\)\]:after:-inset(-x|-y)?-(\d+(?:\.\d+)?)/g;
  const plainPattern = /(?<!\S)after:-inset(-x|-y)?-(\d+(?:\.\d+)?)/g;
  let x = 0;
  let y = 0;
  for (const el of [item, ...item.querySelectorAll('*')]) {
    const className = classOf(el);
    for (const pattern of [tokenPattern, plainPattern]) {
      for (const match of className.matchAll(pattern)) {
        const px = spacingToPx(match[2]);
        const axis = match[1];
        if (axis !== '-y') x = Math.max(x, px);
        if (axis !== '-x') y = Math.max(y, px);
      }
    }
  }
  return { x, y };
}

const expandRect = (rect: Rect, x: number, y: number): Rect => ({
  left: rect.left - x,
  right: rect.right + x,
  top: rect.top - y,
  bottom: rect.bottom + y,
});

const rectContains = (rect: Rect, px: number, py: number): boolean =>
  px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;

describe('ComposerToolbar right-cluster adjacent hit ownership (jsdom)', () => {
  it('keeps every right-cluster control mounted with stable ownership structure', () => {
    renderToolbar();

    const ringTrigger = screen.getByTestId('context-usage-popover-trigger');
    const ringControl = screen.getByTestId('context-window-usage-control');
    const thinkingControl = screen.getByTestId('thinking-runtime-control');
    const thinkingTrigger = screen.getByTestId('thinking-runtime-menu-trigger');
    const sendButton = screen.getByTestId('btn-send');

    // 水位环命中所有权归 popover 触发器（环挂在触发器内，单一交互所有者）
    expect(ringTrigger.contains(ringControl)).toBe(true);
    expect(thinkingControl.contains(thinkingTrigger)).toBe(true);

    // 相邻控件互不嵌套：任何一个控件上的点击不可能冒泡激活邻居
    expect(ringTrigger.contains(thinkingControl)).toBe(false);
    expect(thinkingControl.contains(ringTrigger)).toBe(false);
    expect(thinkingControl.contains(sendButton)).toBe(false);
    expect(sendButton.contains(thinkingControl)).toBe(false);

    // DOM 顺序：水位环 → 推理触发器 → 发送
    expect(
      ringTrigger.compareDocumentPosition(thinkingControl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      thinkingControl.compareDocumentPosition(sendButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('routes clicks to exactly one owner without cross-talk', async () => {
    const user = userEvent.setup();

    // 独立渲染两次，避免推理菜单打开后的外点关闭逻辑干扰发送按钮断言
    const first = renderToolbar();
    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    expect(first.props.onThinkingMenuWillOpen).toHaveBeenCalledTimes(1);
    expect(first.props.onSend).not.toHaveBeenCalled();
    first.view.unmount();

    const second = renderToolbar();
    await user.click(screen.getByTestId('btn-send'));
    expect(second.props.onSend).toHaveBeenCalledTimes(1);
    expect(second.props.onThinkingMenuWillOpen).not.toHaveBeenCalled();
    expect(second.props.onStop).not.toHaveBeenCalled();
  });

  it('routes the stop button to onStop only, with real-size coarse targets (no pseudo expansion)', async () => {
    const user = userEvent.setup();
    const { props } = renderToolbar({ showStop: true, canAbort: true });

    const stopButton = screen.getByTestId('btn-stop');
    await user.click(stopButton);
    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();

    // 停止按钮已经是目标机制的样板：coarse 下实尺寸 44px，而非伪元素扩区
    expect(classOf(stopButton)).not.toContain('after:-inset');
  });

  it('keeps the disabled-send hint overlay exactly on top of the send button', async () => {
    const user = userEvent.setup();
    const { props } = renderToolbar({
      disabledSend: true,
      sendBlockedReason: '附件上传中，请稍候',
    });

    const hintOverlay = screen.getByTestId('btn-send-disabled-hint');
    // 覆盖层是发送按钮的刻意「同框所有者」：inset-0 与按钮完全同界，不得再外扩
    expect(classOf(hintOverlay)).toContain('inset-0');
    expect(classOf(hintOverlay)).not.toContain('after:-inset');

    await user.click(hintOverlay);
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('info', '附件上传中，请稍候');
    expect(props.onSend).not.toHaveBeenCalled();
  });

  // ── 以下两组在基线 e90fb360 上预期为红，机制落地后转绿 ──────────────────

  it('renders the right cluster without after:-inset classes outside the single ring owner', () => {
    renderToolbar();

    const thinkingControl = screen.getByTestId('thinking-runtime-control');
    const cluster = thinkingControl.parentElement!;
    const ringItem = topLevelItem(screen.getByTestId('context-usage-popover-trigger'), cluster);

    const expandedElements = [cluster, ...cluster.querySelectorAll('*')].filter((el) =>
      classOf(el).includes('after:-inset')
    );
    // 允许至多一处扩区，且只能出现在水位环子树内（单一所有者）；
    // 推理触发器 / 发送等其余右簇控件一律不得再挂伪元素扩区。
    // 基线：环子树 2 处（双重）+ 推理触发器 1 处 → 红。
    const outsideRingOwner = expandedElements.filter(
      (el) => el !== ringItem && !ringItem.contains(el)
    );
    expect(outsideRingOwner).toEqual([]);
    expect(expandedElements.length).toBeLessThanOrEqual(1);
  });

  it('keeps adjacent coarse hit rects non-overlapping in the contract geometry', () => {
    renderToolbar();

    const thinkingControl = screen.getByTestId('thinking-runtime-control');
    const cluster = thinkingControl.parentElement!;
    const items = [
      topLevelItem(screen.getByTestId('context-usage-popover-trigger'), cluster),
      topLevelItem(thinkingControl, cluster),
      topLevelItem(screen.getByTestId('btn-send'), cluster),
    ];

    // 基础盒按 flex 契约 mock（jsdom 无布局）：gap-2 = 8px、垂直居中；
    // 宽高取各控件的尺寸类：环 w-7/h-8=28×32、推理触发器约 96×32（max-w-[8rem] 内）、
    // 发送 coarse 44×44。坐标是推演值，扩区量才是被测对象（读真实 className）。
    const GAP = 8;
    const sizes = [
      { w: 28, h: 32 },
      { w: 96, h: 32 },
      { w: 44, h: 44 },
    ];
    const centerY = 22;
    let cursorX = 0;
    const baseRects: Rect[] = sizes.map(({ w, h }) => {
      const rect: Rect = {
        left: cursorX,
        right: cursorX + w,
        top: centerY - h / 2,
        bottom: centerY + h / 2,
      };
      cursorX = rect.right + GAP;
      return rect;
    });
    items.forEach((item, index) => {
      const base = baseRects[index];
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        x: base.left,
        y: base.top,
        left: base.left,
        right: base.right,
        top: base.top,
        bottom: base.bottom,
        width: base.right - base.left,
        height: base.bottom - base.top,
        toJSON: () => base,
      } as DOMRect);
    });

    // 有效命中盒 = mock 基础盒 + 从真实渲染 className 解析出的 coarse 伪元素扩区
    const hitRects = items.map((item) => {
      const base = item.getBoundingClientRect();
      const { x, y } = coarseAfterInsetExpansion(item);
      return expandRect(
        { left: base.left, right: base.right, top: base.top, bottom: base.bottom },
        x,
        y
      );
    });

    // 绘制序命中模型：同层伪元素按 DOM 顺序叠放，靠后者在上、先命中
    const hitTest = (px: number, py: number): Element | null => {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (rectContains(hitRects[i], px, py)) return items[i];
      }
      return null;
    };

    // 所有权保底（基线也应绿）：各控件视觉中心的点击归属自己
    items.forEach((item, index) => {
      const base = baseRects[index];
      expect(hitTest((base.left + base.right) / 2, centerY)).toBe(item);
    });

    // 契约主断言（基线红）：相邻有效命中盒不得重叠——
    // gap-2 只有 8px，-inset-2 每侧扩 8px，基线上环与推理触发器的命中盒
    // 在缝隙里重叠 8px 以上，DOM 靠后的推理触发器会偷走缝隙点击。
    for (let i = 0; i + 1 < hitRects.length; i += 1) {
      expect(hitRects[i].right).toBeLessThanOrEqual(hitRects[i + 1].left);
    }

    // 偷点示例（基线红）：紧贴环右缘外 2px 的粗指针落点，离环 2px、离推理触发器 6px，
    // 不允许被更远的推理触发器命中（要么无人认领，要么归更近的环）
    const nearRingPoint = baseRects[0].right + 2;
    expect(hitTest(nearRingPoint, centerY)).not.toBe(items[1]);
  });
});
