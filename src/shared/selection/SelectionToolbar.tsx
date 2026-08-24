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
 * 定位契约（P0-3 去 Portal 改造）：
 * - 不再 createPortal 到 body、不再 fixed + z-[9999] 全局悬浮；
 *   改为绝对定位挂在宿主容器内（containerRef 指向的元素需为 position: relative）。
 * - 选区 rect（视口坐标）在渲染前换算为容器局部坐标；随内容一起滚动，
 *   滚动时由 useTextSelection 统一清除选区状态。
 * - 入场动画复用 .chat-msg-enter（150ms fade+rise，自带 reduced-motion 降级）。
 */

import React, { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Copy, Check, Sparkle, Translate, ChatDots, Cards, NotePencil } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { useViewStore } from '@/stores/viewStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { SelectionRect } from './useTextSelection';

// ============================================================================
// 类型
// ============================================================================

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
}

// ============================================================================
// 常量
// ============================================================================

/** 工具栏距选区的间距 */
const TOOLBAR_GAP = 8;
/** 工具栏高度估算（用于翻转判断） */
const TOOLBAR_HEIGHT = 40;
/** 容器内边距（水平钳制） */
const CONTAINER_PADDING = 4;

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
  onMakeCards,
  onSaveAsNote,
  hideUnavailableActions = false,
  placement = 'auto',
  viewportBottomInset = 0,
  dismissOnLeaveView = 'chat-v2',
  ariaLabel,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // C-8: 触屏上默认放选区下方（避开系统选择气泡），并放大触控目标
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // ★ M3 修复：窄屏时限制工具栏最大宽度（超宽时允许换行），避免横向溢出容器
  const [maxWidth, setMaxWidth] = useState<number | null>(null);

  // 计算工具栏位置（useLayoutEffect：在绘制前定位，避免首帧闪现）。
  // 选区 rect 是视口坐标，换算为容器局部坐标后用 absolute 定位。
  useLayoutEffect(() => {
    if (!selectionRect || !isVisible) {
      setPosition(null);
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const toolbarWidth = toolbarRef.current?.offsetWidth || 200;
    const toolbarHeight = toolbarRef.current?.offsetHeight || (isTouchPrimary ? 48 : TOOLBAR_HEIGHT);

    // 局部坐标系下的选区
    const localTop = selectionRect.top - containerRect.top;
    const localBottom = selectionRect.bottom - containerRect.top;
    const localCenterX = selectionRect.left + selectionRect.width / 2 - containerRect.left;

    let top: number;
    // 触屏默认下方（系统选择气泡通常占据选区上方）；
    // placement='below' 的宿主（PDF：选区上方已被高亮选色菜单占用）桌面端同样优先下方
    const preferBelow = isTouchPrimary || placement === 'below';
    if (preferBelow) {
      // ★ M3 修复：视口下方空间不足时翻转到选区上方
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      const fitsBelow = selectionRect.bottom + TOOLBAR_GAP + toolbarHeight
        <= viewportH - CONTAINER_PADDING - viewportBottomInset;
      top = fitsBelow ? localBottom + TOOLBAR_GAP : localTop - toolbarHeight - TOOLBAR_GAP;
      // 上方也出容器顶时回退下方（宁可被视口裁一截也不覆盖选区）
      if (!fitsBelow && top < CONTAINER_PADDING) {
        top = localBottom + TOOLBAR_GAP;
      }
    } else {
      // 桌面：默认在选区上方；容器顶部空间不足时翻转到下方
      top = localTop - toolbarHeight - TOOLBAR_GAP;
      if (top < CONTAINER_PADDING) {
        top = localBottom + TOOLBAR_GAP;
      }
    }

    // 水平居中于选区，并钳制在容器内
    // ★ M3 修复：工具栏比容器还宽时靠左贴边 + 限宽换行，不再横向溢出
    const availableWidth = containerRect.width - CONTAINER_PADDING * 2;
    setMaxWidth(availableWidth);
    let left = localCenterX - toolbarWidth / 2;
    if (toolbarWidth >= availableWidth) {
      left = CONTAINER_PADDING;
    } else {
      const maxLeft = containerRect.width - toolbarWidth - CONTAINER_PADDING;
      left = Math.max(CONTAINER_PADDING, Math.min(left, maxLeft));
    }

    setPosition({ top, left });
  }, [selectionRect, isVisible, isTouchPrimary, containerRef, placement, viewportBottomInset]);

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

  // 键盘可达性：←/→/Home/End 在按钮间移动焦点（roving focus）
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

  // 选中内容变化时重置"已复制"状态；卸载时清理定时器
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

  if (!isVisible || !selectionRect) return null;

  const touchTarget = isTouchPrimary;

  // hideUnavailableActions 下只渲染宿主真的接了回调的能力
  const showExplain = Boolean(onExplain) || !hideUnavailableActions;
  const showTranslate = Boolean(onTranslate) || !hideUnavailableActions;
  const showSaveAsNote = Boolean(onSaveAsNote);
  const showMakeCards = Boolean(onMakeCards) || !hideUnavailableActions;
  const showAddToChat = Boolean(onAddToChat) || !hideUnavailableActions;

  return (
    <div
      ref={toolbarRef}
      data-selection-toolbar
      data-wb-blur-surface
      role="toolbar"
      aria-label={ariaLabel ?? t('selectionToolbar.ariaLabel')}
      className={cn(
        'chat-msg-enter absolute z-10 flex items-center',
        // ★ M3：极窄容器兜底允许换行
        'flex-wrap',
        'rounded-lg border border-border/50',
        'bg-background/80 backdrop-blur-xl',
        // 阴影走 shell token，暗色由 --shadow-base 透明度自适应
        'shadow-[var(--shadow-shell-floating)]',
        'dark:bg-background/90 dark:border-border/30',
        className,
      )}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        // ★ M3：限宽在容器内
        maxWidth: maxWidth ?? undefined,
        // 首帧未测量前隐藏，避免闪现在容器左上角
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
            isLast
            touchTarget={touchTarget}
          />
        </>
      )}
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
    // ★ M3：触屏改图标优先（隐藏文字标签，总宽从 ≥330px 降到 ~190px，窄屏不再溢出）
    aria-label={label}
    title={label}
    className={cn(
      'flex items-center gap-1.5',
      touchTarget ? 'min-h-11 min-w-11 justify-center px-3 text-ui' : 'px-2.5 py-1.5 text-xs',
      'font-medium text-foreground/80',
      'hover:bg-accent/60 hover:text-foreground',
      // 键盘 roving focus 的可见反馈（鼠标点击被容器 preventDefault 拦截，不会误触发）
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
  <div className="w-px h-5 bg-border/50" />
);

export default SelectionToolbar;
