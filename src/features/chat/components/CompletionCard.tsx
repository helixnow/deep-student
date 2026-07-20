/**
 * 任务完成卡片组件
 *
 * 当 Agent 调用 attempt_completion 工具时显示，展示任务完成结果。
 *
 * 两种形态：
 * - variant="card"：完整卡片（BlockRenderer / mcpTool.tsx 路径使用）
 * - variant="inline"：轻量内联形态（ActivityTimeline 主路径使用，贴合时间线左轨）
 *
 * 设计文档：src/features/chat/docs/29-ChatV2-Agent能力增强改造方案.md 第 5.4 节
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Copy, Terminal } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型定义
// ============================================================================

export interface CompletionData {
  /** 任务完成结果 */
  result: string;
  /** 建议执行的命令（可选） */
  command?: string;
}

export interface CompletionCardProps {
  data: CompletionData;
  /** card = 完整卡片（默认）；inline = 时间线内联轻量形态 */
  variant?: 'card' | 'inline';
  className?: string;
}

// ============================================================================
// attempt_completion 工具识别 / 数据提取
// ============================================================================

/**
 * 判断是否为 attempt_completion 工具。
 * 与 mcpTool.tsx 的前缀剥离规则一致：兼容 builtin- / builtin: / mcp_ / mcp.tools. / 点分命名。
 */
export function isAttemptCompletionTool(name: string | undefined): boolean {
  if (!name) return false;
  const stripped = name
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^.*\./, '');
  return stripped === 'attempt_completion';
}

/**
 * 从工具输入/输出中提取完成数据。
 * 后端 emit_end 结构：{ result: { completed, result, command, task_completed }, durationMs }；
 * 提取失败时回退到 toolInput 中的 result / command 字段。
 */
export function extractCompletionData(
  toolInput: Record<string, unknown> | undefined,
  toolOutput: unknown,
): CompletionData {
  let inner: { result?: unknown; command?: unknown } | undefined;
  if (toolOutput && typeof toolOutput === 'object') {
    const raw = toolOutput as Record<string, unknown>;
    inner = raw.result && typeof raw.result === 'object'
      ? raw.result as { result?: unknown; command?: unknown }
      : raw;
  }
  const result =
    (typeof inner?.result === 'string' ? inner.result : '') ||
    (typeof toolInput?.result === 'string' ? toolInput.result : '');
  const command =
    (typeof inner?.command === 'string' && inner.command ? inner.command : undefined) ??
    (typeof toolInput?.command === 'string' && toolInput.command ? toolInput.command : undefined);
  return { result, command };
}

// ============================================================================
// 组件实现
// ============================================================================

const SuggestedCommand: React.FC<{ command: string; compact?: boolean }> = ({ command, compact }) => {
  const { t } = useTranslation('chatV2');

  const handleCopyCommand = useCallback(async () => {
    try {
      await copyTextToClipboard(command);
      showGlobalNotification('success', t('completion.commandCopied'));
    } catch {
      showGlobalNotification('error', t('completion.copyFailed'));
    }
  }, [command, t]);

  return (
    <div className={cn('rounded-md bg-muted', compact ? 'p-2' : 'p-3')}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Terminal size={14} />
          {t('completion.suggestedCommand')}
        </span>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={handleCopyCommand}
          className="h-6 px-2 text-xs"
        >
          <Copy size={12} className="mr-1" />
          {t('completion.copy')}
        </NotionButton>
      </div>
      <code className="block overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-sm">
        {command}
      </code>
    </div>
  );
};

export const CompletionCard: React.FC<CompletionCardProps> = ({ data, variant = 'card', className }) => {
  const { t } = useTranslation('chatV2');

  if (variant === 'inline') {
    // 时间线内联形态：无厚边框卡片，贴合左轨节奏；颜色走语义 token
    return (
      <div
        className={cn(
          'rounded-[var(--chat-radius-md,12px)] border border-success/30 bg-success/5 px-3 py-2 space-y-2',
          className,
        )}
      >
        <div className="flex items-center gap-1.5 text-sm font-medium text-success">
          <CheckCircle size={16} weight="fill" />
          {t('completion.title')}
        </div>
        {data.result && (
          <div className="whitespace-pre-wrap break-words text-sm text-foreground">
            {data.result}
          </div>
        )}
        {data.command && <SuggestedCommand command={data.command} compact />}
      </div>
    );
  }

  return (
    <Card
      className={cn(
        'border border-success/40 bg-success/5',
        className
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-success">
          <CheckCircle size={20} weight="fill" />
          {t('completion.title')}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* 结果文本 */}
        <div className="text-sm text-foreground whitespace-pre-wrap break-words">{data.result}</div>

        {/* 建议命令（如果有） */}
        {data.command && <SuggestedCommand command={data.command} />}
      </CardContent>
    </Card>
  );
};

export default CompletionCard;
