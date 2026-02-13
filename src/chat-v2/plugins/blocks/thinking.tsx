/**
 * Chat V2 - 思维链块渲染插件
 *
 * 渲染 AI 的思维链/推理过程
 * 自执行注册：import 即注册
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingMarkdownRenderer } from '../../components/renderers';

// ============================================================================
// 思维链块组件
// ============================================================================

/**
 * ThinkingBlock - 思维链块渲染组件
 *
 * 功能：
 * 1. 可折叠/展开的思维链内容
 * 2. 流式渲染支持
 * 3. 暗色/亮色主题支持
 */
const ThinkingBlock: React.FC<BlockComponentProps> = ({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const content = block.content || '';
  const hasContent = content.trim().length > 0;

  // 无内容时不渲染
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
      {/* 折叠头部 */}
      <button
        onClick={toggleExpanded}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2',
          'text-sm text-muted-foreground',
          'hover:bg-muted/50 transition-colors',
          'rounded-lg'
        )}
      >
        {/* 展开/折叠图标 */}
        {isExpanded ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}

        {/* 标题 */}
        <span className="font-medium">{t('blocks.thinking.title')}</span>

        {/* 流式指示器 */}
        {isStreaming && (
          <span className="flex items-center gap-1 ml-auto">
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
            <span className="text-xs">{t('blocks.thinking.streaming')}</span>
          </span>
        )}
      </button>

      {/* 内容区域 */}
      {isExpanded && (
        <div
          className={cn(
            'px-3 pb-3',
            'border-t border-border/30',
            'text-muted-foreground',
            'thinking-content'
          )}
          style={{ fontSize: '0.8rem' }}
        >
          <div className="pt-2">
            <StreamingMarkdownRenderer
              content={content}
              isStreaming={isStreaming ?? false}
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('thinking', {
  type: 'thinking',
  component: ThinkingBlock,
  onAbort: 'keep-content', // 中断时保留已生成内容
});

// 导出组件（可选，用于测试）
export { ThinkingBlock };
