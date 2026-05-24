/**
 * Chat V2 - Compaction Summary 块渲染插件（P1）
 *
 * 渲染一次上下文压缩（compaction）产生的锚定摘要。
 * 摘要内容由后端按"学习状态"模板生成（科目/目标/已掌握/薄弱点/当前任务/…）。
 *
 * 视图语义：
 * - 默认折叠，只显示"🗜️ 上下文已压缩"标签
 * - 展开显示摘要 Markdown 正文
 *
 * 备注：
 *   该 block 由后端一次性产出（status=success，不会流式），所以
 *   `isStreaming` 总为 false，这里不做流式特殊处理。
 *
 * TODO(P3): 增加"查看原始对话"按钮 + 后端 chat_v2_get_compacted_range 命令。
 *
 * 自执行注册：import 即注册。
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { CaretDown, CaretRight, Archive } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingMarkdownRenderer } from '../../components/renderers';

const CompactionSummaryBlock: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const content = block.content || '';
  if (!content.trim()) return null;

  const contentId = `compaction-summary-${block.id}`;

  return (
    <div
      className={cn(
        'rounded-lg border',
        'bg-amber-50/40 border-amber-200/60',
        'dark:bg-amber-900/10 dark:border-amber-800/40',
        'transition-colors'
      )}
    >
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="w-full !justify-start gap-2 !px-3 !py-2 !rounded-lg text-amber-800 dark:text-amber-200"
      >
        {isExpanded ? <CaretDown size={16} /> : <CaretRight size={16} />}
        <Archive size={16} />
        <span className="font-medium">{t('blocks.compactionSummary.title')}</span>
        {!isExpanded && (
          <span className="ml-auto text-xs text-amber-700 dark:text-amber-300">
            {t('blocks.compactionSummary.expandHint')}
          </span>
        )}
      </NotionButton>

      {isExpanded && (
        <div
          id={contentId}
          className={cn(
            'px-3 pb-3 thinking-content',
            'border-t border-amber-200/50 dark:border-amber-800/30',
            'text-foreground/90'
          )}
        >
          <div className="pt-2">
            <StreamingMarkdownRenderer
              content={content}
              isStreaming={false}
              blockId={block.id}
              messageId={block.messageId}
            />
          </div>
          <div className="mt-3 text-xs text-muted-foreground italic">
            {t('blocks.compactionSummary.footnote')}
          </div>
        </div>
      )}
    </div>
  );
});

CompactionSummaryBlock.displayName = 'CompactionSummaryBlock';

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('compaction_summary', {
  type: 'compaction_summary',
  component: CompactionSummaryBlock,
  onAbort: 'keep-content',
});

export { CompactionSummaryBlock };
