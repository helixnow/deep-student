/**
 * SelectionToolbar - 文本选中操作条（轻量、非遮罩）
 *
 * 共享层组件：聊天气泡（MessageItem）与 PDF 阅读器（EnhancedPdfViewer）共用同一套。
 * `@/features/chat/components/SelectionToolbar` 仍在，但只是本文件的 re-export 兼容层。
 *
 * 提供：复制、AI 解释、翻译、保存为笔记、制卡、添加到聊天 操作。
 * 宿主只传自己「真的有」的能力回调；未传的能力默认灰显（聊天旧行为），
 * 宿主可传 `hideUnavailableActions` 直接不渲染，避免出现点了没反应的假入口。
 *
 * 定位契约：
 * - 导出纯函数 `computeSelectionToolbarPosition`：
 *   1. 桌面端（精细指针）默认置于选区上方 `rect.top - 46px`；
 *   2. 触屏端（isCoarsePointer === true）默认优先置于选区下方 `rect.bottom + 12px`
 *      （将选区上方让给 iOS/Android 原生系统「拷贝/查找」气泡），仅当距视口底部不足 56px 时翻转到上方；
 *   3. 执行水平 `[100, innerWidth - 100]` 与垂直 `[8, innerHeight - 52]` 双夹逼。
 * - 渲染时将视口坐标换算为宿主容器局部坐标并采用 absolute 定位；
 *   入场动画复用 .chat-msg-enter（150ms fade+rise，自带 reduced-motion 降级）。
 */

import React, { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Copy, Check, Sparkle, Translate, ChatDots, Cards, NotePencil, Quotes } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useViewStore } from '@/stores/viewStore';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { cn } from '@/utils/cn';
import type { SelectionRect } from './useTextSelection';

// ============================================================================
// 类型
// ============================================================================

export interface SelectionToolbarPositionOptions {
  /** 是否为粗指针（触屏）设备 */
  isCoarsePointer?: boolean;
  /** 视口宽度（px） */
  innerWidth?: number;
  /** 视口高度（px） */
  innerHeight?: number;
  /** 定位偏好：'auto'（桌面优先上方，触屏优先下方）| 'below'（始终优先下方） */
  placement?: 'auto' | 'below';
  /** 视口底部额外避让像素（如移动端底栏/安全区） */
  viewportBottomInset?: number;
}

export interface SelectionToolbarPositionInput extends SelectionToolbarPositionOptions {
  rect?: SelectionRect;
  selectionRect?: SelectionRect;
}

export interface SelectionToolbarPositionResult {
  /** 工具栏顶部视口 Y 坐标（已夹逼在 [8, innerHeight - 52]） */
  top: number;
  /** 工具栏水平锚点视口 X 坐标（已夹逼在 [100, innerWidth - 100]） */
  left: number;
  /** 最终相对于选区的放置方向 */
  placement: 'above' | 'below';
}

export interface SelectionToolbarProps {
  /** 选中的文本 */
  selectedText: string;
  /** 选区位置（视口坐标） */
  selectionRect: SelectionRect | null;
  /** 是否显示 */
  isVisible: boolean;
  /** 定位容器（消息根元素，需 position: relative） */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 清除选择状态 */
  onClear: () => void;
  /** 发送消息回调 */
  onSendMessage?: (content: string) => void;
  /** 解释回调（触发内联解释卡片） */
  onExplain?: (text: string) => void;
  /** 翻译回调（触发内联翻译卡片） */
  onTranslate?: (text: string) => void;
  /** 添加到聊天输入框回调 */
  onAddToChat?: (text: string) => void;
  /**
   * 引用到聊天回调（P0 选区即上下文）：把选区作为结构化 contextRef 注入。
   * 与 onAddToChat（纯文本/整资源）语义不同——精准选区快照 + 来源定位。
   * 只在宿主真正提供时渲染（不参与 hideUnavailableActions 的灰显占位）。
   */
  onAddAsContext?: (text: string) => void;
  /** 划词制卡回调 */
  onMakeCards?: (text: string) => void;
  /** 保存为笔记回调（宿主负责弹目录选择器） */
  onSaveAsNote?: (text: string) => void;
  /**
   * 未提供回调的能力是否直接不渲染。
   * 聊天保持 false（历史行为：灰显占位）；PDF 等新宿主传 true，不摆假入口。
   */
  hideUnavailableActions?: boolean;
  /**
   * 定位偏好。
   * - 'auto'（默认，聊天）：桌面优先选区上方，触屏优先下方
   * - 'below'：始终优先选区下方（PDF 桌面端选区上方已被高亮选色菜单占用）
   */
  placement?: 'auto' | 'below';
  /**
   * 视口底部需要避让的像素（移动端底部操作条 / Home Indicator）。
   * 参与「下方是否放得下」的判断，放不下时翻到选区上方。
   */
  viewportBottomInset?: number;
  /**
   * 离开该全局视图时自动关闭工具条；传 null 表示不做视图级联动。
   * 聊天默认 'chat-v2'；PDF 阅读器可能在多个视图内打开，应传 null。
   */
  dismissOnLeaveView?: string | null;
  /** 无障碍标签覆盖（默认取 chatV2 的 selectionToolbar.ariaLabel） */
  ariaLabel?: string;
  /** 宿主附加类名（层级 / 色调微调；定位仍由组件计算） */
  className?: string;
  /**
   * 宿主附加动作（如笔记「摘录到导图」）。渲染在「引用到聊天」之后，
   * 只在宿主真正传入时出现，不做灰显占位。
   */
  extraActions?: SelectionToolbarExtraAction[];
}

