/**
 * Chat V2 - 网络搜索块渲染插件
 *
 * 渲染网络搜索检索结果
 * 自执行注册：import 即注册
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { Globe, CircleNotch, WarningCircle, MagnifyingGlass } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import { convertBackendSources, type BackendSourceInfo } from './components/types';

/**
 * 后端 WebSearch 检索结果的原始格式
 */
interface BackendWebSearchResult {
  sources?: BackendSourceInfo[];
  query?: string;
  searchEngine?: string;
  totalResults?: number;
  durationMs?: number;
}

// ============================================================================
// WebSearch 块组件
// ============================================================================

/**
 * WebSearchBlock - 网络搜索块渲染组件
 *
 * 功能：
 * 1. 显示搜索状态（加载中、成功、错误）
 * 2. 显示搜索引擎和查询
 * 3. 显示搜索结果列表
 * 4. 暗色/亮色主题支持
 */
const WebSearchBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  // 解析后端数据并转换为前端格式
  const data = block.toolOutput as BackendWebSearchResult | undefined;
  
  // 🔧 关键修复：将后端 SourceInfo 转换为前端 RetrievalSource
  const sources = useMemo(() => {
    return convertBackendSources(data?.sources, 'web_search', block.id);
  }, [data?.sources, block.id]);
  
  const query = data?.query;
  const searchEngine = data?.searchEngine;
  const totalResults = data?.totalResults ?? sources.length;

  // 状态判断
  const isPending = block.status === 'pending';
  const isRunning = block.status === 'running' || isStreaming;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';

  // 统计信息
  const statsText = useMemo(() => {
    if (!isSuccess || sources.length === 0) return null;
    if (totalResults > sources.length) {
      return t('blocks.webSearch.stats', {
        shown: sources.length,
        total: totalResults,
      });
    }
    return t('blocks.webSearch.statsSimple', { count: sources.length });
  }, [isSuccess, sources.length, totalResults, t]);

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
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          'border-b border-border/30'
        )}
      >
        {/* 图标 */}
        <div
          className={cn(
            'flex-shrink-0 flex items-center justify-center',
            'w-6 h-6 rounded bg-green-500/10',
            'dark:bg-green-500/20'
          )}
        >
          <Globe size={16} className="text-green-600 dark:text-green-400" />
        </div>

        {/* 标题 */}
        <span className="font-medium text-sm text-foreground">
          {t('blocks.webSearch.title')}
        </span>

        {/* 搜索引擎标签 */}
        {searchEngine && isSuccess && (
          <span
            className={cn(
              'px-2 py-0.5 rounded-full',
              'bg-green-500/10 text-green-600 text-xs',
              'dark:bg-green-500/20 dark:text-green-400'
            )}
          >
            {searchEngine}
          </span>
        )}

        {/* 状态指示器 */}
        {(isPending || isRunning) && (
          <span className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
            <CircleNotch size={12} className="animate-spin" />
            <span>{t('blocks.webSearch.searching')}</span>
          </span>
        )}

        {isError && (
          <span className="flex items-center gap-1 ml-auto text-xs text-red-600 dark:text-red-400">
            <WarningCircle size={12} />
            <span>{t('blocks.webSearch.error')}</span>
          </span>
        )}

        {isSuccess && statsText && (
          <span className="ml-auto text-xs text-muted-foreground">
            {statsText}
          </span>
        )}
      </div>

      {/* 内容区域 */}
      <div className="p-3">
        {/* 查询信息 */}
        {query && (
          <div className="flex items-center gap-2 mb-3 text-sm text-muted-foreground">
            <MagnifyingGlass size={16} />
            <span className="truncate" title={query}>
              {query}
            </span>
          </div>
        )}

        {/* 加载状态 */}
        {(isPending || isRunning) && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CircleNotch size={20} className="animate-spin" />
              <span className="text-sm">{t('blocks.webSearch.loading')}</span>
            </div>
          </div>
        )}

        {/* 错误状态 */}
        {isError && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <WarningCircle size={20} />
              <span className="text-sm">
                {block.error || t('blocks.webSearch.errorMessage')}
              </span>
            </div>
          </div>
        )}

        {/* 成功状态：来源列表 */}
        {isSuccess && sources.length > 0 && (
          <SourceList
            sources={sources}
            maxVisible={3}
            defaultExpanded={false}
          />
        )}

        {/* 成功但无结果 */}
        {isSuccess && sources.length === 0 && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <span className="text-sm">{t('blocks.webSearch.noResults')}</span>
          </div>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('web_search', {
  type: 'web_search',
  component: WebSearchBlock,
  onAbort: 'mark-error',
});

// 导出组件（可选，用于测试）
export { WebSearchBlock };
