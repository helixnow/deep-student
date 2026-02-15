/**
 * Chat V2 - 学术论文搜索块渲染插件
 *
 * 渲染学术论文搜索结果（arXiv / OpenAlex）
 * 自执行注册：import 即注册
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { GraduationCap, Loader2, AlertCircle, Search } from 'lucide-react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import { convertBackendSources, type BackendSourceInfo } from './components/types';

/**
 * 后端学术搜索结果的原始格式
 */
interface BackendAcademicSearchResult {
  sources?: BackendSourceInfo[];
  papers?: Array<Record<string, unknown>>;
  source?: string;
  total_results?: number;
  returned_results?: number;
  note?: string;
}

// ============================================================================
// AcademicSearch 块组件
// ============================================================================

/**
 * AcademicSearchBlock - 学术论文搜索块渲染组件
 *
 * 功能：
 * 1. 显示搜索状态（加载中、成功、错误）
 * 2. 显示搜索来源（arXiv / OpenAlex）
 * 3. 显示论文结果列表（复用 SourceList 组件）
 * 4. 暗色/亮色主题支持
 */
const AcademicSearchBlock: React.FC<BlockComponentProps> = ({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  // 解析后端数据并转换为前端格式
  const data = block.toolOutput as BackendAcademicSearchResult | undefined;

  // 将后端 SourceInfo 转换为前端 RetrievalSource
  const sources = useMemo(() => {
    return convertBackendSources(data?.sources, 'web_search', block.id);
  }, [data?.sources, block.id]);

  const searchSource = data?.source;
  const totalResults = data?.total_results ?? sources.length;

  // 状态判断
  const isPending = block.status === 'pending';
  const isRunning = block.status === 'running' || isStreaming;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';

  // 搜索来源标签
  const sourceLabel = useMemo(() => {
    if (!searchSource) return null;
    switch (searchSource) {
      case 'arxiv':
        return 'arXiv';
      case 'openalex':
        return 'OpenAlex';
      case 'openalex_arxiv_fallback':
        return 'OpenAlex (arXiv)';
      default:
        return searchSource;
    }
  }, [searchSource]);

  // 统计信息
  const statsText = useMemo(() => {
    if (!isSuccess || sources.length === 0) return null;
    if (totalResults > sources.length) {
      return t('blocks.academicSearch.stats', {
        shown: sources.length,
        total: totalResults,
      });
    }
    return t('blocks.academicSearch.statsSimple', { count: sources.length });
  }, [isSuccess, sources.length, totalResults, t]);

  // 查询词（从 toolInput 提取）
  const query = useMemo(() => {
    if (!block.toolInput) return null;
    const input = block.toolInput as Record<string, unknown>;
    return (input.query as string) || null;
  }, [block.toolInput]);

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
            'w-6 h-6 rounded bg-blue-500/10',
            'dark:bg-blue-500/20'
          )}
        >
          <GraduationCap className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        </div>

        {/* 标题 */}
        <span className="font-medium text-sm text-foreground">
          {t('blocks.academicSearch.title')}
        </span>

        {/* 搜索来源标签 */}
        {sourceLabel && isSuccess && (
          <span
            className={cn(
              'px-2 py-0.5 rounded-full',
              'bg-blue-500/10 text-blue-600 text-xs',
              'dark:bg-blue-500/20 dark:text-blue-400'
            )}
          >
            {sourceLabel}
          </span>
        )}

        {/* 状态指示器 */}
        {(isPending || isRunning) && (
          <span className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{t('blocks.academicSearch.searching')}</span>
          </span>
        )}

        {isError && (
          <span className="flex items-center gap-1 ml-auto text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="w-3 h-3" />
            <span>{t('blocks.academicSearch.error')}</span>
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
            <Search className="w-4 h-4" />
            <span className="truncate" title={query}>
              {query}
            </span>
          </div>
        )}

        {/* 加载状态 */}
        {(isPending || isRunning) && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">{t('blocks.academicSearch.loading')}</span>
            </div>
          </div>
        )}

        {/* 错误状态 */}
        {isError && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertCircle className="w-5 h-5" />
              <span className="text-sm">
                {block.error || t('blocks.academicSearch.errorMessage')}
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
            <span className="text-sm">{t('blocks.academicSearch.noResults')}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('academic_search', {
  type: 'academic_search',
  component: AcademicSearchBlock,
  onAbort: 'mark-error',
});

// 导出组件（可选，用于测试）
export { AcademicSearchBlock };
