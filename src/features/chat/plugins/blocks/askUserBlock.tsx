/**
 * Chat V2 - 用户提问块组件
 *
 * 在工具调用时间线中渲染一个交互式提问卡片，支持：
 * - 单选模式：按钮点击即提交
 * - 多选模式：复选框 + 确认按钮
 * - 可配置的自定义输入框
 * - 30 秒倒计时，超时自动选择推荐选项
 * - 已回答状态的只读视图
 *
 * 设计参考：
 * - ToolApprovalCard.tsx（倒计时 + invoke 交互模式）
 * - sleepBlock.tsx（独立块类型注册模式）
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ChatCircleDots,
  Check,
  Clock,
  Star,
  PaperPlaneRight,
} from '@phosphor-icons/react';

import type { BlockComponentProps } from '../../registry/blockRegistry';
import { blockRegistry } from '../../registry/blockRegistry';
import { cn } from '@/utils/cn';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';

// ============================================================================
// 类型定义
// ============================================================================

/** 提问块输入数据（LLM 工具调用参数） */
interface AskUserBlockInput {
  question: string;
  options: string[]; // 2-6 items, index 0 is recommended
  multiple?: boolean; // default false
  allowCustom?: boolean; // default true
  timeoutSeconds?: number; // optional, no timeout if not set
  context?: string;
}

/** 提问块输出数据（用户回答结果） */
interface AskUserBlockOutput {
  question: string;
  selected: string[]; // array (even for single-select, length 1)
  selected_indices: number[];
  custom_text: string | null;
  source: string; // "user_click" | "custom_input" | "mixed" | "timeout" | "channel_closed"
  options: string[];
  multiple: boolean;
}

/** 从 toolOutput 中解包 result（后端发送 { result: actualOutput, durationMs }） */
function unwrapOutput(toolOutput: unknown): AskUserBlockOutput | undefined {
  if (!toolOutput || typeof toolOutput !== 'object') return undefined;
  const obj = toolOutput as Record<string, unknown>;
  // 后端发送格式: { result: { question, selected, ... }, durationMs: N }
  if (obj.result && typeof obj.result === 'object') {
    return obj.result as AskUserBlockOutput;
  }
  // DB 恢复格式: 直接是 { question, selected, ... }
  if ('question' in obj && 'selected' in obj) {
    return obj as unknown as AskUserBlockOutput;
  }
  return undefined;
}

// ============================================================================
// 组件实现
// ============================================================================

const AskUserBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('chatV2');
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [hasResponded, setHasResponded] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [checkedIndices, setCheckedIndices] = useState<Set<number>>(new Set());

  // Local state for optimistic UI before backend confirms
  const [localSelectedTexts, setLocalSelectedTexts] = useState<string[] | null>(null);
  const [localCustomText, setLocalCustomText] = useState<string | null>(null);
  const [localSource, setLocalSource] = useState<string | null>(null);

  // 解析块数据
  const askInput = block.toolInput as unknown as AskUserBlockInput | undefined;
  const askOutput = unwrapOutput(block.toolOutput);

  const question = askInput?.question || '';
  const rawOptions = askInput?.options;
  const options: string[] = Array.isArray(rawOptions) ? rawOptions : (typeof rawOptions === 'string' ? [rawOptions] : []);
  const multiple = askInput?.multiple ?? false;
  const allowCustom = askInput?.allowCustom ?? true;
  const timeoutSeconds = askInput?.timeoutSeconds ?? null;
  const context = askInput?.context;

  // Initialize checked indices for multi-select (pre-check recommended = index 0)
  // Use block.toolCallId as dep to uniquely identify each ask_user invocation
  useEffect(() => {
    if (multiple && options.length > 0) {
      setCheckedIndices(new Set([0]));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.toolCallId]);

  // 是否已经有结果（从持久化数据恢复，或工具已完成）
  const isResolved = Boolean(askOutput) || block.status === 'success' || block.status === 'error';

  // 最终显示的选择结果
  const resolvedTexts: string[] | null = askOutput?.selected ?? localSelectedTexts;
  const resolvedCustomText: string | null = askOutput?.custom_text ?? localCustomText;
  const resolvedSource = askOutput?.source ?? localSource;

  // 发送回答到后端 (unified for both modes)
  const handleSubmit = useCallback(
    async (
      selectedTexts: string[],
      selectedIndices: number[],
      customText: string | null,
      source: string
    ) => {
      if (hasResponded || isResponding || isResolved) return;

      setIsResponding(true);
      setLocalSelectedTexts(selectedTexts);
      setLocalCustomText(customText);
      setLocalSource(source);

      try {
        await invoke('chat_v2_ask_user_respond', {
          toolCallId: block.toolCallId,
          selectedTexts,
          selectedIndices,
          customText: customText || null,
          source,
        });
        setHasResponded(true);
      } catch (error: unknown) {
        console.error('[AskUserBlock] Failed to send response:', error);
        // 即使发送失败也标记为已回答，避免 UI 卡住
        setHasResponded(true);
      } finally {
        setIsResponding(false);
      }
    },
    [block.toolCallId, hasResponded, isResponding, isResolved]
  );

  // Single-select: click option → immediately submit
  const handleSingleSelect = useCallback(
    (index: number, text: string) => {
      handleSubmit([text], [index], null, 'user_click');
    },
    [handleSubmit]
  );

  // Multi-select: toggle checkbox
  const handleToggleCheck = useCallback(
    (index: number) => {
      setCheckedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    []
  );

  // Multi-select: confirm button
  const handleMultiConfirm = useCallback(() => {
    const indices = Array.from(checkedIndices).sort((a, b) => a - b);
    const texts = indices.map((i) => options[i]).filter(Boolean);
    const trimmedCustom = customInput.trim();

    let source: string;
    if (texts.length > 0 && trimmedCustom) {
      source = 'mixed';
    } else if (trimmedCustom) {
      source = 'custom_input';
    } else {
      source = 'user_click';
    }

    handleSubmit(texts, indices, trimmedCustom || null, source);
  }, [checkedIndices, options, customInput, handleSubmit]);

  // 处理自定义输入提交 (single-select mode only)
  const handleCustomSubmit = useCallback(() => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    handleSubmit([], [], trimmed, 'custom_input');
  }, [customInput, handleSubmit]);

  // 倒计时逻辑（纯视觉倒计时，超时提交由后端统一处理）
  // 仅在设置了 timeoutSeconds 时启用
  // 后端超时后会发射 tool_call_end 事件，更新 block.toolOutput 触发 resolved 视图
  useEffect(() => {
    if (!timeoutSeconds || hasResponded || isResolved || remainingSeconds === null || remainingSeconds <= 0) return;

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [timeoutSeconds, hasResponded, isResolved, remainingSeconds]);

  // 新的提问到达时重置状态
  useEffect(() => {
    if (block.status === 'running') {
      setRemainingSeconds(timeoutSeconds);
      setHasResponded(false);
      setIsResponding(false);
      setCustomInput('');
      setCheckedIndices(new Set());
      setLocalSelectedTexts(null);
      setLocalCustomText(null);
      setLocalSource(null);
    }
  }, [block.toolCallId, block.status, timeoutSeconds]);

  // 来源文案映射
  const sourceLabel = useMemo(() => {
    switch (resolvedSource) {
      case 'user_click':
        return t('askUser.sourceUserClick');
      case 'custom_input':
        return t('askUser.sourceCustomInput');
      case 'mixed':
        return t('askUser.sourceMixed', { defaultValue: '混合选择' });
      case 'timeout':
        return t('askUser.sourceTimeout');
      case 'channel_closed':
        return t('askUser.sourceChannelClosed');
      default:
        return resolvedSource || '';
    }
  }, [resolvedSource, t]);

  // 如果没有输入数据（preparing 状态），显示加载中
  if (!askInput) {
    return (
      <div className="rounded-lg border border-border/50 bg-card px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ChatCircleDots size={16} />
          <span>{t('askUser.preparing')}</span>
        </div>
      </div>
    );
  }

  // ========== 已回答状态：只读视图 ==========
  if (isResolved || hasResponded) {
    // Build display text from resolved data
    const displayParts: string[] = [];
    if (resolvedTexts && resolvedTexts.length > 0) {
      displayParts.push(resolvedTexts.join(', '));
    }
    if (resolvedCustomText) {
      displayParts.push(resolvedCustomText);
    }
    const displayText = displayParts.join(' + ') || t('askUser.autoSelected', { defaultValue: '（自动选择）' });

    return (
      <div className="overflow-hidden rounded-[var(--radius-shell-row)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-content-subtle)]">
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-[color:var(--border-soft)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
          <Check size={16} className="text-[color:hsl(var(--success)/0.8)]" />
          <span className="text-sm font-medium text-[color:var(--text-primary)]">
            {question}
          </span>
        </div>
        {/* 结果 */}
        <div className="px-3 py-2 flex items-center gap-2 text-sm">
          <span className="text-[color:var(--text-muted)]">
            {t('askUser.selected')}:
          </span>
          <span className="font-medium text-[color:var(--text-primary)]">
            {displayText}
          </span>
          {resolvedSource && (
            <span className="text-xs text-[color:var(--text-muted)]">
              ({sourceLabel})
            </span>
          )}
        </div>
      </div>
    );
  }

  // ========== 活跃状态：交互式提问卡片 ==========
  return (
    <div className="overflow-hidden rounded-[var(--radius-shell-row)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-content-subtle)]">
      {/* 头部：问题 + 倒计时 */}
      <div className="flex items-center gap-2 border-b border-[color:var(--border-soft)] bg-[color:var(--surface-panel-strong)] px-3 py-2">
          <ChatCircleDots size={16} className="flex-shrink-0 text-[color:var(--text-secondary)]" />
        <span className="flex-1 text-sm font-medium text-[color:var(--text-primary)]">
          {question}
        </span>
        {remainingSeconds !== null && remainingSeconds > 0 && (
          <div className="flex flex-shrink-0 items-center gap-1 text-xs text-[color:var(--text-muted)]">
            <Clock size={14} />
            <span>{remainingSeconds}s</span>
          </div>
        )}
      </div>

      {/* 上下文说明 */}
      {context && (
        <div className="border-b border-[color:var(--border-soft)] px-3 py-1.5 text-xs text-[color:var(--text-muted)]">
          {context}
        </div>
      )}

      {/* 选项列表 */}
      <div className="px-3 py-2 space-y-1.5">
        {multiple ? (
          // ===== Multi-select: checkboxes =====
          <>
            {options.map((option, index) => {
              const isRecommended = index === 0;
              const isChecked = checkedIndices.has(index);
              return (
                <label
                  key={index}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-shell-control)] border px-3 py-2 transition-colors',
                    isChecked
                      ? 'border-[color:var(--border-strong)] bg-[color:var(--interactive-selected)]'
                      : isRecommended
                        ? 'border-[color:var(--border-soft)] bg-[color:var(--surface-panel-strong)] hover:bg-[color:var(--interactive-hover)]'
                        : 'border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] hover:bg-[color:var(--interactive-hover)]',
                    isResponding && 'opacity-50 pointer-events-none'
                  )}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => handleToggleCheck(index)}
                    disabled={isResponding}
                  />
                  <span className="flex-1 text-sm text-[color:var(--text-primary)]">{option}</span>
                  {isRecommended && (
                    <span className="flex flex-shrink-0 items-center gap-1 text-xs text-[color:var(--text-secondary)]">
                      <Star size={12} className="fill-current" />
                      {t('askUser.recommended')}
                    </span>
                  )}
                </label>
              );
            })}
          </>
        ) : (
          // ===== Single-select: buttons =====
          options.map((option, index) => {
            const isRecommended = index === 0;
            return (
              <NotionButton
                key={index}
                variant={isRecommended ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => handleSingleSelect(index, option)}
                disabled={isResponding}
                className={cn(
                  'w-full !justify-start gap-2 !px-3 !py-2 text-left',
                  'border',
                  isRecommended
                    ? 'border-[color:var(--border-soft)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-primary)] hover:bg-[color:var(--interactive-hover)]'
                    : 'border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] text-[color:var(--text-primary)] hover:bg-[var(--interactive-hover)]',
                  isResponding && 'opacity-50'
                )}
              >
                <span className="flex-1">{option}</span>
                {isRecommended && (
                  <span className="flex flex-shrink-0 items-center gap-1 text-xs text-[color:var(--text-secondary)]">
                    <Star className="w-3 h-3 fill-current" />
                    {t('askUser.recommended')}
                  </span>
                )}
              </NotionButton>
            );
          })
        )}
      </div>

      {/* Multi-select confirm button */}
      {multiple && (
        <div className="px-3 pb-2">
          <NotionButton
            variant="primary"
            size="sm"
            onClick={handleMultiConfirm}
            disabled={isResponding || (checkedIndices.size === 0 && !customInput.trim())}
            className="w-full"
          >
            <Check size={14} className="mr-1.5" />
            {t('askUser.confirmSelection', { defaultValue: '确认选择' })}
          </NotionButton>
        </div>
      )}

      {/* 自定义输入 (only when allowCustom is true) */}
      {allowCustom && (
        <div className="px-3 pb-2 flex gap-2">
          <Input
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
            placeholder={t('askUser.customPlaceholder')}
            disabled={isResponding}
            className={cn(
              'flex-1 px-3 py-1.5 text-sm rounded-md border border-border/50',
              'bg-background placeholder:text-muted-foreground/50',
              'focus:outline-none focus:ring-1 focus:ring-[color:var(--input-shell-focus)]',
              isResponding && 'opacity-50 cursor-not-allowed'
            )}
          />
          {!multiple && (
            <NotionButton
              variant="primary"
              size="sm"
              onClick={handleCustomSubmit}
              disabled={isResponding || !customInput.trim()}
              iconOnly
              aria-label="send"
            >
              <PaperPlaneRight size={14} />
            </NotionButton>
          )}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// 注册块类型
// ============================================================================

blockRegistry.register('ask_user', {
  type: 'ask_user',
  component: AskUserBlockComponent,
  onAbort: 'keep-content',
});

export { AskUserBlockComponent };
export default AskUserBlockComponent;
