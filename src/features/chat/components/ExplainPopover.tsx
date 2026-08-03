/**
 * ExplainPopover - 内联解释卡片（P0-3 去 Portal / 去 dialog 改造）
 *
 * 当用户在 SelectionToolbar 点击"解释"后，在选中消息下方展开此内联卡片，
 * 调用对话模型解释选中文本。
 *
 * 契约：
 * - 非 Portal / 非 fixed / 非 dialog：卡片挂在消息 DOM 流内（消息下方），
 *   随消息一起滚动，不遮挡其他内容
 * - 可折叠：头部常显（原文摘要 + 折叠/关闭），正文经 .chat-collapse 过渡
 * - 入场复用 .chat-msg-enter；动效自带 prefers-reduced-motion 降级
 * - Escape（焦点在卡片内时）与关闭按钮均可关闭
 *
 * 请求语义保持不变：
 * - 使用 call_llm_for_boundary 调用对话模型（非流式）
 * - requestId 防"关闭→重开"或重试时的旧响应竞态
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CaretDown, Copy, Check, ChatDots, X, ArrowsClockwise } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/utils/cn';
import { IconSwap } from '@/components/ui/IconSwap';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型
// ============================================================================

export interface ExplainPopoverProps {
  /** 要解释的原文 */
  sourceText: string;
  /** 是否显示 */
  isVisible: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 添加到聊天输入框回调（不发送） */
  onAddToInput?: (text: string) => void;
}

// ============================================================================
// 加载动画组件
// ============================================================================

const ExplainThinkingIndicator: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
    <span className="chat-wait-dots" aria-hidden="true"><i /><i /><i /></span>
    <span>{label}</span>
  </div>
);

// ============================================================================
// 组件
// ============================================================================

export const ExplainPopover: React.FC<ExplainPopoverProps> = ({
  sourceText,
  isVisible,
  onClose,
  onAddToInput,
}) => {
  const { t } = useTranslation(['chatV2']);
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 可折叠：头部常显，正文经 .chat-collapse 过渡
  const [collapsed, setCollapsed] = useState(false);

  // 用 requestId 防止"关闭→重开"或重试时的旧响应竞态
  const requestIdRef = useRef(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  // ===== 解释请求（带 requestId 防竞态） =====

  useEffect(() => {
    if (!isVisible || !sourceText) return;
    // 已有结果 / 正在加载 / 已出错（等待重试）时不重复发起
    if (explanation || isLoading || error) return;

    const reqId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    // 通过 i18n 生成 prompt，使回答语言跟随界面语言
    const prompt = t('explainPopover.prompt', { text: sourceText });

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
  }, [isVisible, sourceText, explanation, isLoading, error, t]);

  // 关闭时重置（同时让所有 in-flight 失效）
  useEffect(() => {
    if (!isVisible) {
      requestIdRef.current++;
      setExplanation('');
      setError(null);
      setIsLoading(false);
      setCopied(false);
      setCollapsed(false);
    }
  }, [isVisible]);

  // ===== 焦点管理：打开时聚焦卡片（读屏/键盘可达） =====
  useEffect(() => {
    if (!isVisible) return;
    const raf = requestAnimationFrame(() => {
      rootRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [isVisible]);

  // Escape 关闭（仅当焦点在卡片内：内联卡片不劫持全局键盘）
  const handleRootKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }, [onClose]);

  // ===== 用户操作 =====

  const handleCopy = useCallback(async () => {
    if (!explanation) return;
    await copyTextToClipboard(explanation);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
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

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  if (!isVisible) return null;

  // 截断原文显示
  const displaySource = sourceText.length > 80
    ? sourceText.slice(0, 80) + '...'
    : sourceText;

  return (
    <div
      ref={rootRef}
      data-explain-popover
      role="group"
      aria-label={t('selectionToolbar.explain')}
      tabIndex={-1}
      onKeyDown={handleRootKeyDown}
      className={cn(
        'chat-msg-enter mt-2 w-full',
        'rounded-[var(--chat-radius-md,12px)] border border-border/50',
        'bg-muted/30',
        'outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
      )}
    >
      {/* 头部：原文摘要 + 折叠 + 关闭 */}
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1.5">
        <p className="flex-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">
          {displaySource}
        </p>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
          title={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
          // ★ 低-11：p-1→p-2 放大视觉目标，触屏再用伪元素扩命中区到 ≥44px
          className="shrink-0 p-2 rounded-md hover:bg-accent/60 text-muted-foreground/50 hover:text-foreground transition-colors relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']"
        >
          <CaretDown
            size={13}
            className={cn(
              'transition-transform duration-[var(--chat-motion-base,200ms)]',
              collapsed && '-rotate-90'
            )}
          />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common:actions.close')}
          title={t('common:actions.close')}
          className="shrink-0 p-2 rounded-md hover:bg-accent/60 text-muted-foreground/50 hover:text-foreground transition-colors relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']"
        >
          <X size={13} />
        </button>
      </div>

      {/* 正文（可折叠） */}
      <div className="chat-collapse" data-open={collapsed ? 'false' : 'true'}>
        <div className={cn(collapsed && 'pointer-events-none')} aria-hidden={collapsed}>
          <div className="px-3 py-2.5 min-h-[48px] border-t border-border/30">
            {error ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-destructive flex-1">{error}</p>
                <button
                  type="button"
                  onClick={handleRetry}
                  aria-label={t('common:actions.retry')}
                  title={t('common:actions.retry')}
                  className="shrink-0 p-1 rounded-md hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowsClockwise size={14} />
                </button>
              </div>
            ) : explanation ? (
              <p className="text-ui text-foreground leading-relaxed whitespace-pre-wrap">
                {explanation}
              </p>
            ) : isLoading ? (
              <ExplainThinkingIndicator label={t('explainPopover.thinking')} />
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
                    b={<Check size={13} className="text-success" />}
                  />
                }
                label={copied ? t('selectionToolbar.copied') : t('selectionToolbar.copy')}
              />
              {onAddToInput && (
                <ActionButton
                  onClick={handleAddToInput}
                  icon={<ChatDots size={13} />}
                  label={t('selectionToolbar.addToChat')}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
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
