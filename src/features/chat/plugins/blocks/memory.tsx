/**
 * Chat V2 - 用户记忆块渲染插件
 *
 * 渲染用户记忆检索结果
 * 自执行注册：import 即注册
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  Brain,
  CircleNotch,
  WarningCircle,
  Chat,
  Clock,
  User,
} from '@phosphor-icons/react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
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
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';

  // 获取记忆类型图标和文本
  const MemoryIcon = memoryTypeIcons[memoryType] || Brain;
  const memoryTypeText = useMemo(() => {
    return t(`blocks.memory.types.${memoryType}`);
  }, [memoryType, t]);

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
            'w-6 h-6 rounded bg-warning/10'
          )}
        >
          <Brain size={16} className="text-warning" />
        </div>

        {/* 标题 */}
        <span className="font-medium text-sm text-foreground">
          {t('blocks.memory.title')}
        </span>

        {/* 记忆类型标签 */}
        {isSuccess && (
          <span
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full',
              'bg-warning/10 text-warning text-xs'
            )}
          >
            <MemoryIcon size={12} />
            <span>{memoryTypeText}</span>
          </span>
        )}

        {/* 状态指示器 */}
        {(isPending || isRunning) && (
          <span className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
            <CircleNotch size={12} className="animate-spin" />
            <span>{t('blocks.memory.searching')}</span>
          </span>
        )}

        {isError && (
          <span className="flex items-center gap-1 ml-auto text-xs text-destructive">
            <WarningCircle size={12} />
            <span>{t('blocks.memory.error')}</span>
          </span>
        )}

        {isSuccess && sources.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {t('blocks.memory.statsSimple', { count: sources.length })}
          </span>
        )}
      </div>

      {/* 内容区域 */}
      <div className="p-3">
        {/* 加载状态 */}
        {(isPending || isRunning) && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CircleNotch size={20} className="animate-spin" />
              <span className="text-sm">{t('blocks.memory.loading')}</span>
            </div>
          </div>
        )}

        {/* 错误状态 */}
        {isError && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-destructive">
              <WarningCircle size={20} />
              <span className="text-sm">
                {block.error || t('blocks.memory.errorMessage')}
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
            onSourceClick={handleSourceClick}
          />
        )}

        {/* 成功但无结果 */}
        {isSuccess && sources.length === 0 && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <span className="text-sm">{t('blocks.memory.noResults')}</span>
          </div>
        )}
      </div>
    </div>
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