export interface SelectionToolbarExtraAction {
  key: string;
  label: string;
  icon: React.ReactNode | ((state: { touchTarget: boolean }) => React.ReactNode);
  run: (text: string) => void;
}

// ============================================================================
// 定位常量与纯计算函数
// ============================================================================

/** 桌面端默认置于选区上方的偏移量（rect.top - 46px） */
const DESKTOP_ABOVE_OFFSET_PX = 46;
/** 触屏端默认置于选区下方的间距（rect.bottom + 12px） */
const TOUCH_BELOW_OFFSET_PX = 12;
/** 触屏端下方空间不足翻转阈值（距视口底部不足 56px 时翻转到上方） */
const TOUCH_BOTTOM_SAFE_SPACE_PX = 56;
/** 水平边界夹逼边距（[100, innerWidth - 100]） */
const HORIZONTAL_EDGE_CLAMP_PX = 100;
/** 垂直顶部最小夹逼边距 */
const VERTICAL_TOP_CLAMP_PX = 8;
/** 垂直底部最大夹逼边距（innerHeight - 52） */
const VERTICAL_BOTTOM_CLAMP_PX = 52;
/** 容器内边距（水平防溢出兜底） */
const CONTAINER_PADDING = 4;

function isSelectionRectLike(value: unknown): value is SelectionRect {
  return (
    typeof value === 'object' &&
    value !== null &&
    'top' in value &&
    'left' in value &&
    'width' in value &&
    'bottom' in value &&
    !('rect' in value) &&
    !('selectionRect' in value)
  );
}

/**
 * 计算选词工具栏的视口定位坐标（纯函数）：
 * - 精细指针桌面端默认置于选区上方 `rect.top - 46px`
 * - 触屏端（isCoarsePointer === true）或 placement === 'below' 默认优先置于选区下方 `rect.bottom + 12px`，
 *   仅当距视口底部不足 56px 时翻转到上方 `rect.top - 46px`
 * - 执行水平 `[100, innerWidth - 100]` 与垂直 `[8, innerHeight - 52]` 双夹逼
 */
