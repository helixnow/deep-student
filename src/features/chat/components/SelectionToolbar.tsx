/**
 * SelectionToolbar - 文本选中浮动工具栏
 *
 * 当用户在消息内容中选中文本时，在选区上方显示操作工具栏。
 * 提供：复制、AI 解释、翻译、添加到聊天 四个操作。
 *
 * 视觉风格：毛玻璃胶囊形，带入场/出场动画。
 * 定位：Portal 渲染到 body，基于选区 rect 定位。
 */

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, Sparkle, Translate, ChatDots } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { useViewStore } from '@/stores/viewStore';
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
  onSendMessage,
  onExplain,
  onTranslate,
  onAddToChat,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; flipped: boolean }>({
    top: 0,
    left: 0,
    flipped: false,
  });

  // 计算工具栏位置
  useEffect(() => {
    if (!selectionRect || !isVisible) return;

    const toolbarWidth = toolbarRef.current?.offsetWidth || 200;

    // 默认在选区上方
    let top = selectionRect.top - TOOLBAR_HEIGHT - TOOLBAR_GAP;
    let flipped = false;

    // 如果上方空间不足，翻转到下方
    if (top < VIEWPORT_PADDING) {
      top = selectionRect.bottom + TOOLBAR_GAP;
      flipped = true;
    }

    // 水平居中于选区
    let left = selectionRect.left + selectionRect.width / 2 - toolbarWidth / 2;

    // 防止超出视口左右边界
    const maxLeft = window.innerWidth - toolbarWidth - VIEWPORT_PADDING;
    left = Math.max(VIEWPORT_PADDING, Math.min(left, maxLeft));

    setPosition({ top, left, flipped });
  }, [selectionRect, isVisible]);

  // 全局视图切换离开 chat-v2 时，强制关闭工具栏
  const currentView = useViewStore((s) => s.currentView);
  useEffect(() => {
    if (isVisible && currentView !== 'chat-v2') {
      onClear();
    }
  }, [isVisible, currentView, onClear]);

  // 复制操作
  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await copyTextToClipboard(selectedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [selectedText]);

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

  return createPortal(
    <AnimatePresence>
      {isVisible && selectionRect && (
        <motion.div
          ref={toolbarRef}
          data-selection-toolbar
          variants={motionVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
          className={cn(
            'fixed z-[9999] flex items-center',
            'rounded-lg border border-border/50',
            'bg-background/80 backdrop-blur-xl',
            'shadow-[0_4px_12px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]',
            'dark:bg-background/90 dark:border-border/30',
            'dark:shadow-[0_4px_16px_rgba(0,0,0,0.3),0_1px_4px_rgba(0,0,0,0.2)]',
          )}
          style={{
            top: position.top,
            left: position.left,
          }}
          // 阻止 mousedown 冒泡，防止清除选择
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* 复制 */}
          <ToolbarButton
            onClick={handleCopy}
            icon={copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
            label={copied ? t('selectionToolbar.copied', '已复制') : t('selectionToolbar.copy', '复制')}
            isFirst
          />

          <Divider />

          {/* AI 解释 */}
          <ToolbarButton
            onClick={handleExplain}
            icon={<Sparkle size={14} />}
            label={t('selectionToolbar.explain', '解释')}
            disabled={!onExplain}
          />

          <Divider />

          {/* 翻译 */}
          <ToolbarButton
            onClick={handleTranslate}
            icon={<Translate size={14} />}
            label={t('selectionToolbar.translate', '翻译')}
            disabled={!onTranslate}
          />

          <Divider />

          {/* 添加到聊天 */}
          <ToolbarButton
            onClick={handleAddToChat}
            icon={<ChatDots size={14} />}
            label={t('selectionToolbar.addToChat', '添加到聊天')}
            disabled={!onAddToChat}
            isLast
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
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  onClick,
  icon,
  label,
  disabled,
  isFirst,
  isLast,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex items-center gap-1.5 px-2.5 py-1.5',
      'text-xs font-medium text-foreground/80',
      'hover:bg-accent/60 hover:text-foreground',
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
