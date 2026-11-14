/**
 * Chat V2 - 用户记忆块渲染插件
 *
 * 渲染用户记忆检索结果
 * 自执行注册：import 即注册
 */

import React, { useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brain,
  Chat,
  Clock,
  User,
} from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
import {
  RetrievalBlockShell,
  RetrievalErrorNotice,
} from './components/RetrievalBlockShell';
import { convertBackendSources, type BackendSourceInfo, type MemoryType, type RetrievalSource } from './components/types';
import { setPendingMemoryLocate } from '@/utils/pendingMemoryLocate';
import { DSTU_NAVIGATE_TO_KNOWLEDGE_BASE_EVENT } from '@/features/learning-hub/learningHubContracts';

/**
 * 后端 Memory 检索结果的原始格式
 */
interface BackendMemoryResult {
  sources?: BackendSourceInfo[];
  // 兼容旧 memory_search 结果结构
  results?: Array<{
    note_id?: string;
    note_title?: string;
    chunk_text?: string;
    score?: number;
    folder_path?: string;
  }>;
  memoryType?: MemoryType;
  durationMs?: number;
}

// ============================================================================
// 记忆类型图标映射
// ============================================================================

const memoryTypeIcons: Record<MemoryType, typeof Brain> = {
  conversation: Chat,
  long_term: Clock,
  user_profile: User,
};

// ============================================================================
// Memory 块组件
// ============================================================================

/**
 * MemoryBlock - 用户记忆块渲染组件
 *
 * 功能：
 * 1. 显示检索状态
 * 2. 显示检索到的记忆来源列表
 * 3. 区分不同记忆类型（对话/长期/用户画像）
 * 4. 暗色/亮色主题支持
 */
const MemoryBlock: React.FC<BlockComponentProps> = React.memo(({ block, isStreaming }) => {
  const { t } = useTranslation('chatV2');

  // 解析后端数据并转换为前端格式
  const data = block.toolOutput as BackendMemoryResult | undefined;
  
  const normalizedSources = useMemo<BackendSourceInfo[] | undefined>(() => {
    if (Array.isArray(data?.sources) && data.sources.length > 0) {
      return data.sources;
    }

    // 兼容旧结构：memory_search 返回 results 而不是 sources
    if (!Array.isArray(data?.results)) {
      return undefined;
    }

    return data.results
      .filter((item) => item != null)
      .map((item) => ({
        title: item.note_title,
        snippet: item.chunk_text,
        score: item.score,
        metadata: {
          note_id: item.note_id,
          document_id: item.note_id,
          memory_id: item.note_id,
          folder_path: item.folder_path,
          source_type: 'memory',
        },
      }));
  }, [data?.results, data?.sources]);

  // 🔧 关键修复：将后端 SourceInfo 转换为前端 RetrievalSource
  const sources = useMemo(() => {
    return convertBackendSources(normalizedSources, 'memory', block.id);
  }, [normalizedSources, block.id]);
  
  const memoryType = data?.memoryType ?? 'conversation';

  // ★ 点击记忆来源：定位到 Learning Hub 记忆视图并展开对应条目
  //   （与 UnifiedSourcePanel 的记忆定位链路保持一致）
  const handleSourceClick = useCallback((source: RetrievalSource) => {
    const meta = source.metadata || {};
    const memoryId = [meta.memory_id, meta.note_id, meta.document_id]
      .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (!memoryId) return;
    try {
      setPendingMemoryLocate(memoryId);
      window.dispatchEvent(new CustomEvent(DSTU_NAVIGATE_TO_KNOWLEDGE_BASE_EVENT, {
        detail: { preferTab: 'memory' },
      }));
    } catch (error: unknown) {
      console.error('[MemoryBlock] Failed to dispatch memory navigate event:', error);
    }
  }, []);

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

  // 获取记忆类型图标和文本
  const MemoryIcon = memoryTypeIcons[memoryType] || Brain;
  const memoryTypeText = useMemo(() => {
    return t(`blocks.memory.types.${memoryType}`);
  }, [memoryType, t]);

  const statusText = useMemo(() => {
    if (isActive) return t('blocks.memory.searching');
    if (isError) return t('blocks.memory.error');
    if (isSuccess && sources.length > 0) {
      return t('blocks.memory.statsSimple', { count: sources.length });
    }
    if (isSuccess) return t('blocks.memory.noResults');
    return null;
  }, [isActive, isError, isSuccess, sources.length, t]);

  const memoryBadge = isSuccess ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-2xs leading-none text-muted-foreground">
      <MemoryIcon size={10} aria-hidden="true" />
      <span>{memoryTypeText}</span>
    </span>
  ) : null;

  const hasBody = isError || (isSuccess && sources.length > 0);

  return (
    <RetrievalBlockShell
      icon={Brain}
      title={t('blocks.memory.title')}
      statusText={statusText}
      badge={memoryBadge}
      isActive={!!isActive}
      isError={isError}
      isSuccess={isSuccess}
      durationMs={durationMs}
      collapsible={hasBody}
      isExpanded={isExpanded}
      onToggleExpand={() => setIsExpanded((prev) => !prev)}
    >
      {isError && (
        <RetrievalErrorNotice message={block.error || t('blocks.memory.errorMessage')} />
      )}

      {isSuccess && sources.length > 0 && (
        <SourceList
          sources={sources}
          maxVisible={3}
          defaultExpanded={false}
          onSourceClick={handleSourceClick}
        />
      )}
    </RetrievalBlockShell>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('memory', {
  type: 'memory',
  component: MemoryBlock,
  onAbort: 'mark-error',
});

// 导出组件（可选，用于测试）
export { MemoryBlock };
