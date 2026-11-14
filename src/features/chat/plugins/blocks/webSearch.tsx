/**
 * Chat V2 - 网络搜索块渲染插件
 *
 * 渲染网络搜索检索结果
 * 自执行注册：import 即注册
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import {
  RetrievalBlockShell,
  RetrievalErrorNotice,
  RetrievalQueryRow,
} from './components/RetrievalBlockShell';
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
  const isActive = isPending || isRunning;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';
  const [isExpanded, setIsExpanded] = useState(true);

  const durationMs =
    block.startedAt && block.endedAt
      ? block.endedAt - block.startedAt
      : data?.durationMs;

  // 统计信息
  const statsText = useMemo(() => {
    if (!isSuccess) return null;
    if (sources.length === 0) return t('blocks.webSearch.noResults');
    if (totalResults > sources.length) {
      return t('blocks.webSearch.stats', {
        shown: sources.length,
        total: totalResults,
      });
    }
    return t('blocks.webSearch.statsSimple', { count: sources.length });
  }, [isSuccess, sources.length, totalResults, t]);

  const statusText = isActive
    ? t('blocks.webSearch.searching')
    : isError
      ? t('blocks.webSearch.error')
      : statsText;

  const hasBody = Boolean(query) || isError || (isSuccess && sources.length > 0);

  return (
    <RetrievalBlockShell
      icon={Globe}
      title={t('blocks.webSearch.title')}
      statusText={statusText}
      badge={
        searchEngine && isSuccess ? (
          <span className="min-w-0 max-w-[40%] shrink-0 truncate rounded-md bg-muted/60 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
            {searchEngine}
          </span>
        ) : undefined
      }
      isActive={!!isActive}
      isError={isError}
      isSuccess={isSuccess}
      durationMs={durationMs}
      collapsible={hasBody}
      isExpanded={isExpanded}
      onToggleExpand={() => setIsExpanded((prev) => !prev)}
    >
      {hasBody ? (
        <>
          {query && <RetrievalQueryRow query={query} />}
          {isError && (
            <RetrievalErrorNotice
              message={block.error || t('blocks.webSearch.errorMessage')}
            />
          )}
          {isSuccess && sources.length > 0 && (
            <SourceList sources={sources} maxVisible={3} defaultExpanded={false} />
          )}
        </>
      ) : null}
    </RetrievalBlockShell>
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
