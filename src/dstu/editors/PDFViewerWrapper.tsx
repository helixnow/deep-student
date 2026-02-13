/**
 * PDF 查看器包装组件
 *
 * 将 TextbookContentView 包装为符合 DSTU EditorProps 接口的组件。
 * 渲染完整的教材 PDF 查看器，通过 DSTU 获取元数据。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { pathUtils } from '../utils/pathUtils';
import { dstu } from '../api';
import type { DstuNode } from '../types';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// 懒加载 TextbookContentView（DSTU 原生实现）
const TextbookContentView = lazy(() => import('@/components/learning-hub/apps/views/TextbookContentView'));

/**
 * PDF 查看器包装组件
 *
 * 渲染完整的 TextbookAppPanel（教材查看器）
 */
export const PDFViewerWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'textbook', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dstuNode, setDstuNode] = useState<DstuNode | null>(null);

  // 判断是否为创建模式（PDF 不支持创建模式）
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取信息
  const pathInfo = !isCreateMode && 'path' in props ? pathUtils.parse(props.path) : null;
  const path = !isCreateMode && 'path' in props ? props.path : null;

  // 加载 DSTU 节点
  const loadPdf = useCallback(async () => {
    if (isCreateMode) {
      setError(t('dstu:errors.internal'));
      setIsLoading(false);
      return;
    }

    if (!path) return;

    setIsLoading(true);
    setError(null);

    const result = await dstu.get(path);
    setIsLoading(false);

    if (result.ok) {
      if (result.value) {
        setDstuNode(result.value);
      } else {
        const errMsg = t('textbook:errors.noFile');
        setError(errMsg);
        showGlobalNotification('error', errMsg);
      }
    } else {
      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      showGlobalNotification('error', errMsg);
    }
  }, [isCreateMode, path, t]);

  useEffect(() => {
    void loadPdf();
  }, [loadPdf]);

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
      </div>
    );
  }

  // 错误状态或没有节点
  if (error || !dstuNode) {
    const onClose = 'onClose' in props ? props.onClose : undefined;
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-8 h-8 text-destructive" />
        <span className="text-destructive text-center max-w-md">
          {error || t('textbook:errors.noFile')}
        </span>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => void loadPdf()}
          >
            <RefreshCw className="w-4 h-4" />
            {t('common:actions.retry')}
          </button>
          {onClose && (
            <button
              className="px-4 py-2 border rounded-md hover:bg-muted"
              onClick={onClose}
            >
              {t('common:actions.close')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // 获取 onClose 回调
  const onClose = 'onClose' in props ? props.onClose : undefined;

  return (
    <Suspense
      fallback={
        <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
        </div>
      }
    >
      <TextbookContentView
        node={dstuNode}
        onClose={onClose}
      />
    </Suspense>
  );
};

export default PDFViewerWrapper;
