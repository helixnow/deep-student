/**
 * Chat V2 - 学术论文搜索块渲染插件
 *
 * 渲染学术论文搜索结果（arXiv / OpenAlex）
 * 自执行注册：import 即注册
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GraduationCap } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import {
  RetrievalBlockShell,
  RetrievalErrorNotice,
  RetrievalQueryRow,
} from './components/RetrievalBlockShell';
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
const AcademicSearchBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  // 解析后端数据并转换为前端格式
  const data = block.toolOutput as BackendAcademicSearchResult | undefined;

  // 将后端 SourceInfo 转换为前端 RetrievalSource
  // 🔧 P0 修复：基础 type 保持 'web_search'（引用/来源面板的联合类型约束），
  // 但通过 metadata._sourceKind 标记学术来源，SourceCard 据此显示学术图标与标签
  const sources = useMemo(() => {
    return convertBackendSources(data?.sources, 'web_search', block.id).map((source) => ({
      ...source,
      metadata: { ...source.metadata, _sourceKind: 'academic' },
    }));
  }, [data?.sources, block.id]);

  const searchSource = data?.source;
  const totalResults = data?.total_results ?? sources.length;

  // 状态判断
  const isPending = block.status === 'pending';
  const isRunning = block.status === 'running' || isStreaming;
  const isActive = isPending || isRunning;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';
  const [isExpanded, setIsExpanded] = useState(true);

  const durationMs =
    block.startedAt && block.endedAt ? block.endedAt - block.startedAt : undefined;

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
    if (!isSuccess) return null;
    if (sources.length === 0) return t('blocks.academicSearch.noResults');
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

  const statusText = isActive
    ? t('blocks.academicSearch.searching')
    : isError
      ? t('blocks.academicSearch.error')
      : statsText;

  const hasBody = Boolean(query) || isError || (isSuccess && sources.length > 0);

  return (
    <RetrievalBlockShell
      icon={GraduationCap}
      title={t('blocks.academicSearch.title')}
      statusText={statusText}
      badge={
        sourceLabel && isSuccess ? (
          <span className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
            {sourceLabel}
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
              message={block.error || t('blocks.academicSearch.errorMessage')}
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

blockRegistry.register('academic_search', {
  type: 'academic_search',
  component: AcademicSearchBlock,
  onAbort: 'mark-error',
});

// 导出组件（可选，用于测试）
export { AcademicSearchBlock };
