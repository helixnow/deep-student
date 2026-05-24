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
 * - 点击外部、滚动或 Escape 关闭
 *
 * 定位策略：
 * - useLayoutEffect 测量真实尺寸后再定位（不再用估算高度）
 * - ResizeObserver 在内容变化（loading→result→error）时重新计算
 * - 上下空间均不足时，贴向较大一侧的视口边缘
 *
 * 复用项目样式：
 * - 毛玻璃卡片：ModelMentionPopover 风格
 * - Z-index：Z_INDEX.popover
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, ChatDots, X, ArrowsClockwise } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/utils/cn';
import { IconSwap } from '@/components/ui/IconSwap';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { Z_INDEX } from '@/config/zIndex';
import { useViewStore } from '@/stores/viewStore';
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

const POPOVER_WIDTH = 380;
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

  // 用 requestId 防止"关闭→重开"或重试时的旧响应竞态
  const requestIdRef = useRef(0);

  // 动态位置：根据真实测量尺寸计算
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // ===== 定位 =====

  const computePosition = useCallback(() => {
    if (!selectionRect || !popoverRef.current) return;

    const el = popoverRef.current;
    // 使用真实测量值，避免估算误差
    const height = el.offsetHeight || el.getBoundingClientRect().height || 0;
    const width = el.offsetWidth || POPOVER_WIDTH;

    if (height === 0) return; // 还未渲染完成，等下一帧

    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    const spaceAbove = selectionRect.top - VIEWPORT_PADDING;
    const spaceBelow = viewportH - selectionRect.bottom - VIEWPORT_PADDING;
    const needed = height + POPOVER_GAP;

    let top: number;
    if (needed <= spaceAbove) {
      // 上方放得下：贴近选区上方
      top = selectionRect.top - height - POPOVER_GAP;
    } else if (needed <= spaceBelow) {
      // 下方放得下：贴近选区下方
      top = selectionRect.bottom + POPOVER_GAP;
    } else {
      // 上下都放不下：选较大一侧贴边
      top =
        spaceAbove >= spaceBelow
          ? VIEWPORT_PADDING
          : Math.max(VIEWPORT_PADDING, viewportH - height - VIEWPORT_PADDING);
    }

    let left = selectionRect.left + selectionRect.width / 2 - width / 2;
    const maxLeft = viewportW - width - VIEWPORT_PADDING;
    left = Math.max(VIEWPORT_PADDING, Math.min(left, maxLeft));

    setPosition((prev) => {
      // 避免无意义的状态写入引起额外渲染
      if (prev && prev.top === top && prev.left === left) return prev;
      return { top, left };
    });
  }, [selectionRect]);

  // 渲染后立即测量并定位（同步避开闪烁）
  useLayoutEffect(() => {
    if (!isVisible) return;
    computePosition();
  }, [isVisible, isLoading, explanation, error, computePosition]);

  // ResizeObserver 监听内容尺寸变化（如 loading → 长文本 → 错误条）
  useEffect(() => {
    if (!isVisible) return;
    const el = popoverRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => computePosition());
    ro.observe(el);
    // 视口尺寸变化也重算
    const onResize = () => computePosition();
    window.addEventListener('resize', onResize);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [isVisible, computePosition]);

  // ===== 解释请求（带 requestId 防竞态） =====

  useEffect(() => {
    if (!isVisible || !sourceText) return;
    // 已有结果 / 正在加载 / 已出错（等待重试）时不重复发起
    if (explanation || isLoading || error) return;

    const reqId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    const prompt = `请用简洁清晰的语言解释以下内容。如果是专业术语，给出定义和通俗解释；如果是一段话，概括其核心含义。用中文回答。\n\n"${sourceText}"`;

    invoke<{ assistant_message: string; input_tokens: number; output_tokens: number }>(
      'call_llm_for_boundary',
      { prompt }
    )
      .then((result) => {
        if (requestIdRef.current !== reqId) return; // 旧请求被新一轮替代，丢弃
        setExplanation(result.assistant_message);
      })
      .catch((err) => {
        if (requestIdRef.current !== reqId) return;
        setError(String(err));
      })
      .finally(() => {
        if (requestIdRef.current === reqId) setIsLoading(false);
      });
  }, [isVisible, sourceText, explanation, isLoading, error]);

  // 关闭时重置（同时让所有 in-flight 失效）
  useEffect(() => {
    if (!isVisible) {
      requestIdRef.current++;
      setExplanation('');
      setError(null);
      setIsLoading(false);
      setCopied(false);
      setPosition(null);
    }
  }, [isVisible]);

  // 全局视图切换离开 chat-v2 时，强制关闭弹窗
  const currentView = useViewStore((s) => s.currentView);
  useEffect(() => {
    if (isVisible && currentView !== 'chat-v2') {
      onClose();
    }
  }, [isVisible, currentView, onClose]);

  // ===== 关闭事件 =====

  // Escape 关闭
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, onClose]);

  // 外部点击关闭
  useEffect(() => {
    if (!isVisible) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isVisible, onClose]);

  // 滚动关闭（忽略 popover 内部滚动）
  useEffect(() => {
    if (!isVisible) return;
    const handleScroll = (e: Event) => {
      const target = e.target as Node | null;
      // 内容区域自身可滚动（max-h-[240px] overflow-y-auto），不应触发关闭
      if (target && popoverRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', handleScroll, { capture: true });
  }, [isVisible, onClose]);

  // ===== 用户操作 =====

  const handleCopy = useCallback(async () => {
    if (!explanation) return;
    await copyTextToClipboard(explanation);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [explanation]);

  const handleAddToInput = useCallback(() => {
    if (!explanation || !onAddToInput) return;
    onAddToInput(explanation);
    onClose();
  }, [explanation, onAddToInput, onClose]);

  const handleRetry = useCallback(() => {
    // 让在途请求作废，并重置状态触发自动重发
    requestIdRef.current++;
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
          style={{
            // 测量未完成前用大负偏移避免视觉闪烁；visibility 隐藏交互
            top: position?.top ?? -9999,
            left: position?.left ?? -9999,
            visibility: position ? 'visible' : 'hidden',
            zIndex: Z_INDEX.popover,
          }}
          onMouseDown={(e) => e.stopPropagation()}
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
                icon={
                  <IconSwap
                    active={copied}
                    a={<Copy size={13} />}
                    b={<Check size={13} className="text-green-500" />}
                  />
                }
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
