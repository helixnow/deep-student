/**
 * Chat V2 - RAG 文档知识库块渲染插件
 *
 * 渲染文档知识库检索结果
 * 自执行注册：import 即注册
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import {
  RetrievalBlockShell,
  RetrievalErrorNotice,
  RetrievalQueryRow,
} from './components/RetrievalBlockShell';
import { convertBackendSources, type BackendSourceInfo } from './components/types';

/**
 * 后端 RAG 检索结果的原始格式
 */
interface BackendRagResult {
  sources?: BackendSourceInfo[];
  query?: string;
  totalResults?: number;
  durationMs?: number;
}

// ============================================================================
// RAG 块组件
// ============================================================================

/**
 * RagBlock - RAG 文档知识库块渲染组件
 *
 * 功能：
 * 1. 显示检索状态（加载中、成功、错误）
 * 2. 显示检索到的文档来源列表
 * 3. 显示检索查询和结果数量
 * 4. 暗色/亮色主题支持
 */
const RagBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  // 解析后端数据并转换为前端格式
  const data = block.toolOutput as BackendRagResult | undefined;
  
  // 🔧 关键修复：将后端 SourceInfo 转换为前端 RetrievalSource
  // 补充缺失的 id 和 type 字段
  const sources = useMemo(() => {
    return convertBackendSources(data?.sources, 'rag', block.id);
  }, [data?.sources, block.id]);
  
  const query = data?.query;
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
    if (sources.length === 0) return t('blocks.rag.noResults');
    if (totalResults > sources.length) {
      return t('blocks.rag.stats', {
        shown: sources.length,
        total: totalResults,
      });
    }
    return t('blocks.rag.statsSimple', { count: sources.length });
  }, [isSuccess, sources.length, totalResults, t]);

  const statusText = isActive
    ? t('blocks.rag.searching')
    : isError
      ? t('blocks.rag.error')
      : statsText;

  const hasBody = Boolean(query) || isError || (isSuccess && sources.length > 0);

  return (
    <RetrievalBlockShell
      icon={FileText}
      title={t('blocks.rag.title')}
      statusText={statusText}
      isActive={!!isActive}
      isError={isError}
      isSuccess={isSuccess}
      durationMs={durationMs}
      collapsible={hasBody}
      isExpanded={isExpanded}
      onToggleExpand={() => setIsExpanded((prev) => !prev)}
    >
      {query && <RetrievalQueryRow query={query} />}

      {isError && (
        <RetrievalErrorNotice message={block.error || t('blocks.rag.errorMessage')} />
      )}

      {isSuccess && sources.length > 0 && (
        <SourceList
          sources={sources}
          maxVisible={3}
          defaultExpanded={false}
        />
      )}
    </RetrievalBlockShell>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('rag', {
  type: 'rag',
  component: RagBlock,
  onAbort: 'mark-error',
});

// 导出组件（可选，用于测试）
export { RagBlock };
