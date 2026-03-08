/**
 * 待办列表编辑器包装组件
 *
 * 将 TodoContentView 包装为符合 DSTU EditorProps 接口的组件。
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

// 懒加载 TodoContentView
const TodoContentView = lazy(() =>
  import('@/components/todo/TodoContentView').then(m => ({ default: m.TodoContentView }))
);

/**
 * 待办列表编辑器包装组件
 */
export const TodoEditorWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'common']);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isCreateMode = 'mode' in props && props.mode === 'create';
  const path = !isCreateMode && 'path' in props ? props.path : '';
  const onClose = 'onClose' in props ? props.onClose : undefined;
  const onCreate = isCreateMode && 'onCreate' in props ? props.onCreate : undefined;

  const extractResourceId = (dstuPath: string): string | null => {
    const match = dstuPath.match(/\/(tdl_[a-zA-Z0-9_-]+)$/);
    return match ? match[1] : null;
  };

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
        const errMsg = t('dstu:errors.notFound');
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
    if (!isCreateMode) return;

    let cancelled = false;
    const createTodoResource = async () => {
      setIsLoading(true);
      setError(null);
      const result = await createEmpty({ type: 'todo' });
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

    void createTodoResource();
    return () => { cancelled = true; };
  }, [isCreateMode, onCreate, onClose]);

  useEffect(() => {
    if (!isCreateMode) {
      void loadNode();
    }
  }, [isCreateMode, loadNode]);

  if (isCreateMode) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-3', props.className)}>
        {error ? (
          <>
            <AlertCircle className="w-10 h-10 text-destructive/60" />
            <span className="text-sm text-destructive text-center max-w-md">{error}</span>
            {onClose && (
              <NotionButton variant="ghost" className="px-4 py-2 border rounded-md hover:bg-muted" onClick={onClose}>
                {t('common:actions.close')}
              </NotionButton>
            )}
          </>
        ) : isLoading ? (
          <>
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('dstu:actions.createTodo')}...
            </span>
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">{t('dstu:actions.todoCreated')}</span>
            {onClose && (
              <NotionButton variant="ghost" className="px-4 py-2 border rounded-md hover:bg-muted" onClick={onClose}>
                {t('common:actions.close')}
              </NotionButton>
            )}
          </>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full', props.className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-12 h-12 text-destructive/50" />
        <span className="text-destructive text-center max-w-md">{error}</span>
        <NotionButton variant="ghost" className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-muted" onClick={loadNode}>
          <RefreshCw className="w-4 h-4" />
          {t('common:actions.retry')}
        </NotionButton>
      </div>
    );
  }

  if (!node) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-12 h-12 text-muted-foreground/50" />
        <span className="text-muted-foreground text-center">
          {t('dstu:errors.notFound')}
        </span>
      </div>
    );
  }

  const resourceId = extractResourceId(path) || node.id;

  return (
    <Suspense
      fallback={
        <div className={cn('flex items-center justify-center h-full', props.className)}>
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <TodoContentView
        todoListId={resourceId}
        className={props.className}
      />
    </Suspense>
  );
};
