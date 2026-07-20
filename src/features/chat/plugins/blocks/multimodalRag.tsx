/**
 * Chat V2 - 多模态检索块渲染插件
 *
 * 渲染多模态知识库（图片/图文）检索结果。
 * 主路径下该块被 SOURCE_BLOCK_TYPES 过滤、由统一来源面板聚合展示；
 * 本插件用于兜底渲染（历史数据、变体视图等绕过过滤的路径），
 * 避免 multimodal_rag 块落到 GenericBlock 的开发者向 JSON dump。
 *
 * 自执行注册：import 即注册
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { Images, CircleNotch, WarningCircle, MagnifyingGlass } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import { convertBackendSources, type BackendSourceInfo } from './components/types';

/**
 * 后端多模态检索结果的原始格式（与 retrieval 事件 toolOutput 对齐）
 */
interface BackendMultimodalRagResult {
  sources?: BackendSourceInfo[];
  query?: string;
  totalResults?: number;
  durationMs?: number;
}

// ============================================================================
// MultimodalRag 块组件
// ============================================================================

const MultimodalRagBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  const data = block.toolOutput as BackendMultimodalRagResult | undefined;

  const sources = useMemo(() => {
    return convertBackendSources(data?.sources, 'multimodal', block.id);
  }, [data?.sources, block.id]);

  const query = data?.query;

  const isPending = block.status === 'pending';
  const isRunning = block.status === 'running' || isStreaming;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';

  const statsText = useMemo(() => {
    if (!isSuccess || sources.length === 0) return null;
    return t('blocks.multimodalRag.statsSimple', { count: sources.length });
  }, [isSuccess, sources.length, t]);

  return (
    <div
      className={cn(
        'rounded-lg border',
        'bg-muted/30 border-border/50',
        'dark:bg-muted/20 dark:border-border/30',
        'transition-colors'
      )}
    >
      {/* 头部 */}
      <div className={cn('flex items-center gap-2 px-3 py-2', 'border-b border-border/30')}>
        <div
          className={cn(
            'flex-shrink-0 flex items-center justify-center',
            'w-6 h-6 rounded bg-primary/10',
            'dark:bg-primary/20'
          )}
        >
          <Images size={16} className="text-primary" />
        </div>

        <span className="font-medium text-sm text-foreground">
          {t('blocks.multimodalRag.title')}
        </span>

        {(isPending || isRunning) && (
          <span className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
            <CircleNotch size={12} className="animate-spin" />
            <span>{t('blocks.multimodalRag.searching')}</span>
          </span>
        )}

        {isError && (
          <span className="flex items-center gap-1 ml-auto text-xs text-destructive">
            <WarningCircle size={12} />
            <span>{t('blocks.multimodalRag.error')}</span>
          </span>
        )}

        {isSuccess && statsText && (
          <span className="ml-auto text-xs text-muted-foreground">{statsText}</span>
        )}
      </div>

      {/* 内容区域 */}
      <div className="p-3">
        {query && (
          <div className="flex items-center gap-2 mb-3 text-sm text-muted-foreground">
            <MagnifyingGlass size={16} />
            <span className="truncate" title={query}>
              {query}
            </span>
          </div>
        )}

        {(isPending || isRunning) && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CircleNotch size={20} className="animate-spin" />
              <span className="text-sm">{t('blocks.multimodalRag.loading')}</span>
            </div>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-destructive">
              <WarningCircle size={20} />
              <span className="text-sm">
                {block.error || t('blocks.multimodalRag.errorMessage')}
              </span>
            </div>
          </div>
        )}

        {isSuccess && sources.length > 0 && (
          <SourceList sources={sources} maxVisible={3} defaultExpanded={false} />
        )}

        {isSuccess && sources.length === 0 && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <span className="text-sm">{t('blocks.multimodalRag.noResults')}</span>
          </div>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('multimodal_rag', {
  type: 'multimodal_rag',
  component: MultimodalRagBlock,
  onAbort: 'mark-error',
});

export { MultimodalRagBlock };
