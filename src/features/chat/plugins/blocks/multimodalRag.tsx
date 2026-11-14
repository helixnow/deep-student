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

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Images } from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import {
  RetrievalBlockShell,
  RetrievalErrorNotice,
  RetrievalQueryRow,
} from './components/RetrievalBlockShell';
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
  const isActive = isPending || isRunning;
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';
  const [isExpanded, setIsExpanded] = useState(true);

  const durationMs =
    block.startedAt && block.endedAt
      ? block.endedAt - block.startedAt
      : data?.durationMs;

  const statsText = useMemo(() => {
    if (!isSuccess) return null;
    if (sources.length === 0) return t('blocks.multimodalRag.noResults');
    return t('blocks.multimodalRag.statsSimple', { count: sources.length });
  }, [isSuccess, sources.length, t]);

  const statusText = isActive
    ? t('blocks.multimodalRag.searching')
    : isError
      ? t('blocks.multimodalRag.error')
      : statsText;

  const hasBody = Boolean(query) || isError || (isSuccess && sources.length > 0);

  return (
    <RetrievalBlockShell
      icon={Images}
      title={t('blocks.multimodalRag.title')}
      statusText={statusText}
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
              message={block.error || t('blocks.multimodalRag.errorMessage')}
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

blockRegistry.register('multimodal_rag', {
  type: 'multimodal_rag',
  component: MultimodalRagBlock,
  onAbort: 'mark-error',
});

export { MultimodalRagBlock };
