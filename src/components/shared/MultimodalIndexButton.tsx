/**
 * 多模态索引按钮组件
 *
 * 用于触发资源的多模态知识库索引，支持：
 * - 题目集识别
 * - 教材
 * - 附件
 *
 * 设计文档: docs/multimodal-user-memory-design.md
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Loader2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import multimodalRagService, { type SourceType, MULTIMODAL_INDEX_ENABLED } from '@/services/multimodalRagService';
import type { VfsMultimodalIndexResourceOutput } from '@/api/vfsRagApi';
import { cn } from '@/lib/utils';

// ============================================================================
// Props 定义
// ============================================================================

export interface MultimodalIndexButtonProps {
  /** 资源类型 */
  sourceType: SourceType;
  /** 资源 ID */
  sourceId: string;
  /** 子库 ID（可选） */
  subLibraryId?: string;
  /** 按钮变体 */
  variant?: 'default' | 'primary' | 'ghost';
  /** 按钮大小 */
  size?: 'default' | 'sm' | 'lg' | 'icon';
  /** 是否显示文字 */
  showLabel?: boolean;
  /** 索引完成回调 */
  onIndexComplete?: (result: VfsMultimodalIndexResourceOutput) => void;
  /** 额外的 CSS 类名 */
  className?: string;
  /** 是否禁用 */
  disabled?: boolean;
}

// ============================================================================
// 索引状态
// ============================================================================

type IndexStatus = 'idle' | 'indexing' | 'success' | 'error';

// ============================================================================
// 组件实现
// ============================================================================

export const MultimodalIndexButton: React.FC<MultimodalIndexButtonProps> = ({
  sourceType,
  sourceId,
  subLibraryId,
  variant = 'default',
  size = 'sm',
  showLabel = true,
  onIndexComplete,
  className,
  disabled = false,
}) => {
  const { t } = useTranslation(['common', 'settings']);
  const [status, setStatus] = useState<IndexStatus>('idle');
  const [lastResult, setLastResult] = useState<VfsMultimodalIndexResourceOutput | null>(null);

  // ★ 多模态索引已禁用，不渲染按钮。恢复 MULTIMODAL_INDEX_ENABLED = true 后自动显示
  if (!MULTIMODAL_INDEX_ENABLED) {
    return null;
  }

  // 执行索引
  const handleIndex = useCallback(async () => {
    if (status === 'indexing') return;

    setStatus('indexing');

    try {
      const result = await multimodalRagService.vfsIndexResourceBySource(
        sourceType,
        sourceId,
        subLibraryId,
        false
      );

      setLastResult(result);
      setStatus('success');

      showGlobalNotification(
        'success',
        t('common:multimodal.indexSuccess', {
          pages: result.indexedPages,
        })
      );

      onIndexComplete?.(result);

      // 3秒后恢复 idle 状态
      setTimeout(() => setStatus('idle'), 3000);
    } catch (error: unknown) {
      console.error('多模态索引失败:', error);
      setStatus('error');

      showGlobalNotification(
        'error',
        t('common:multimodal.indexError')
      );

      // 3秒后恢复 idle 状态
      setTimeout(() => setStatus('idle'), 3000);
    }
  }, [sourceType, sourceId, subLibraryId, status, onIndexComplete, t]);

  // 强制重建索引
  const handleRebuild = useCallback(async () => {
    if (status === 'indexing') return;

    setStatus('indexing');

    try {
      const result = await multimodalRagService.vfsIndexResourceBySource(
        sourceType,
        sourceId,
        subLibraryId,
        true
      );

      setLastResult(result);
      setStatus('success');

      showGlobalNotification(
        'success',
        t('common:multimodal.rebuildSuccess', {
          pages: result.indexedPages,
        })
      );

      onIndexComplete?.(result);

      setTimeout(() => setStatus('idle'), 3000);
    } catch (error: unknown) {
      console.error('多模态索引重建失败:', error);
      setStatus('error');

      showGlobalNotification(
        'error',
        t('common:multimodal.rebuildError')
      );

      setTimeout(() => setStatus('idle'), 3000);
    }
  }, [sourceType, sourceId, subLibraryId, status, onIndexComplete, t]);

  // 获取按钮图标
  const getIcon = () => {
    switch (status) {
      case 'indexing':
        return <Loader2 className="h-4 w-4 animate-spin" />;
      case 'success':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return <Database className="h-4 w-4" />;
    }
  };

  // 获取按钮文字
  const getLabel = () => {
    switch (status) {
      case 'indexing':
        return t('common:multimodal.indexing');
      case 'success':
        return t('common:multimodal.indexed');
      case 'error':
        return t('common:multimodal.indexFailed');
      default:
        return t('common:multimodal.index');
    }
  };

  // 获取 tooltip 内容
  const getTooltip = () => {
    if (lastResult && status === 'success') {
      return t('common:multimodal.indexResultTooltip', {
        pages: lastResult.indexedPages,
        failed: lastResult.failedPages.length,
      });
    }
    return t('common:multimodal.indexTooltip');
  };

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <CommonTooltip content={<p className="text-xs">{getTooltip()}</p>} position="bottom" maxWidth={320}>
        <NotionButton
          variant={variant}
          size={size}
          onClick={handleIndex}
          disabled={disabled || status === 'indexing'}
          className={cn(
            status === 'success' && 'border-green-500/50',
            status === 'error' && 'border-red-500/50'
          )}
        >
          {getIcon()}
          {showLabel && <span className="ml-1.5">{getLabel()}</span>}
        </NotionButton>
      </CommonTooltip>

      {/* 重建按钮（仅在成功后显示） */}
      {status === 'success' && (
        <CommonTooltip content={<p className="text-xs">{t('common:multimodal.rebuild')}</p>} position="bottom">
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={handleRebuild}
            className="h-8 w-8"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </NotionButton>
        </CommonTooltip>
      )}
    </div>
  );
};

export default MultimodalIndexButton;