export function computeSelectionToolbarPosition(
  rect: SelectionRect,
  options?: SelectionToolbarPositionOptions,
): SelectionToolbarPositionResult;
export function computeSelectionToolbarPosition(
  input: SelectionToolbarPositionInput,
): SelectionToolbarPositionResult;
export function computeSelectionToolbarPosition(
  rectOrInput: SelectionRect | SelectionToolbarPositionInput,
  maybeOptions?: SelectionToolbarPositionOptions,
): SelectionToolbarPositionResult {
  const rect = isSelectionRectLike(rectOrInput)
    ? rectOrInput
    : (rectOrInput.rect ?? rectOrInput.selectionRect)!;
  const opts: SelectionToolbarPositionOptions = isSelectionRectLike(rectOrInput)
    ? (maybeOptions ?? {})
    : rectOrInput;

  const defaultWidth =
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1024;
  const defaultHeight =
    typeof window !== 'undefined' &&
    (window.visualViewport?.height ?? window.innerHeight) > 0
      ? (window.visualViewport?.height ?? window.innerHeight)
      : 768;

  const innerWidth = opts.innerWidth ?? defaultWidth;
  const innerHeight = opts.innerHeight ?? defaultHeight;
  const isCoarsePointer = Boolean(opts.isCoarsePointer);
  const placement = opts.placement ?? 'auto';
  const viewportBottomInset = opts.viewportBottomInset ?? 0;

  const preferBelow = isCoarsePointer || placement === 'below';
  const effectiveBottom = innerHeight - viewportBottomInset;

  let resolvedPlacement: 'above' | 'below';
  let rawTop: number;

  if (preferBelow) {
    const spaceBelow = effectiveBottom - rect.bottom;
    if (spaceBelow < TOUCH_BOTTOM_SAFE_SPACE_PX) {
      resolvedPlacement = 'above';
      rawTop = rect.top - DESKTOP_ABOVE_OFFSET_PX;
    } else {
      resolvedPlacement = 'below';
      rawTop = rect.bottom + TOUCH_BELOW_OFFSET_PX;
    }
  } else {
    resolvedPlacement = 'above';
    rawTop = rect.top - DESKTOP_ABOVE_OFFSET_PX;
  }

  const rawCenterX = rect.left + rect.width / 2;
  const minX = Math.min(HORIZONTAL_EDGE_CLAMP_PX, innerWidth / 2);
  const maxX = Math.max(innerWidth - HORIZONTAL_EDGE_CLAMP_PX, minX);
  const left = Math.min(Math.max(rawCenterX, minX), maxX);

  const minY = VERTICAL_TOP_CLAMP_PX;
  const maxY = Math.max(minY, innerHeight - VERTICAL_BOTTOM_CLAMP_PX);
  const top = Math.min(Math.max(rawTop, minY), maxY);

  return {
    top,
    left,
    placement: resolvedPlacement,
  };
}

