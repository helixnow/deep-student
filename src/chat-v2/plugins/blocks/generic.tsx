/**
 * Chat V2 - 通用块渲染插件
 *
 * Fallback 渲染器，用于未注册的块类型
 * 自执行注册：import 即注册
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { HelpCircle, Loader2 } from 'lucide-react';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 通用块组件
// ============================================================================

/**
 * GenericBlock - 通用块渲染组件
 *
 * 功能：
 * 1. 显示块类型
 * 2. 显示块内容（如果有）
 * 3. 显示块状态
 * 4. 流式指示器
 */
const GenericBlock: React.FC<BlockComponentProps> = ({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        'bg-muted/30 border-border/50',
        'dark:bg-muted/20 dark:border-border/30'
      )}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs font-mono text-muted-foreground">
          {t('blocks.generic.type')}: {block.type}
        </span>
        <span
          className={cn(
            'text-xs px-1.5 py-0.5 rounded',
            block.status === 'success' && 'bg-green-500/10 text-green-600 dark:text-green-400',
            block.status === 'error' && 'bg-red-500/10 text-red-600 dark:text-red-400',
            block.status === 'running' && 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
            block.status === 'pending' && 'bg-gray-500/10 text-gray-600 dark:text-gray-400'
          )}
        >
          {block.status}
        </span>
        {isStreaming && (
          <Loader2 className="w-3 h-3 animate-spin text-primary ml-auto" />
        )}
      </div>

      {/* 内容 */}
      {block.content && (
        <pre className="text-sm whitespace-pre-wrap break-words text-foreground bg-background/50 p-2 rounded">
          {block.content}
        </pre>
      )}

      {/* 工具输入 */}
      {block.toolInput && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground mb-1">
            {t('blocks.generic.input')}:
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground bg-background/50 p-2 rounded">
            {JSON.stringify(block.toolInput, null, 2)}
          </pre>
        </div>
      )}

      {/* 工具输出 */}
      {block.toolOutput && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground mb-1">
            {t('blocks.generic.output')}:
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground bg-background/50 p-2 rounded max-h-40 overflow-auto">
            {typeof block.toolOutput === 'string'
              ? block.toolOutput
              : JSON.stringify(block.toolOutput, null, 2)}
          </pre>
        </div>
      )}

      {/* 错误信息 */}
      {block.error && (
        <div className="mt-2 text-sm text-red-600 dark:text-red-400">
          {t('blocks.generic.error')}: {block.error}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 自动注册
// ============================================================================

// 注册为 'generic' 类型（用作 fallback）
blockRegistry.register('generic', {
  type: 'generic',
  component: GenericBlock,
  onAbort: 'mark-error', // 中断时标记为错误
});

// 导出组件（可选，用于测试）
export { GenericBlock };
