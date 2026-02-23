/**
 * Chat V2 - 用户提问块组件
 *
 * 在工具调用时间线中渲染一个交互式提问卡片，支持：
 * - 3 个固定选项（其中一个标记为推荐）
 * - 自定义输入框
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
  MessageCircleQuestion,
  Check,
  Clock,
  Star,
  Send,
} from 'lucide-react';

import type { BlockComponentProps } from '../../registry/blockRegistry';
import { blockRegistry } from '../../registry/blockRegistry';
import { cn } from '@/utils/cn';

// ============================================================================
// 类型定义
// ============================================================================

/** 提问块输入数据（LLM 工具调用参数） */
interface AskUserBlockInput {
  question: string;
  options: string[];
  recommended: number;
  context?: string;
}

/** 提问块输出数据（用户回答结果） */
interface AskUserBlockOutput {
  question: string;
  selected: string;
  selected_index: number;
  source: string; // "user_click" | "custom_input" | "timeout" | "channel_closed"
  options: string[];
  recommended: number;
}

/** 从 toolOutput 中解包 result（后端发送 { result: actualOutput, durationMs }） */
function unwrapOutput(toolOutput: unknown): AskUserBlockOutput | undefined {
  if (!toolOutput || typeof toolOutput !== 'object') return undefined;
  const obj = toolOutput as Record<string, unknown>;
  // 后端发送格式: { result: { question, selected, ... }, durationMs: N }
  if (obj.result && typeof obj.result === 'object') {
    return obj.result as AskUserBlockOutput;
  }
  // 直接就是 output
  if (obj.question && obj.selected) {
    return obj as unknown as AskUserBlockOutput;
  }
  return undefined;
}

// ============================================================================
// 超时时间常量
// ============================================================================

const TIMEOUT_SECONDS = 30;

// ============================================================================
// 组件实现
// ============================================================================

const AskUserBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('chatV2');
  const [remainingSeconds, setRemainingSeconds] = useState(TIMEOUT_SECONDS);
  const [hasResponded, setHasResponded] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [localSelectedIndex, setLocalSelectedIndex] = useState<number | null>(null);
  const [localSelectedText, setLocalSelectedText] = useState<string | null>(null);
  const [localSource, setLocalSource] = useState<string | null>(null);

  // 解析块数据
  const askInput = block.toolInput as unknown as AskUserBlockInput | undefined;
  const askOutput = unwrapOutput(block.toolOutput);

  const question = askInput?.question || '';
  const rawOptions = askInput?.options;
  const options: string[] = Array.isArray(rawOptions) ? rawOptions : (typeof rawOptions === 'string' ? [rawOptions] : []);
  const recommended = askInput?.recommended ?? 0;
  const context = askInput?.context;

  // 是否已经有结果（从持久化数据恢复，或工具已完成）
  const isResolved = Boolean(askOutput) || block.status === 'success' || block.status === 'error';

  // 最终显示的选择结果
  const resolvedText = askOutput?.selected || localSelectedText;
  const resolvedSource = askOutput?.source || localSource;
  const resolvedIndex = askOutput?.selected_index ?? localSelectedIndex;

  // 发送回答到后端
  const handleSelect = useCallback(
    async (index: number, text: string, source: string) => {
      if (hasResponded || isResponding || isResolved) return;

      setIsResponding(true);
      setLocalSelectedIndex(index);
      setLocalSelectedText(text);
      setLocalSource(source);

      try {
        await invoke('chat_v2_ask_user_respond', {
          toolCallId: block.toolCallId,
          selectedText: text,
          selectedIndex: index,
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

  // 处理自定义输入提交
  const handleCustomSubmit = useCallback(() => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    handleSelect(-1, trimmed, 'custom_input');
  }, [customInput, handleSelect]);

  // 倒计时逻辑（参考 ToolApprovalCard）
  useEffect(() => {
    if (hasResponded || isResolved || remainingSeconds <= 0) return;

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          // 超时：自动选择推荐选项
          const recommendedText = options[recommended] || '';
          handleSelect(recommended, recommendedText, 'timeout');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [hasResponded, isResolved, remainingSeconds, options, recommended, handleSelect]);

  // 新的提问到达时重置状态
  useEffect(() => {
    if (block.status === 'running') {
      setRemainingSeconds(TIMEOUT_SECONDS);
      setHasResponded(false);
      setIsResponding(false);
      setCustomInput('');
      setLocalSelectedIndex(null);
      setLocalSelectedText(null);
      setLocalSource(null);
    }
  }, [block.toolCallId, block.status]);

  // 来源文案映射
  const sourceLabel = useMemo(() => {
    switch (resolvedSource) {
      case 'user_click':
        return t('askUser.sourceUserClick', { defaultValue: '用户选择' });
      case 'custom_input':
        return t('askUser.sourceCustomInput', { defaultValue: '自定义输入' });
      case 'timeout':
        return t('askUser.sourceTimeout', { defaultValue: '超时自动选择' });
      case 'channel_closed':
        return t('askUser.sourceChannelClosed', { defaultValue: '连接中断' });
      default:
        return resolvedSource || '';
    }
  }, [resolvedSource, t]);

  // 如果没有输入数据（preparing 状态），显示加载中
  if (!askInput) {
    return (
      <div className="rounded-lg border border-border/50 bg-card px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MessageCircleQuestion className="w-4 h-4" />
          <span>{t('askUser.preparing', { defaultValue: '正在准备提问...' })}</span>
        </div>
      </div>
    );
  }

  // ========== 已回答状态：只读视图 ==========
  if (isResolved || hasResponded) {
    return (
      <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/10 overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-2 px-3 py-2 bg-green-100/50 dark:bg-green-900/20">
          <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
          <span className="text-sm font-medium text-green-700 dark:text-green-300">
            {question}
          </span>
        </div>
        {/* 结果 */}
        <div className="px-3 py-2 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t('askUser.selected', { defaultValue: '已选择' })}:
          </span>
          <span className="font-medium">{resolvedText}</span>
          {resolvedSource && (
            <span className="text-xs text-muted-foreground">
              ({sourceLabel})
            </span>
          )}
        </div>
      </div>
    );
  }

  // ========== 活跃状态：交互式提问卡片 ==========
  return (
    <div className="rounded-lg border-2 border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-950/20 overflow-hidden">
      {/* 头部：问题 + 倒计时 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-blue-100/50 dark:bg-blue-900/20">
        <MessageCircleQuestion className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
        <span className="text-sm font-medium text-blue-800 dark:text-blue-200 flex-1">
          {question}
        </span>
        <div className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
          <Clock className="w-3.5 h-3.5" />
          <span>{remainingSeconds}s</span>
        </div>
      </div>

      {/* 上下文说明 */}
      {context && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-blue-200/50 dark:border-blue-800/50">
          {context}
        </div>
      )}

      {/* 选项列表 */}
      <div className="px-3 py-2 space-y-1.5">
        {options.map((option, index) => {
          const isRecommended = index === recommended;
          return (
            <NotionButton
              key={index}
              variant="ghost"
              size="sm"
              onClick={() => handleSelect(index, option, 'user_click')}
              disabled={isResponding}
              className={cn(
                'w-full !justify-start gap-2 !px-3 !py-2 text-left',
                'border',
                isRecommended
                  ? 'border-blue-300 dark:border-blue-600 bg-blue-100/60 dark:bg-blue-900/30 hover:bg-blue-200/60 dark:hover:bg-blue-800/40'
                  : 'border-border/50 bg-card hover:bg-muted/50',
                isResponding && 'opacity-50'
              )}
            >
              <span className="flex-1">{option}</span>
              {isRecommended && (
                <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 flex-shrink-0">
                  <Star className="w-3 h-3 fill-current" />
                  {t('askUser.recommended', { defaultValue: '推荐' })}
                </span>
              )}
            </NotionButton>
          );
        })}
      </div>

      {/* 自定义输入 */}
      <div className="px-3 pb-2 flex gap-2">
        <input
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleCustomSubmit();
            }
          }}
          placeholder={t('askUser.customPlaceholder', { defaultValue: '或输入自定义回答...' })}
          disabled={isResponding}
          className={cn(
            'flex-1 px-3 py-1.5 text-sm rounded-md border border-border/50',
            'bg-background placeholder:text-muted-foreground/50',
            'focus:outline-none focus:ring-1 focus:ring-blue-400',
            isResponding && 'opacity-50 cursor-not-allowed'
          )}
        />
        <NotionButton
          variant="primary"
          size="sm"
          onClick={handleCustomSubmit}
          disabled={isResponding || !customInput.trim()}
          iconOnly
          className="bg-blue-600 hover:bg-blue-700 text-white"
          aria-label="send"
        >
          <Send className="w-3.5 h-3.5" />
        </NotionButton>
      </div>
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
