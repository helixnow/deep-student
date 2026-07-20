/**
 * SelectionToolbar - 文本选中浮动工具栏
 *
 * 当用户在消息内容中选中文本时，在选区上方显示操作工具栏。
 * 提供：复制、AI 解释、翻译、添加到聊天 四个操作。
 *
 * 视觉风格：毛玻璃胶囊形，带入场/出场动画。
 * 定位：Portal 渲染到 body，基于选区 rect 定位。
 */

import React, { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, Sparkle, Translate, ChatDots } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { useViewStore } from '@/stores/viewStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { SelectionRect } from '../hooks/useTextSelection';

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
  /** 清除选择状态 */
  onClear: () => void;
  /** 发送消息回调 */
  onSendMessage?: (content: string) => void;
  /** 解释回调（触发解释 popover） */
  onExplain?: (text: string) => void;
  /** 翻译回调（触发翻译 popover） */
  onTranslate?: (text: string) => void;
  /** 添加到聊天输入框回调 */
  onAddToChat?: (text: string) => void;
}

// ============================================================================
// 常量
// ============================================================================

/** 工具栏距选区的间距 */
const TOOLBAR_GAP = 8;
/** 工具栏高度估算（用于翻转判断） */
const TOOLBAR_HEIGHT = 40;
/** 视口边距 */
const VIEWPORT_PADDING = 12;

// ============================================================================
// 组件
// ============================================================================

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  selectedText,
  selectionRect,
  isVisible,
  onClear,
  onExplain,
  onTranslate,
  onAddToChat,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // C-8: 触屏上默认放选区下方（避开系统选择气泡），并放大触控目标
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const [position, setPosition] = useState<{ top: number; left: number; flipped: boolean }>({
    top: 0,
    left: 0,
    flipped: false,
  });

  // 计算工具栏位置（useLayoutEffect：在绘制前定位，避免首帧闪现在视口左上角）
  // P1-10: 用 visualViewport 度量——移动端软键盘弹出时 window.innerHeight
  // 不缩小，会把工具栏定位到键盘底下；桌面端两者一致
  useLayoutEffect(() => {
    if (!selectionRect || !isVisible) return;

    const toolbarWidth = toolbarRef.current?.offsetWidth || 200;
    const toolbarHeight = isTouchPrimary ? 48 : TOOLBAR_HEIGHT;

    const vv = window.visualViewport;
    const viewportTop = vv?.offsetTop ?? 0;
    const viewportLeft = vv?.offsetLeft ?? 0;
    const viewportBottom = viewportTop + (vv?.height ?? window.innerHeight);
    const viewportRight = viewportLeft + (vv?.width ?? window.innerWidth);

    let top: number;
    let flipped: boolean;

    if (isTouchPrimary) {
      // 触屏：默认下方（系统选择气泡通常占据选区上方）
      top = selectionRect.bottom + TOOLBAR_GAP;
      flipped = true;
      if (top + toolbarHeight > viewportBottom - VIEWPORT_PADDING) {
        top = selectionRect.top - toolbarHeight - TOOLBAR_GAP;
        flipped = false;
      }
    } else {
      // 桌面：默认在选区上方
      top = selectionRect.top - toolbarHeight - TOOLBAR_GAP;
      flipped = false;
      // 如果上方空间不足，翻转到下方
      if (top < viewportTop + VIEWPORT_PADDING) {
        top = selectionRect.bottom + TOOLBAR_GAP;
        flipped = true;
      }
    }

    // 极端情况（选区几乎占满视口）翻转后仍可能越界，最终钳制回视口内
    top = Math.max(
      viewportTop + VIEWPORT_PADDING,
      Math.min(top, viewportBottom - toolbarHeight - VIEWPORT_PADDING)
    );

    // 水平居中于选区
    let left = selectionRect.left + selectionRect.width / 2 - toolbarWidth / 2;

    // 防止超出视口左右边界
    const maxLeft = viewportRight - toolbarWidth - VIEWPORT_PADDING;
    left = Math.max(viewportLeft + VIEWPORT_PADDING, Math.min(left, maxLeft));

    setPosition({ top, left, flipped });
  }, [selectionRect, isVisible, isTouchPrimary]);

  // 全局视图切换离开 chat-v2 时，强制关闭工具栏
  const currentView = useViewStore((s) => s.currentView);
  useEffect(() => {
    if (isVisible && currentView !== 'chat-v2') {
      onClear();
    }
  }, [isVisible, currentView, onClear]);

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

  // 添加到聊天输入框
  const handleAddToChat = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onAddToChat) {
      onAddToChat(selectedText);
    }
    onClear();
  }, [selectedText, onAddToChat, onClear]);

  // 动画变体
  const motionVariants = {
    initial: { opacity: 0, scale: 0.92, y: position.flipped ? -4 : 4 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.95, transition: { duration: 0.1 } },
  };

  const touchTarget = isTouchPrimary;

  return createPortal(
    <AnimatePresence>
      {isVisible && selectionRect && (
        <motion.div
          ref={toolbarRef}
          data-selection-toolbar
          data-wb-blur-surface
          role="toolbar"
          aria-label={t('selectionToolbar.ariaLabel')}
          variants={motionVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
          className={cn(
            'fixed z-[9999] flex items-center',
            'rounded-lg border border-border/50',
            'bg-background/80 backdrop-blur-xl',
            // 阴影走 shell token，暗色由 --shadow-base 透明度自适应
            'shadow-[var(--shadow-shell-floating)]',
            'dark:bg-background/90 dark:border-border/30',
          )}
          style={{
            top: position.top,
            left: position.left,
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

          <Divider />

          {/* AI 解释 */}
          <ToolbarButton
            onClick={handleExplain}
            icon={<Sparkle size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.explain')}
            disabled={!onExplain}
            touchTarget={touchTarget}
          />

          <Divider />

          {/* 翻译 */}
          <ToolbarButton
            onClick={handleTranslate}
            icon={<Translate size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.translate')}
            disabled={!onTranslate}
            touchTarget={touchTarget}
          />

          <Divider />

          {/* 添加到聊天 */}
          <ToolbarButton
            onClick={handleAddToChat}
            icon={<ChatDots size={touchTarget ? 16 : 14} />}
            label={t('selectionToolbar.addToChat')}
            disabled={!onAddToChat}
            isLast
            touchTarget={touchTarget}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
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
    className={cn(
      'flex items-center gap-1.5',
      touchTarget ? 'px-3 py-3 text-[13px]' : 'px-2.5 py-1.5 text-xs',
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
    <span>{label}</span>
  </button>
);

const Divider: React.FC = () => (
  <div className="w-px h-5 bg-border/50" />
);

export default SelectionToolbar;
