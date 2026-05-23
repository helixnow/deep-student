/**
 * Chat V2 — 思维链块渲染插件
 *
 * 渲染 AI 的思维链/推理过程。
 * 视觉层级：左品牌色 accent bar + 卡片容器，与普通消息块拉开差距。
 * 动画：CSS opacity 过渡 + contain:layout 隔离布局重算。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { Brain, CaretDown } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingBlockRenderer } from '../../components/renderers';

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
        'think-block',
        isExpanded && 'think-block--expanded',
      )}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="think-header"
      >
        <Brain size={15} className="think-header-icon" weight="duotone" />
        <span className="think-header-title">{t('blocks.thinking.title')}</span>

        {isStreaming && (
          <span className="think-status-pulse">
            <span className="think-pulse-dot" />
            <span className="think-pulse-label">{t('blocks.thinking.streaming')}</span>
          </span>
        )}

        <span className={cn('think-chevron', isExpanded && 'think-chevron--expanded')}>
          <CaretDown size={14} weight="bold" />
        </span>
      </button>

      <div
        id={contentId}
        role="region"
        aria-label={t('blocks.thinking.title')}
        className={cn(
          'think-content-wrapper',
          isExpanded && 'think-content-wrapper--expanded',
        )}
      >
        <div className="think-content">
          <StreamingBlockRenderer
            content={content}
            isStreaming={isStreaming ?? false}
            blockId={block.id}
            messageId={block.messageId}
          />
        </div>
      </div>
    </div>
  );
});

blockRegistry.register('thinking', {
  type: 'thinking',
  component: ThinkingBlock,
  onAbort: 'keep-content',
});

export { ThinkingBlock };
