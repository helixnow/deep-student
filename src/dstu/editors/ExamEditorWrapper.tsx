/**
 * 题目集编辑器包装组件
 *
 * 将 ExamContentView 包装为符合 DSTU EditorProps 接口的组件。
 * 使用 DSTU 模式渲染题目集识别工作台（无内部会话列表）。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { pathUtils } from '../utils/pathUtils';
import { cn } from '@/lib/utils';
import type { DstuNode } from '../types';

// 懒加载 ExamContentView（DSTU 模式实现）
const ExamContentView = lazy(() => import('@/components/learning-hub/apps/views/ExamContentView'));

// 新建模式的特殊 ID
const CREATE_NEW_ID = '__create_new__';

/**
 * 题目集编辑器包装组件
 *
 * 渲染 ExamContentView（DSTU 模式题目集识别工作台）
 */
export const ExamEditorWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'exam_sheet', 'common']);

  // 判断是否为创建模式
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取 sessionId
  const pathInfo = !isCreateMode && 'path' in props ? pathUtils.parse(props.path) : null;
  const sessionId = isCreateMode ? CREATE_NEW_ID : (pathInfo?.id || '');

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
          <button
            className="px-4 py-2 border rounded-md hover:bg-muted"
            onClick={onCloseError}
          >
            {t('common:actions.close')}
          </button>
        )}
      </div>
    );
  }

  // 获取 onClose 回调
  const onClose = 'onClose' in props ? props.onClose : undefined;

  // 构建 DstuNode 用于 ExamContentView
  const now = Date.now();
  const node: DstuNode = {
    id: sessionId,
    sourceId: sessionId,
    name: pathInfo?.id || t('exam_sheet:dstu_unnamed_session'),
    type: 'exam',
    path: 'path' in props ? props.path : `/${CREATE_NEW_ID}`,
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
