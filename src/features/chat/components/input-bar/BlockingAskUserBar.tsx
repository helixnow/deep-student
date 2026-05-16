/**
 * Chat V2 - BlockingAskUserBar
 *
 * Compact ask_user UI that fits inside the input bar frame.
 * Replaces the textarea area when the LLM asks the user a question.
 *
 * Supports:
 * - Single-select: click option chip → immediately submit
 * - Multi-select: checkboxes + confirm button
 * - Custom input field (when allowCustom is true)
 * - "已回答" disabled state after responding
 *
 * 设计决策：无超时。用户操作不应被自动替代。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ChatCircleDots,
  Check,
  Star,
  PaperPlaneRight,
} from '@phosphor-icons/react';

import type { BlockingInteraction } from '../../core/types/store';
import { cn } from '@/utils/cn';
import { Checkbox } from '@/components/ui/shad/Checkbox';

// ============================================================================
// 类型定义
// ============================================================================

type AskUserInteraction = Extract<BlockingInteraction, { kind: 'ask_user' }>;

interface BlockingAskUserBarProps {
  interaction: AskUserInteraction;
}

// ============================================================================
// 组件实现
// ============================================================================

export const BlockingAskUserBar: React.FC<BlockingAskUserBarProps> = React.memo(
  ({ interaction }) => {
    const { t } = useTranslation('chatV2');
    const {
      toolCallId,
      question,
      options: rawOptions,
      multiple,
      allowCustom,
      context,
    } = interaction;

    // 防御性归一化：即使上游归一化失效（如 LLM 直接传入 { label, value } 对象），
    // 也避免在 JSX 中渲染对象触发 "Objects are not valid as a React child"
    const options = useMemo<string[]>(() => {
      if (!Array.isArray(rawOptions)) return [];
      return rawOptions
        .map((opt) => {
          if (typeof opt === 'string') return opt;
          if (opt && typeof opt === 'object') {
            const o = opt as { label?: unknown; value?: unknown; text?: unknown };
            if (typeof o.label === 'string') return o.label;
            if (typeof o.value === 'string') return o.value;
            if (typeof o.text === 'string') return o.text;
            try { return JSON.stringify(opt); } catch { return String(opt); }
          }
          return String(opt ?? '');
        })
        .filter((s) => s.length > 0);
    }, [rawOptions]);

    // State
    const [customInput, setCustomInput] = useState('');
    const [checkedIndices, setCheckedIndices] = useState<Set<number>>(
      () => new Set(multiple && options.length > 0 ? [0] : [])
    );
    const [isResponding, setIsResponding] = useState(false);
    const [hasResponded, setHasResponded] = useState(false);

    // Reset state when a new interaction arrives
    useEffect(() => {
      setCustomInput('');
      setCheckedIndices(new Set(multiple && options.length > 0 ? [0] : []));
      setIsResponding(false);
      setHasResponded(false);
    }, [toolCallId, multiple, options.length]);

    // Unified submit handler
    const handleSubmit = useCallback(
      async (
        selectedTexts: string[],
        selectedIndices: number[],
        customText: string | null,
        source: 'user_click' | 'custom_input' | 'mixed'
      ) => {
        if (hasResponded || isResponding) return;

        setIsResponding(true);
        try {
          await invoke('chat_v2_ask_user_respond', {
            toolCallId,
            selectedTexts,
            selectedIndices,
            customText: customText || null,
            source,
          });
          setHasResponded(true);
        } catch (error) {
          console.error('[BlockingAskUserBar] Failed to send response:', error);
          // Mark as responded anyway to avoid stuck UI
          setHasResponded(true);
        } finally {
          setIsResponding(false);
        }
      },
      [toolCallId, hasResponded, isResponding]
    );

    // Single-select: click chip → submit immediately
    const handleSingleSelect = useCallback(
      (index: number, text: string) => {
        handleSubmit([text], [index], null, 'user_click');
      },
      [handleSubmit]
    );

    // Multi-select: toggle checkbox
    const handleToggleCheck = useCallback((index: number) => {
      setCheckedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    }, []);

    // Multi-select: confirm
    const handleMultiConfirm = useCallback(() => {
      const indices = Array.from(checkedIndices).sort((a, b) => a - b);
      const texts = indices.map((i) => options[i]).filter(Boolean);
      const trimmedCustom = customInput.trim();

      let source: 'user_click' | 'custom_input' | 'mixed';
      if (texts.length > 0 && trimmedCustom) {
        source = 'mixed';
      } else if (trimmedCustom) {
        source = 'custom_input';
      } else {
        source = 'user_click';
      }

      handleSubmit(texts, indices, trimmedCustom || null, source);
    }, [checkedIndices, options, customInput, handleSubmit]);

    // Custom input submit (single-select mode)
    const handleCustomSubmit = useCallback(() => {
      const trimmed = customInput.trim();
      if (!trimmed) return;
      handleSubmit([], [], trimmed, 'custom_input');
    }, [customInput, handleSubmit]);

    // Disabled state
    const disabled = isResponding || hasResponded;

    // ========== 已回答状态 ==========
    if (hasResponded) {
      return (
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
          <Check size={16} className="text-green-500" />
          <span>{t('askUser.responded', { defaultValue: '已回答' })}</span>
        </div>
      );
    }

    // ========== 活跃状态 ==========
    return (
      <div className="flex flex-col gap-1.5 px-3 py-2">
        {/* Row 1: Question */}
        <div className="flex items-center gap-2">
          <ChatCircleDots
            size={16}
            className="text-[color:var(--button-primary-foreground)] flex-shrink-0"
          />
          <span className="text-sm font-medium flex-1 truncate">{question}</span>
        </div>

        {/* Row 2 (optional): Context */}
        {context && (
          <p className="text-xs text-muted-foreground pl-6 truncate">
            {context}
          </p>
        )}

        {/* Row 3: Option chips */}
        {options.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-6">
            {multiple
              ? // Multi-select: checkbox chips
                options.map((option, index) => {
                  const isRecommended = index === 0;
                  const isChecked = checkedIndices.has(index);
                  return (
                    <label
                      key={index}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm border cursor-pointer transition-colors',
                        isRecommended
                          ? 'bg-[color:var(--brand-50)] border-[color:var(--brand-outline)] dark:bg-[color:var(--brand-50)] dark:border-[color:var(--brand-outline)]'
                          : 'bg-card border-border/50 hover:bg-muted',
                        disabled && 'opacity-50 pointer-events-none'
                      )}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => handleToggleCheck(index)}
                        disabled={disabled}
                        className="h-3.5 w-3.5"
                      />
                      <span>{option}</span>
                      {isRecommended && (
                        <Star
                          size={12}
                          className="text-[color:var(--button-primary-foreground)] fill-current"
                        />
                      )}
                    </label>
                  );
                })
              : // Single-select: clickable chips
                options.map((option, index) => {
                  const isRecommended = index === 0;
                  return (
                    <NotionButton
                      key={index}
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSingleSelect(index, option)}
                      disabled={disabled}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm border cursor-pointer transition-colors',
                        isRecommended
                          ? 'bg-[color:var(--brand-50)] border-[color:var(--brand-outline)] dark:bg-[color:var(--brand-50)] dark:border-[color:var(--brand-outline)]'
                          : 'bg-card border-border/50 hover:bg-muted',
                        disabled && 'opacity-50 pointer-events-none'
                      )}
                    >
                      <span>{option}</span>
                      {isRecommended && (
                        <Star
                          size={12}
                          className="text-[color:var(--button-primary-foreground)] fill-current"
                        />
                      )}
                    </NotionButton>
                  );
                })}

            {/* Multi-select confirm button */}
            {multiple && (
              <NotionButton
                variant="primary"
                size="sm"
                onClick={handleMultiConfirm}
                disabled={
                  disabled || (checkedIndices.size === 0 && !customInput.trim())
                }
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm',
                  'bg-[color:var(--button-prominent-bg)] text-white border border-[color:var(--button-prominent-border)] hover:bg-[color:var(--button-prominent-hover-bg)] transition-colors',
                  (disabled || (checkedIndices.size === 0 && !customInput.trim())) &&
                    'opacity-50 pointer-events-none'
                )}
              >
                <Check size={12} />
                <span>
                  {t('askUser.confirmSelection', { defaultValue: '确认选择' })}
                </span>
              </NotionButton>
            )}
          </div>
        )}

        {/* Row 4 (if allowCustom): Custom input */}
        {allowCustom && (
          <div className="flex items-center gap-2 pl-6">
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (multiple) {
                    handleMultiConfirm();
                  } else {
                    handleCustomSubmit();
                  }
                }
              }}
              placeholder={t('askUser.customPlaceholder', {
                defaultValue: '输入自定义回答...',
              })}
              disabled={disabled}
              className={cn(
                'flex-1 text-sm bg-transparent placeholder:text-[color:var(--button-primary-foreground)]/50',
                'outline-none border-none',
                disabled && 'opacity-50 cursor-not-allowed'
              )}
            />
            {!multiple && (
              <NotionButton
                variant="ghost"
                size="icon"
                onClick={handleCustomSubmit}
                disabled={disabled || !customInput.trim()}
                className={cn(
                  'p-1 rounded text-[color:var(--button-primary-foreground)] hover:text-[color:var(--button-primary-foreground)] transition-colors',
                  (disabled || !customInput.trim()) &&
                    'opacity-30 pointer-events-none'
                )}
                aria-label={t('askUser.send', { defaultValue: '发送' })}
              >
                <PaperPlaneRight size={16} />
              </NotionButton>
            )}
          </div>
        )}
      </div>
    );
  }
);

BlockingAskUserBar.displayName = 'BlockingAskUserBar';
