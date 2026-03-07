/**
 * 题目集编辑器包装组件
 *
 * 将 ExamContentView 包装为符合 DSTU EditorProps 接口的组件。
 * 使用 DSTU 模式渲染题目集识别工作台（无内部会话列表）。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { pathUtils } from '../utils/pathUtils';
import { createEmpty } from '../factory';
import { cn } from '@/lib/utils';
import type { DstuNode } from '../types';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// 懒加载 ExamContentView（DSTU 模式实现）
const ExamContentView = lazy(() => import('@/components/learning-hub/apps/views/ExamContentView'));

/**
 * 题目集编辑器包装组件
 *
 * 渲染 ExamContentView（DSTU 模式题目集识别工作台）
 */
export const ExamEditorWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'exam_sheet', 'common']);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 判断是否为创建模式
  const isCreateMode = 'mode' in props && props.mode === 'create';
  const onClose = 'onClose' in props ? props.onClose : undefined;
  const onCreate = isCreateMode && 'onCreate' in props ? props.onCreate : undefined;

  useEffect(() => {
    if (!isCreateMode) {
      return;
    }

    let cancelled = false;

    const createExamResource = async () => {
      setIsCreating(true);
      setCreateError(null);

      const result = await createEmpty({ type: 'exam' });
      if (cancelled) return;

      if (result.ok) {
        setIsCreating(false);
        onCreate?.(result.value.path);
        if (onClose) {
          onClose();
        }
        return;
      }

      const errMsg = result.error.toUserMessage();
      setCreateError(errMsg);
      setIsCreating(false);
      showGlobalNotification('error', errMsg);
    };

    void createExamResource();

    return () => {
      cancelled = true;
    };
  }, [isCreateMode, onCreate, onClose]);

  if (isCreateMode) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-3', props.className)}>
        {createError ? (
          <>
            <AlertCircle className="w-10 h-10 text-destructive/60" />
            <span className="text-sm text-destructive text-center max-w-md">{createError}</span>
            {onClose && (
              <NotionButton variant="ghost" onClick={onClose}>
                {t('common:actions.close')}
              </NotionButton>
            )}
          </>
        ) : (
          <>
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {isCreating
                ? t('dstu:actions.creatingResource', '正在创建资源...')
                : t('dstu:preview.loading')}
            </span>
          </>
        )}
      </div>
    );
  }

  // 解析路径获取 sessionId
  const pathInfo = 'path' in props ? pathUtils.parse(props.path) : null;
  const sessionId = pathInfo?.id || '';

  // 没有 sessionId 且不是创建模式
  if (!sessionId && !isCreateMode) {
    const onCloseError = 'onClose' in props ? props.onClose : undefined;
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-8 h-8 text-destructive" />
        <span className="text-destructive text-center max-w-md">
          {t('exam_sheet:errors.noSession')}
        </span>
        {onCloseError && (
          <NotionButton variant="ghost" onClick={onCloseError}>
            {t('common:actions.close')}
          </NotionButton>
        )}
      </div>
    );
  }

  // 构建 DstuNode 用于 ExamContentView
  const now = Date.now();
  const node: DstuNode = {
    id: sessionId,
    sourceId: sessionId,
    name: pathInfo?.id || t('exam_sheet:dstu_unnamed_session'),
    type: 'exam',
    path: 'path' in props ? props.path : `/${sessionId}`,
    createdAt: now,
    updatedAt: now,
  };

  return (
    <Suspense
      fallback={
        <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
        </div>
      }
    >
      <ExamContentView
        node={node}
        onClose={onClose}
      />
    </Suspense>
  );
};

export default ExamEditorWrapper;
