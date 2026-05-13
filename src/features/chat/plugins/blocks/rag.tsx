/**
 * Chat V2 - RAG 文档知识库块渲染插件
 *
 * 渲染文档知识库检索结果
 * 自执行注册：import 即注册
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { FileText, Loader2, AlertCircle, Search } from 'lucide-react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { SourceList } from './components/SourceList';
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
  const isError = block.status === 'error';
  const isSuccess = block.status === 'success';

  // 统计信息
  const statsText = useMemo(() => {
    if (!isSuccess || sources.length === 0) return null;
    if (totalResults > sources.length) {
      return t('blocks.rag.stats', {
        shown: sources.length,
        total: totalResults,
      });
    }
    return t('blocks.rag.statsSimple', { count: sources.length });
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
            'w-6 h-6 rounded bg-blue-500/10',
            'dark:bg-blue-500/20'
          )}
        >
          <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        </div>

        {/* 标题 */}
        <span className="font-medium text-sm text-foreground">
          {t('blocks.rag.title')}
        </span>

        {/* 状态指示器 */}
        {(isPending || isRunning) && (
          <span className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{t('blocks.rag.searching')}</span>
          </span>
        )}

        {isError && (
          <span className="flex items-center gap-1 ml-auto text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="w-3 h-3" />
            <span>{t('blocks.rag.error')}</span>
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
              <span className="text-sm">{t('blocks.rag.loadingDocs')}</span>
            </div>
          </div>
        )}

        {/* 错误状态 */}
        {isError && (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertCircle className="w-5 h-5" />
              <span className="text-sm">
                {block.error || t('blocks.rag.errorMessage')}
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
            <span className="text-sm">{t('blocks.rag.noResults')}</span>
          </div>
        )}
      </div>
    </div>
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
