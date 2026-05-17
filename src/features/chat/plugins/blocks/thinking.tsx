/**
 * Chat V2 - 思维链块渲染插件
 *
 * 渲染 AI 的思维链/推理过程
 * 自执行注册：import 即注册
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingMarkdownRenderer } from '../../components/renderers';

const ThinkingBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');
  const contentId = useId();
  const [isExpanded, setIsExpanded] = useState(isStreaming ?? false);
  const isManuallyControlled = useRef(false);

  useEffect(() => {
    if (isManuallyControlled.current) return;
    setIsExpanded(!!isStreaming);
  }, [isStreaming]);

  const toggleExpanded = useCallback(() => {
    isManuallyControlled.current = true;
    setIsExpanded((prev) => !prev);
  }, []);

  const content = block.content || '';
  const hasContent = content.trim().length > 0;

  if (!hasContent && !isStreaming) {
    return null;
  }

  return (
    <div
      className={cn(
        'rounded-lg border',
        'bg-muted/30 border-border/50',
        'dark:bg-muted/20 dark:border-border/30',
        'transition-colors'
      )}
    >
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="w-full !justify-start gap-2 !px-3 !py-2 !rounded-lg text-muted-foreground"
      >
        {isExpanded ? <CaretDown size={16} /> : <CaretRight size={16} />}
        <span className="font-medium">{t('blocks.thinking.title')}</span>
        {isStreaming && (
          <span className="flex items-center gap-1 ml-auto">
            <span className="w-1.5 h-1.5 bg-primary rounded-full" />
            <span className="text-xs">{t('blocks.thinking.streaming')}</span>
          </span>
        )}
      </NotionButton>

      {isExpanded && (
        <div
          id={contentId}
          role="region"
          aria-label={t('blocks.thinking.title')}
          className={cn(
            'px-3 pb-3',
            'border-t border-border/30',
            'text-muted-foreground',
            'thinking-content'
          )}
        >
          <div className="pt-2">
            <StreamingMarkdownRenderer
              content={content}
              isStreaming={isStreaming ?? false}
              blockId={block.id}
              messageId={block.messageId}
            />
          </div>
        </div>
      )}
    </div>
  );
});

blockRegistry.register('thinking', {
  type: 'thinking',
  component: ThinkingBlock,
  onAbort: 'keep-content',
});

export { ThinkingBlock };
