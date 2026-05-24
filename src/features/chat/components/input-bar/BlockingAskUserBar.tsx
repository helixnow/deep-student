/**
 * Chat V2 - BlockingAskUserBar
 *
 * ask_user UI that keeps the original visual semantics
 * while presenting options in a clearer stacked layout.
 *
 * Supports:
 * - Single-select: choose one option, then submit
 * - Multi-select: checkbox rows + submit button
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
} from '@phosphor-icons/react';

import type { BlockingInteraction } from '../../core/types/store';
import { cn } from '@/utils/cn';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import type { PlaygroundAskUserInteraction } from '../../dev/playground/blockingRuntime';

// ============================================================================
// 类型定义
// ============================================================================

type AskUserInteraction = Extract<BlockingInteraction, { kind: 'ask_user' }> | PlaygroundAskUserInteraction;

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
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    const [checkedIndices, setCheckedIndices] = useState<Set<number>>(
      () => new Set(multiple && options.length > 0 ? [0] : [])
    );
    const [isResponding, setIsResponding] = useState(false);
    const [hasResponded, setHasResponded] = useState(false);

    // Reset state when a new interaction arrives
    useEffect(() => {
      setCustomInput('');
      setSelectedIndex(null);
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
          if ('respond' in interaction && typeof interaction.respond === 'function') {
            await interaction.respond({
              selectedTexts,
              selectedIndices,
              customText: customText || null,
              source,
            });
          } else {
            await invoke('chat_v2_ask_user_respond', {
              toolCallId,
              selectedTexts,
              selectedIndices,
              customText: customText || null,
              source,
            });
          }
          setHasResponded(true);
        } catch (error) {
          console.error('[BlockingAskUserBar] Failed to send response:', error);
          // Mark as responded anyway to avoid stuck UI
          setHasResponded(true);
        } finally {
          setIsResponding(false);
        }
      },
      [interaction, toolCallId, hasResponded, isResponding]
    );

    // Disabled state
    const disabled = isResponding || hasResponded;

    // Single-select: choose an option first, then submit in the footer
    const handleSingleSelect = useCallback(
      (index: number) => {
        if (disabled) return;
        setSelectedIndex((prev) => (prev === index ? null : index));
      },
      [disabled]
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

    const canSubmit = useMemo(() => {
      if (multiple) {
        return checkedIndices.size > 0 || customInput.trim().length > 0;
      }
      return selectedIndex !== null || customInput.trim().length > 0;
    }, [checkedIndices.size, customInput, multiple, selectedIndex]);

    const handlePrimarySubmit = useCallback(() => {
      const indices = multiple
        ? Array.from(checkedIndices).sort((a, b) => a - b)
        : selectedIndex !== null
          ? [selectedIndex]
          : [];
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
    }, [checkedIndices, customInput, handleSubmit, multiple, options, selectedIndex]);

    const handleIgnore = useCallback(() => {
      handleSubmit([], [], null, 'user_click');
    }, [handleSubmit]);

    // ========== 已回答状态 ==========
    if (hasResponded) {
      return (
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
          <Check size={16} className="text-[color:var(--button-primary-foreground)]" />
          <span>{t('askUser.responded', { defaultValue: '已回答' })}</span>
        </div>
      );
    }

    // ========== 活跃状态 ==========
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        <div className="flex items-start gap-2">
          <ChatCircleDots
            size={16}
            className="mt-1 flex-shrink-0 text-[color:var(--button-primary-foreground)]"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-6 text-foreground">
              {question}
            </p>
            {context && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {context}
              </p>
            )}
          </div>
        </div>

        {options.length > 0 && (
          <div className="space-y-2 pl-6">
            {options.map((option, index) => {
              const isRecommended = index === 0;
              const isChecked = multiple ? checkedIndices.has(index) : selectedIndex === index;
              const numberLabel = `${index + 1}.`;

              if (multiple) {
                return (
                  <label
                    key={index}
                    className={cn(
                      'group flex w-full cursor-pointer items-center gap-3 rounded-[var(--radius-shell-row)] border px-3 py-2.5 text-left transition-colors',
                      isChecked
                        ? 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)]'
                      : isRecommended
                          ? 'border-[color:var(--brand-outline)] bg-[color:var(--brand-50)] hover:bg-[color:var(--button-primary-hover)]'
                          : 'border-border/50 bg-card hover:bg-muted',
                      disabled && 'pointer-events-none opacity-50'
                    )}
                  >
                    <span className="w-6 flex-shrink-0 text-sm font-medium text-muted-foreground">
                      {numberLabel}
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-medium leading-6 text-foreground">
                      {option}
                      {isRecommended && (
                        <span className="ml-1 text-muted-foreground">
                          ({t('askUser.recommended', { defaultValue: '推荐' })})
                        </span>
                      )}
                    </span>
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => handleToggleCheck(index)}
                      disabled={disabled}
                      className="h-4 w-4 rounded-[6px] border-[color:var(--button-primary-border)]"
                    />
                  </label>
                );
              }

              return (
                <NotionButton
                  key={index}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSingleSelect(index)}
                  disabled={disabled}
                  className={cn(
                    'group flex h-auto w-full items-center gap-3 rounded-[var(--radius-shell-row)] border px-3 py-2.5 text-left transition-colors',
                    isChecked
                      ? 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)]'
                    : isRecommended
                        ? 'border-[color:var(--brand-outline)] bg-[color:var(--brand-50)] hover:bg-[color:var(--button-primary-hover)]'
                        : 'border-border/50 bg-card hover:bg-muted',
                    disabled && 'pointer-events-none opacity-50'
                  )}
                >
                  <span className="w-6 flex-shrink-0 text-sm font-medium text-muted-foreground">
                    {numberLabel}
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium leading-6 text-foreground">
                    {option}
                    {isRecommended && (
                      <span className="ml-1 text-muted-foreground">
                        ({t('askUser.recommended', { defaultValue: '推荐' })})
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors',
                      isChecked
                        ? 'text-[color:var(--button-primary-foreground)]'
                        : 'text-transparent group-hover:text-muted-foreground/60'
                    )}
                  >
                    <Check size={16} weight="bold" />
                  </span>
                </NotionButton>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-2 pl-6 lg:flex-row lg:items-end lg:justify-between">
          {allowCustom ? (
            <label className="block flex-1">
              <div className="flex items-center gap-2 rounded-[var(--radius-shell-control)] border border-border/50 bg-transparent px-3 py-2 transition-colors focus-within:border-[color:var(--button-primary-border)] focus-within:bg-card">
                <input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handlePrimarySubmit();
                    }
                  }}
                  placeholder={t('askUser.customPlaceholder', {
                    defaultValue: '或输入自定义回答...',
                  })}
                  disabled={disabled}
                  className={cn(
                    'flex-1 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60',
                    disabled && 'cursor-not-allowed opacity-50'
                  )}
                />
              </div>
            </label>
          ) : (
            <div className="hidden flex-1 lg:block" />
          )}

          <div className="flex items-center justify-end gap-2">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={handleIgnore}
              disabled={disabled}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('askUser.ignore', { defaultValue: '忽略' })}
            </NotionButton>
            <NotionButton
              variant="primary"
              size="sm"
              onClick={handlePrimarySubmit}
              disabled={disabled || !canSubmit}
              className={cn(
                'rounded-full px-4',
                'bg-[color:var(--button-prominent-bg)] text-white border border-[color:var(--button-prominent-border)] hover:bg-[color:var(--button-prominent-hover-bg)]'
              )}
            >
              <span>{t('askUser.submit', { defaultValue: '提交' })}</span>
            </NotionButton>
          </div>
        </div>
      </div>
    );
  }
);

BlockingAskUserBar.displayName = 'BlockingAskUserBar';
