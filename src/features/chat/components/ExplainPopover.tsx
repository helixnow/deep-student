/**
 * ExplainPopover - 轻量解释弹出卡片
 *
 * 当用户在 SelectionToolbar 点击"解释"后，toolbar 消失，
 * 原位替换为此解释卡片，调用对话模型解释选中文本。
 *
 * 交互：
 * - 使用 call_llm_for_boundary 调用对话模型（非流式）
 * - 显示解释结果
 * - 提供：复制、添加到聊天输入框 操作
 * - 点击外部或 Escape 关闭
 *
 * 复用项目样式：
 * - 毛玻璃卡片：ModelMentionPopover 风格
 * - Z-index：Z_INDEX.popover
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, ChatDots, X, ArrowsClockwise } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/utils/cn';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { Z_INDEX } from '@/config/zIndex';
import type { SelectionRect } from '../hooks/useTextSelection';

// ============================================================================
// 类型
// ============================================================================

export interface ExplainPopoverProps {
  /** 要解释的原文 */
  sourceText: string;
  /** 选区位置（视口坐标） */
  selectionRect: SelectionRect | null;
  /** 是否显示 */
  isVisible: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 添加到聊天输入框回调（不发送） */
  onAddToInput?: (text: string) => void;
}

// ============================================================================
// 常量
// ============================================================================

const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 12;

// ============================================================================
// 加载动画组件
// ============================================================================

const ThinkingIndicator: React.FC = () => (
  <div className="flex items-center gap-2 text-xs text-muted-foreground">
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block w-1 h-1 rounded-full bg-primary/60"
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
          transition={{
            duration: 1,
            repeat: Infinity,
            delay: i * 0.2,
            ease: 'easeInOut',
          }}
        />
      ))}
    </span>
    <span>思考中...</span>
  </div>
);

// ============================================================================
// 组件
// ============================================================================

export const ExplainPopover: React.FC<ExplainPopoverProps> = ({
  sourceText,
  selectionRect,
  isVisible,
  onClose,
  onAddToInput,
}) => {
  const { t } = useTranslation(['chatV2']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  // 固定位置：打开时计算一次，之后不再变动
  const [fixedPosition, setFixedPosition] = useState<{ top: number; left: number } | null>(null);

  // 自动触发解释
  useEffect(() => {
    if (!isVisible || !sourceText || explanation || isLoading) return;

    abortRef.current = false;
    setIsLoading(true);
    setError(null);

    const prompt = `请用简洁清晰的语言解释以下内容。如果是专业术语，给出定义和通俗解释；如果是一段话，概括其核心含义。用中文回答。\n\n"${sourceText}"`;

    invoke<{ assistant_message: string; input_tokens: number; output_tokens: number }>(
      'call_llm_for_boundary',
      { prompt }
    )
      .then((result) => {
        if (abortRef.current) return;
        setExplanation(result.assistant_message);
      })
      .catch((err) => {
        if (abortRef.current) return;
        setError(String(err));
      })
      .finally(() => {
        if (!abortRef.current) setIsLoading(false);
      });
  }, [isVisible, sourceText, explanation, isLoading]);

  // 关闭时重置
  useEffect(() => {
    if (!isVisible) {
      abortRef.current = true;
      setExplanation('');
      setError(null);
      setIsLoading(false);
      setCopied(false);
      setFixedPosition(null);
    }
  }, [isVisible]);

  // 打开时固定位置（只计算一次）
  useEffect(() => {
    if (isVisible && selectionRect && !fixedPosition) {
      const popoverWidth = 380;
      const popoverHeight = 140;

      // 默认在选区上方（不遮挡下方未读内容）
      let top = selectionRect.top - popoverHeight - POPOVER_GAP;

      // 上方空间不足时翻转到下方
      if (top < VIEWPORT_PADDING) {
        top = selectionRect.bottom + POPOVER_GAP;
      }

      let left = selectionRect.left + selectionRect.width / 2 - popoverWidth / 2;
      const maxLeft = window.innerWidth - popoverWidth - VIEWPORT_PADDING;
      left = Math.max(VIEWPORT_PADDING, Math.min(left, maxLeft));

      setFixedPosition({ top, left });
    }
  }, [isVisible, selectionRect, fixedPosition]);

  // Escape 关闭
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isVisible, onClose]);

  // 复制
  const handleCopy = useCallback(async () => {
    if (!explanation) return;
    await copyTextToClipboard(explanation);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [explanation]);

  // 添加到聊天输入框
  const handleAddToInput = useCallback(() => {
    if (!explanation || !onAddToInput) return;
    onAddToInput(explanation);
    onClose();
  }, [explanation, onAddToInput, onClose]);

  // 重试
  const handleRetry = useCallback(() => {
    abortRef.current = false;
    setExplanation('');
    setError(null);
    setIsLoading(false);
  }, []);

  // 截断原文显示
  const displaySource = sourceText.length > 80
    ? sourceText.slice(0, 80) + '...'
    : sourceText;

  return createPortal(
    <AnimatePresence>
      {isVisible && selectionRect && (
        <motion.div
          ref={popoverRef}
          data-explain-popover
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
          transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
          className={cn(
            'fixed w-[380px] max-w-[calc(100vw-24px)]',
            'rounded-2xl border border-border/50',
            'bg-popover/80 backdrop-blur-xl backdrop-saturate-150',
            'shadow-lg ring-1 ring-border/40',
            'overflow-hidden',
          )}
          style={{ top: fixedPosition?.top ?? 0, left: fixedPosition?.left ?? 0, zIndex: Z_INDEX.popover }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* 头部：原文摘要 + 关闭按钮 */}
          <div className="flex items-start gap-2 px-3 pt-2.5 pb-1.5 border-b border-border/30">
            <p className="flex-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">
              {displaySource}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 p-1 rounded-md hover:bg-accent/60 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <X size={13} />
            </button>
          </div>

          {/* 解释内容区域 */}
          <div className="px-3 py-2.5 min-h-[48px] max-h-[240px] overflow-y-auto">
            {error ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-destructive flex-1">{error}</p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="shrink-0 p-1 rounded-md hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowsClockwise size={14} />
                </button>
              </div>
            ) : explanation ? (
              <p className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap">
                {explanation}
              </p>
            ) : isLoading ? (
              <ThinkingIndicator />
            ) : null}
          </div>

          {/* 底部操作栏 */}
          {explanation && !isLoading && (
            <div className="flex items-center gap-1 px-2.5 pb-2 border-t border-border/30 pt-1.5">
              <ActionButton
                onClick={handleCopy}
                icon={copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                label={copied ? t('selectionToolbar.copied', '已复制') : t('selectionToolbar.copy', '复制')}
              />
              {onAddToInput && (
                <ActionButton
                  onClick={handleAddToInput}
                  icon={<ChatDots size={13} />}
                  label={t('selectionToolbar.addToChat', '添加到聊天')}
                />
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};

// ============================================================================
// 子组件
// ============================================================================

interface ActionButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({ onClick, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'flex items-center gap-1.5 px-2 py-1 rounded-md',
      'text-xs text-muted-foreground',
      'hover:bg-accent/60 hover:text-foreground',
      'transition-colors duration-100',
    )}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export default ExplainPopover;
