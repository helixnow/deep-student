/**
 * 笔记编辑器包装组件
 *
 * 将 NoteContentView 包装为符合 DSTU EditorProps 接口的组件。
 * 渲染完整的笔记编辑器（编辑区 + 属性面板），不包含文件管理侧边栏。
 * 
 * 设计原则：
 * - 使用 DSTU 原生的 NoteContentView（不再依赖 NotesProvider）
 * - 从 DSTU path 获取 DstuNode
 * - 可在 Learning Hub 或其他地方复用
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { dstu } from '../index';
import { cn } from '@/lib/utils';
import type { DstuNode } from '../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// 懒加载 NoteContentView（DSTU 原生实现）
const NoteContentView = lazy(() => import('@/components/learning-hub/apps/views/NoteContentView'));

/**
 * 笔记编辑器包装组件
 *
 * 渲染 DSTU 原生的 NoteContentView（无需 NotesProvider）
 */
export const NoteEditorWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'notes', 'common']);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 判断是否为创建模式
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取 noteId
  const path = !isCreateMode && 'path' in props ? props.path : '';

  // 获取 onClose 回调
  const onClose = 'onClose' in props ? props.onClose : undefined;
  const readOnly = !isCreateMode && 'readOnly' in props ? props.readOnly : false;

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
        const errMsg = t('notes:errors.noteNotFound');
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
    void loadNode();
  }, [loadNode]);

  // 创建模式暂不支持
  if (isCreateMode) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <span className="text-muted-foreground text-center">
          {t('dstu:actions.createNote')} - {t('common:comingSoon')}
        </span>
        {onClose && (
          <button
            className="px-4 py-2 border rounded-md hover:bg-muted"
            onClick={onClose}
          >
            {t('common:actions.close')}
          </button>
        )}
      </div>
    );
  }

  // 加载中
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
      </div>
    );
  }

  // 错误状态
  if (error || !node) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-8 h-8 text-destructive" />
        <span className="text-destructive text-center max-w-md">
          {error || t('notes:errors.noteNotFound')}
        </span>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => void loadNode()}
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

  return (
    <Suspense
      fallback={
        <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
        </div>
      }
    >
      <NoteContentView
        node={node}
        onClose={onClose}
        readOnly={readOnly}
      />
    </Suspense>
  );
};

export default NoteEditorWrapper;
