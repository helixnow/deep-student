/**
 * 知识导图编辑器包装组件
 *
 * 将 MindMapContentView 包装为符合 DSTU EditorProps 接口的组件。
 * 
 * 设计原则：
 * - 使用 DSTU 原生的 MindMapContentView
 * - 从 DSTU path 获取 DstuNode
 * - 可在 Learning Hub 或其他地方复用
 */

import React, { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { dstu } from '../index';
import { createEmpty } from '../factory';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { DstuNode } from '../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// 懒加载 MindMapContentView
const MindMapContentView = lazy(() => 
  import('@/components/mindmap/MindMapContentView').then(m => ({ default: m.MindMapContentView }))
);

/**
 * 知识导图编辑器包装组件
 */
export const MindMapEditorWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'mindmap', 'common']);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 判断是否为创建模式
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取 mindmapId
  const path = !isCreateMode && 'path' in props ? props.path : '';

  // 获取回调
  const onClose = 'onClose' in props ? props.onClose : undefined;
  const onCreate = isCreateMode && 'onCreate' in props ? props.onCreate : undefined;

  // 从路径提取资源 ID
  const extractResourceId = (dstuPath: string): string | null => {
    // 路径格式: /mm_xxx 或 /folder/mm_xxx
    const match = dstuPath.match(/\/(mm_[a-zA-Z0-9_-]+)$/);
    return match ? match[1] : null;
  };

  // 加载 DstuNode
  const loadNode = useCallback(async () => {
    if (!path) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const result = await dstu.get(path);
    setIsLoading(false);

    if (result.ok) {
      if (result.value) {
        setNode(result.value);
      } else {
        const errMsg = t('mindmap:errors.notFound');
        setError(errMsg);
        showGlobalNotification('error', errMsg);
      }
    } else {
      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      showGlobalNotification('error', errMsg);
    }
  }, [path, t]);

  useEffect(() => {
    if (!isCreateMode) {
      return;
    }

    let cancelled = false;
    const createMindMapResource = async () => {
      setIsLoading(true);
      setError(null);
      const result = await createEmpty({ type: 'mindmap' });
      if (cancelled) return;

      if (result.ok) {
        setIsLoading(false);
        onCreate?.(result.value.path);
        if (onClose) {
          onClose();
          return;
        }
        return;
      }

      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      setIsLoading(false);
      showGlobalNotification('error', errMsg);
    };

    void createMindMapResource();
    return () => {
      cancelled = true;
    };
  }, [isCreateMode, onCreate, onClose]);

  useEffect(() => {
    if (!isCreateMode) {
      void loadNode();
    }
  }, [isCreateMode, loadNode]);

  // 创建模式
  if (isCreateMode) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-3', props.className)}>
        {error ? (
          <>
            <AlertCircle className="w-10 h-10 text-destructive/60" />
            <span className="text-sm text-destructive text-center max-w-md">{error}</span>
            {onClose && (
              <NotionButton variant="ghost"
                className="px-4 py-2 border rounded-md hover:bg-muted"
                onClick={onClose}
              >
                {t('common:actions.close')}
              </NotionButton>
            )}
          </>
        ) : isLoading ? (
          <>
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('dstu:actions.createMindMap')}...
            </span>
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">{t('dstu:actions.mindMapCreated')}</span>
            {onClose && (
              <NotionButton variant="ghost"
                className="px-4 py-2 border rounded-md hover:bg-muted"
                onClick={onClose}
              >
                {t('common:actions.close')}
              </NotionButton>
            )}
          </>
        )}
      </div>
    );
  }

  // 加载中
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full', props.className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-12 h-12 text-destructive/50" />
        <span className="text-destructive text-center max-w-md">{error}</span>
        <NotionButton variant="ghost"
          className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-muted"
          onClick={loadNode}
        >
          <RefreshCw className="w-4 h-4" />
          {t('common:actions.retry')}
        </NotionButton>
      </div>
    );
  }

  // 节点不存在
  if (!node) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-12 h-12 text-muted-foreground/50" />
        <span className="text-muted-foreground text-center">
          {t('mindmap:errors.notFound')}
        </span>
      </div>
    );
  }

  // 提取资源 ID
  const resourceId = extractResourceId(path) || node.id;

  return (
    <Suspense
      fallback={
        <div className={cn('flex items-center justify-center h-full', props.className)}>
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <MindMapContentView
        resourceId={resourceId}
        className={props.className}
      />
    </Suspense>
  );
};
