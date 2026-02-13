/**
 * 作文编辑器包装组件
 *
 * 将作文批改功能包装为符合 DSTU EditorProps 接口的组件。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, PenTool, RefreshCw, ShieldAlert } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { pathUtils } from '../utils/pathUtils';
import { dstu } from '../api';
import { cn } from '@/lib/utils';
import { VfsError, VfsErrorCode, reportError } from '@/shared/result';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';

interface EssayData {
  title: string;
  content: string;
  score?: number;
  feedback?: string;
}

/**
 * 作文编辑器包装组件
 *
 * 通过 DSTU API 加载和保存作文数据。
 */
export const EssayEditorWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'essay_grading', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [essayData, setEssayData] = useState<EssayData | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // M-050: 标记 JSON 解析失败的降级状态，阻止保存以防覆盖丢失评分数据
  const [isParseError, setIsParseError] = useState(false);

  // 判断是否为创建模式
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取信息
  const pathInfo = !isCreateMode && 'path' in props ? pathUtils.parse(props.path) : null;
  const path = !isCreateMode && 'path' in props ? props.path : null;

  // 加载作文数据
  const loadEssay = useCallback(async () => {
    if (isCreateMode) {
      setEssayData({ title: '', content: '' });
      setIsLoading(false);
      return;
    }

    if (!path) return;

    setIsLoading(true);
    setError(null);
    setIsParseError(false);

    const result = await dstu.getContent(path);
    setIsLoading(false);

    if (result.ok) {
      const content = result.value;
      if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          setEssayData({
            title: parsed.title || '',
            content: parsed.content || parsed.text || '',
            score: parsed.score,
            feedback: parsed.feedback,
          });
        } catch (parseError: unknown) {
          // M-050: JSON解析失败，降级为只读纯文本模式，阻止保存以防覆盖丢失评分/反馈数据
          const vfsError = new VfsError(
            VfsErrorCode.PARSE,
            t('dstu:errors.essayParseError'),
            true, // recoverable
            { path, parseError: String(parseError) }
          );
          reportError(vfsError, 'parseEssayData');
          console.warn('[EssayEditorWrapper] JSON parse failed, fallback to read-only plain text:', parseError);
          setIsParseError(true);
          setEssayData({
            title: '',
            content: content,
          });
          showGlobalNotification(
            'warning',
            t('dstu:errors.essayParseErrorSaveBlocked', {
              defaultValue: '作文数据解析异常，评分和反馈可能丢失。为保护数据安全，已禁用保存功能。请重试加载或联系支持。',
            })
          );
        }
      }
    } else {
      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      showGlobalNotification('error', errMsg);
    }
  }, [isCreateMode, path]);

  useEffect(() => {
    void loadEssay();
  }, [loadEssay]);

  // 保存处理
  const handleSave = useCallback(async () => {
    if (!essayData || isSaving) return;

    // M-050: 降级状态下阻止保存，防止覆盖丢失的评分/反馈数据
    if (isParseError) {
      showGlobalNotification(
        'warning',
        t('dstu:errors.essayParseErrorSaveBlocked', {
          defaultValue: '数据解析异常，保存已被阻止以防丢失评分数据。请重试加载或联系支持。',
        })
      );
      return;
    }

    setIsSaving(true);
    const contentJson = JSON.stringify(essayData);

    try {
      if (isCreateMode) {
        const createProps = props as CreateEditorProps;
        const result = await dstu.create('/', {
          type: 'essay',
          name: essayData.title || 'New Essay',
          content: contentJson,
        });

        if (result.ok) {
          showGlobalNotification('success', t('common:saveSuccess'));
          createProps.onCreate?.(result.value.path);
        } else {
          const errMsg = result.error.toUserMessage();
          setError(errMsg);
          showGlobalNotification('error', errMsg);
        }
      } else {
        const editProps = props as EditorProps;
        const result = await dstu.update(editProps.path, contentJson, 'essay');

        if (result.ok) {
          showGlobalNotification('success', t('common:saveSuccess'));
          editProps.onSave?.();
        } else {
          const errMsg = result.error.toUserMessage();
          setError(errMsg);
          showGlobalNotification('error', errMsg);
        }
      }
    } finally {
      setIsSaving(false);
    }
  }, [isCreateMode, props, essayData, isSaving, isParseError, t]);

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
      </div>
    );
  }

  // 错误状态
  if (error) {
    const onClose = 'onClose' in props ? props.onClose : undefined;
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-8 h-8 text-destructive" />
        <span className="text-destructive text-center max-w-md">{error}</span>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => void loadEssay()}
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

  const isReadOnly = 'readOnly' in props && props.readOnly;
  const isViewMode = 'mode' in props && props.mode === 'view';
  // M-050: 降级状态下强制只读，防止编辑后误触保存
  const effectiveReadOnly = isReadOnly || isViewMode || isParseError;

  // 作文编辑器 UI
  return (
    <div className={cn('flex flex-col h-full', props.className)}>
      {/* 工具栏 */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
        <div className="flex items-center gap-2">
          <PenTool className="w-5 h-5 text-muted-foreground" />
          <span className="text-sm font-medium">{t('dstu:types.essay')}</span>
          {essayData?.score !== undefined && (
            <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full">
              {t('essay_grading:score.points', { score: essayData.score })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {'onClose' in props && props.onClose && (
            <button
              className="px-3 py-1 text-sm border rounded-md hover:bg-muted"
              onClick={props.onClose}
            >
              {t('common:actions.close')}
            </button>
          )}
          {!isReadOnly && !isViewMode && (
            <button
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1 text-sm rounded-md disabled:opacity-50 disabled:cursor-not-allowed",
                isParseError
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              )}
              onClick={handleSave}
              disabled={isSaving || isParseError}
              title={isParseError ? t('dstu:errors.essayParseErrorSaveBlocked', { defaultValue: '数据解析异常，保存已被阻止' }) : undefined}
            >
              {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isSaving ? t('common:actions.saving') : t('common:actions.save')}
            </button>
          )}
        </div>
      </div>

      {/* 作文内容 */}
      <CustomScrollArea className="flex-1" viewportClassName="p-4 space-y-4">
        {/* M-050: 数据解析异常警告横幅 */}
        {isParseError && (
          <div className="flex items-start gap-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-md">
            <ShieldAlert className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
                {t('dstu:errors.essayParseErrorTitle', { defaultValue: '数据解析异常' })}
              </p>
              <p className="text-xs text-yellow-700 dark:text-yellow-400">
                {t('dstu:errors.essayParseErrorDescription', {
                  defaultValue: '作文数据格式异常，评分和批改反馈可能已丢失。为保护原始数据，编辑和保存功能已被禁用。请尝试重新加载，如问题持续请联系技术支持。',
                })}
              </p>
              <button
                className="inline-flex items-center gap-1.5 mt-1 px-3 py-1 text-xs bg-yellow-600 text-white rounded-md hover:bg-yellow-700"
                onClick={() => void loadEssay()}
              >
                <RefreshCw className="w-3 h-3" />
                {t('common:actions.retry')}
              </button>
            </div>
          </div>
        )}

        {/* 标题 */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">
            {t('essay_grading:fields.title')}
          </label>
          <input
            className={cn(
              "w-full px-3 py-2 border rounded-md bg-background",
              isParseError && "opacity-60"
            )}
            value={essayData?.title || ''}
            onChange={(e) => setEssayData((prev) => prev ? { ...prev, title: e.target.value } : null)}
            readOnly={effectiveReadOnly}
            placeholder={t('essay_grading:fields.titlePlaceholder')}
          />
        </div>

        {/* 正文 */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">
            {t('essay_grading:fields.content')}
          </label>
          <textarea
            className={cn(
              "w-full min-h-[200px] px-3 py-2 border rounded-md bg-background resize-none",
              isParseError && "opacity-60"
            )}
            value={essayData?.content || ''}
            onChange={(e) => setEssayData((prev) => prev ? { ...prev, content: e.target.value } : null)}
            readOnly={effectiveReadOnly}
            placeholder={t('essay_grading:fields.contentPlaceholder')}
          />
        </div>

        {/* 批改反馈（如果有） */}
        {essayData?.feedback && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">
              {t('essay_grading:fields.feedback')}
            </label>
            <div className="p-3 bg-primary/5 border border-primary/20 rounded-md">
              <p className="text-sm">{essayData.feedback}</p>
            </div>
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default EssayEditorWrapper;
