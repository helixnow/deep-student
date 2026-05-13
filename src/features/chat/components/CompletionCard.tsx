/**
 * 任务完成卡片组件
 *
 * 当 Agent 调用 attempt_completion 工具时显示，展示任务完成结果。
 *
 * 设计文档：src/chat-v2/docs/29-ChatV2-Agent能力增强改造方案.md 第 5.4 节
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Copy, Terminal } from 'lucide-react';
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
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

export const CompletionCard: React.FC<CompletionCardProps> = ({ data, className }) => {
  const { t } = useTranslation('chatV2');

  // 复制命令到剪贴板
  const handleCopyCommand = useCallback(async () => {
    if (!data.command) return;

    try {
      await copyTextToClipboard(data.command);
      showGlobalNotification('success', t('completion.commandCopied'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('completion.copyFailed'));
    }
  }, [data.command, t]);

  return (
    <Card
      className={cn(
        'border-2 border-green-400 dark:border-green-600 bg-green-50 dark:bg-green-900/20',
        className
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-5 w-5" />
          {t('completion.title')}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* 结果文本 */}
        <div className="text-sm text-foreground whitespace-pre-wrap">{data.result}</div>

        {/* 建议命令（如果有） */}
        {data.command && (
          <div className="rounded-md bg-muted p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" />
                {t('completion.suggestedCommand')}
              </span>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleCopyCommand}
                className="h-6 px-2 text-xs"
              >
                <Copy className="h-3 w-3 mr-1" />
                {t('completion.copy')}
              </NotionButton>
            </div>
            <code className="block text-sm font-mono bg-background rounded px-2 py-1.5 overflow-x-auto">
              {data.command}
            </code>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default CompletionCard;
