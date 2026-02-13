/**
 * MarkdownPreview - Markdown 内容预览组件
 *
 * 复用 Chat V2 的 MarkdownRenderer 组件
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Skeleton } from '../../ui/shad/Skeleton';
import { MarkdownRenderer } from '../../../chat-v2/components/renderers/MarkdownRenderer';
import { CustomScrollArea } from '../../custom-scroll-area';
import { AlertCircle, FileText } from 'lucide-react';
import type { MarkdownPreviewProps } from './types';

/**
 * Markdown 预览骨架屏
 */
const MarkdownSkeleton: React.FC = () => (
  <div className="space-y-4 p-4">
    <Skeleton className="h-6 w-3/4" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <Skeleton className="h-4 w-4/5" />
    <div className="mt-6 space-y-3">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-3/4" />
    </div>
    <div className="mt-6 space-y-3">
      <Skeleton className="h-5 w-2/5" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-10/12" />
    </div>
  </div>
);

/**
 * Markdown 预览组件
 */
export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({
  content,
  loading = false,
  error = null,
  className,
}) => {
  const { t } = useTranslation(['notes']);

  // 加载状态
  if (loading) {
    return (
      <div className={cn('h-full', className)}>
        <MarkdownSkeleton />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <AlertCircle className="h-10 w-10 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  // 空内容
  if (!content || content.trim().length === 0) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <FileText className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t('notes:previewPanel.emptyContent')}
        </p>
      </div>
    );
  }

  return (
    <CustomScrollArea className={cn('h-full', className)}>
      <div className="p-4">
        <MarkdownRenderer content={content} className="prose prose-sm dark:prose-invert max-w-none" />
      </div>
    </CustomScrollArea>
  );
};

export default MarkdownPreview;