// ============================================================================
// 组件
// ============================================================================

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  selectedText,
  selectionRect,
  isVisible,
  containerRef,
  onClear,
  onExplain,
  onTranslate,
  onAddToChat,
  onAddAsContext,
  onMakeCards,
  onSaveAsNote,
  hideUnavailableActions = false,
  placement = 'auto',
  viewportBottomInset = 0,
  dismissOnLeaveView = 'chat-v2',
  ariaLabel,
  className,
  extraActions = [],
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // C-8: 触屏上默认放选区下方（避开系统选择气泡），并放大触控目标
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    placement: 'above' | 'below';
  } | null>(null);
  // 窄屏时限制工具栏最大宽度（超宽时允许换行），避免横向溢出容器
  const [maxWidth, setMaxWidth] = useState<number | null>(null);

  // 计算工具栏位置（useLayoutEffect：在绘制前定位，避免首帧闪现）
  const updateToolbarPosition = useCallback(() => {
    if (!selectionRect || !isVisible) {
      setPosition(null);
      return;
    }
    // 同一次挂载提交中子组件 useLayoutEffect 早于父节点 ref 赋值，回退读取 parentElement
    const container = containerRef.current ?? toolbarRef.current?.parentElement ?? null;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const viewportPos = computeSelectionToolbarPosition(selectionRect, {
      isCoarsePointer: isTouchPrimary,
      innerWidth: window.innerWidth,
      innerHeight: window.visualViewport?.height ?? window.innerHeight,
      placement,
      viewportBottomInset,
    });

    const localTop = viewportPos.top - containerRect.top;

    // 真实浏览器下有布局宽度时居中于夹逼锚点并钳制在宿主容器内；
    // jsdom 等零宽高环境下直接使用 computeSelectionToolbarPosition 计算出的水平坐标
    if (containerRect.width > 0) {
      const availableWidth = Math.max(0, containerRect.width - CONTAINER_PADDING * 2);
      setMaxWidth(availableWidth);
      const measuredToolbarWidth = toolbarRef.current?.offsetWidth || 200;
      const localCenterX = viewportPos.left - containerRect.left;
      let localLeft = localCenterX - measuredToolbarWidth / 2;
      if (measuredToolbarWidth >= availableWidth) {
        localLeft = CONTAINER_PADDING;
      } else {
        const maxLeft = containerRect.width - measuredToolbarWidth - CONTAINER_PADDING;
        localLeft = Math.max(CONTAINER_PADDING, Math.min(localLeft, maxLeft));
      }
      setPosition({ top: localTop, left: localLeft, placement: viewportPos.placement });
    } else {
      setMaxWidth(null);
      setPosition({
        top: localTop,
        left: viewportPos.left - containerRect.left,
        placement: viewportPos.placement,
      });
    }
  }, [selectionRect, isVisible, isTouchPrimary, containerRef, placement, viewportBottomInset]);

  useLayoutEffect(() => {
    updateToolbarPosition();
  }, [updateToolbarPosition]);

  // 全局视图切换离开宿主视图时，强制关闭工具栏
  const currentView = useViewStore((s) => s.currentView);
  useEffect(() => {
    if (dismissOnLeaveView && isVisible && currentView !== dismissOnLeaveView) {
      onClear();
    }
  }, [isVisible, currentView, onClear, dismissOnLeaveView]);

  // 键盘可达性：工具栏可见时 Escape 直接关闭（无论焦点在何处）
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClear();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isVisible, onClear]);

  // 键盘可达性：左/右/Home/End 在按钮间移动焦点（roving focus）
  const handleToolbarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const root = toolbarRef.current;
    if (!root) return;
    const buttons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    );
    if (buttons.length === 0) return;
    e.preventDefault();
    const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    switch (e.key) {
      case 'ArrowLeft':
        nextIndex = activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1;
        break;
      case 'ArrowRight':
        nextIndex = activeIndex === -1 || activeIndex === buttons.length - 1 ? 0 : activeIndex + 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      default:
        nextIndex = buttons.length - 1;
        break;
    }
    buttons[nextIndex]?.focus();
  }, []);

  // 复制操作
  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await copyTextToClipboard(selectedText);
    setCopied(true);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
    }, 1500);
  }, [selectedText]);

  // 选中内容变化时重置已复制状态；卸载时清理定时器
  useEffect(() => {
    setCopied(false);
  }, [selectedText]);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  // AI 解释
  const handleExplain = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onExplain) {
      onExplain(selectedText);
    }
    onClear();
  }, [selectedText, onExplain, onClear]);

  // 翻译
  const handleTranslate = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onTranslate) {
      onTranslate(selectedText);
    }
    onClear();
  }, [selectedText, onTranslate, onClear]);

  // 划词制卡
  const handleMakeCards = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onMakeCards) {
      onMakeCards(selectedText);
    }
    onClear();
  }, [selectedText, onMakeCards, onClear]);

  // 保存为笔记（宿主负责目录选择与「打开笔记」提示）
  const handleSaveAsNote = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onSaveAsNote) {
      onSaveAsNote(selectedText);
    }
    onClear();
  }, [selectedText, onSaveAsNote, onClear]);

  // 添加到聊天输入框
  const handleAddToChat = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onAddToChat) {
      onAddToChat(selectedText);
    }
    onClear();
  }, [selectedText, onAddToChat, onClear]);

  // 引用到聊天（P0：结构化 contextRef 注入）
  const handleAddAsContext = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onAddAsContext) {
      onAddAsContext(selectedText);
    }
    onClear();
  }, [selectedText, onAddAsContext, onClear]);

  if (!isVisible || !selectionRect) return null;

  const touchTarget = isTouchPrimary;

  // hideUnavailableActions 下只渲染宿主真的接了回调的能力
  const showExplain = Boolean(onExplain) || !hideUnavailableActions;
  const showTranslate = Boolean(onTranslate) || !hideUnavailableActions;
  const showSaveAsNote = Boolean(onSaveAsNote);
  const showMakeCards = Boolean(onMakeCards) || !hideUnavailableActions;
  const showAddToChat = Boolean(onAddToChat) || !hideUnavailableActions;
  // 新能力只在宿主真正接入时渲染，不做灰显占位
  const showAddAsContext = Boolean(onAddAsContext);

  return (
    <div
      ref={toolbarRef}
      data-selection-toolbar
      data-placement={position?.placement}
      data-wb-blur-surface
      role="toolbar"
      aria-label={ariaLabel ?? t('selectionToolbar.ariaLabel')}
      className={cn(
        'chat-msg-enter absolute z-10 flex items-center',
        'flex-wrap',
        'rounded-lg border border-border/35',
        'bg-background/80 backdrop-blur-xl',
        'shadow-[var(--shadow-shell-floating)]',
        'dark:bg-background/90 dark:border-border/35',
        className,
      )}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxWidth: maxWidth ?? undefined,
        visibility: position ? 'visible' : 'hidden',
      }}
      // 阻止 mousedown 默认行为，防止清除选择
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={handleToolbarKeyDown}
    >
      {/* 复制 */}
      <ToolbarButton
        onClick={handleCopy}
        icon={copied ? <Check size={touchTarget ? 16 : 14} className="text-success" /> : <Copy size={touchTarget ? 16 : 14} />}
        label={copied ? t('selectionToolbar.copied') : t('selectionToolbar.copy')}
        isFirst
        touchTarget={touchTarget}
      />

      {/* AI 解释 */}
      {showExplain && (
        <>
          <Divider />
          <ToolbarButton
            onClick={handleExplain}
            icon={<Sparkle size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.explain')}
            disabled={!onExplain}
            touchTarget={touchTarget}
          />
        </>
      )}

      {/* 翻译 */}
      {showTranslate && (
        <>
          <Divider />
          <ToolbarButton
            onClick={handleTranslate}
            icon={<Translate size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.translate')}
            disabled={!onTranslate}
            touchTarget={touchTarget}
          />
        </>
      )}

      {/* 保存为笔记 */}
      {showSaveAsNote && (
        <>
          <Divider />
          <ToolbarButton
            onClick={handleSaveAsNote}
            icon={<NotePencil size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.saveAsNote')}
            touchTarget={touchTarget}
          />
        </>
      )}

      {/* 制卡 */}
      {showMakeCards && (
        <>
          <Divider />
          <ToolbarButton
            onClick={handleMakeCards}
            icon={<Cards size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.makeCards')}
            disabled={!onMakeCards}
            touchTarget={touchTarget}
          />
        </>
      )}

      {/* 添加到聊天 */}
      {showAddToChat && (
        <>
          <Divider />
          <ToolbarButton
            onClick={handleAddToChat}
            icon={<ChatDots size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.addToChat')}
            disabled={!onAddToChat}
            isLast={!showAddAsContext}
            touchTarget={touchTarget}
          />
        </>
      )}

      {/* 引用到聊天（P0 选区即上下文） */}
      {showAddAsContext && (
        <>
          <Divider />
          <ToolbarButton
            onClick={handleAddAsContext}
            icon={<Quotes size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.addAsContext')}
            isLast={extraActions.length === 0}
            touchTarget={touchTarget}
          />
        </>
      )}

      {/* 宿主附加动作（笔记：摘录到导图） */}
      {extraActions.map((action, index) => (
        <React.Fragment key={action.key}>
          <Divider />
          <ToolbarButton
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              action.run(selectedText);
              onClear();
            }}
            icon={typeof action.icon === 'function' ? action.icon({ touchTarget }) : action.icon}
            label={action.label}
            isLast={index === extraActions.length - 1}
            touchTarget={touchTarget}
          />
        </React.Fragment>
      ))}
    </div>
  );
};

// ============================================================================
// 子组件
// ============================================================================

interface ToolbarButtonProps {
  onClick: (e: React.MouseEvent) => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  /** 触屏放大触控目标 */
  touchTarget?: boolean;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  onClick,
  icon,
  label,
  disabled,
  isFirst,
  isLast,
  touchTarget,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    className={cn(
      'flex items-center gap-1.5',
      touchTarget ? 'min-h-11 min-w-11 justify-center px-3 text-ui' : 'px-2.5 py-1.5 text-xs',
      'font-medium text-foreground/80',
      'hover:bg-accent/60 hover:text-foreground',
      'focus-visible:outline-none focus-visible:bg-accent/60 focus-visible:text-foreground',
      'transition-colors duration-100',
      'disabled:opacity-40 disabled:cursor-not-allowed',
      isFirst && 'rounded-l-lg',
      isLast && 'rounded-r-lg',
    )}
  >
    {icon}
    {!touchTarget && <span>{label}</span>}
  </button>
);

const Divider: React.FC = () => (
  <div className="w-px h-5 bg-border/35" />
);

export default SelectionToolbar;
