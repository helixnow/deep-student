/**
 * 翻译查看器包装组件
 *
 * 将翻译结果显示包装为符合 DSTU EditorProps 接口的组件。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, Languages, RefreshCw } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { pathUtils } from '../utils/pathUtils';
import { dstu } from '../api';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';

interface TranslationData {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}

/**
 * 翻译查看器包装组件
 *
 * 通过 DSTU API 加载翻译数据。
 */
export const TranslationViewerWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'translation', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [translationData, setTranslationData] = useState<TranslationData | null>(null);

  // 判断是否为创建模式（翻译不支持创建模式）
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取信息
  const pathInfo = !isCreateMode && 'path' in props ? pathUtils.parse(props.path) : null;
  const path = !isCreateMode && 'path' in props ? props.path : null;

  // 加载翻译数据
  const loadTranslation = useCallback(async () => {
    if (isCreateMode) {
      setError(t('dstu:errors.internal'));
      setIsLoading(false);
      return;
    }

    if (!path) return;

    setIsLoading(true);
    setError(null);

    const result = await dstu.getContent(path);
    setIsLoading(false);

    if (result.ok) {
      const content = result.value;
      if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          setTranslationData({
            sourceText: parsed.sourceText || parsed.source_text || '',
            translatedText: parsed.translatedText || parsed.translated_text || '',
            sourceLang: parsed.sourceLang || parsed.source_lang || 'unknown',
            targetLang: parsed.targetLang || parsed.target_lang || 'unknown',
          });
        } catch {
          setTranslationData({
            sourceText: '',
            translatedText: content,
            sourceLang: 'unknown',
            targetLang: 'unknown',
          });
        }
      }
    } else {
      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      showGlobalNotification('error', errMsg);
    }
  }, [isCreateMode, path, t]);

  useEffect(() => {
    void loadTranslation();
  }, [loadTranslation]);

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
            onClick={() => void loadTranslation()}
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

  // 翻译查看器 UI
  return (
    <div className={cn('flex flex-col h-full', props.className)}>
      {/* 工具栏 */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
        <div className="flex items-center gap-2">
          <Languages className="w-5 h-5 text-muted-foreground" />
          <span className="text-sm font-medium">{t('dstu:types.translation')}</span>
          <span className="text-xs text-muted-foreground">
            {translationData?.sourceLang} → {translationData?.targetLang}
          </span>
        </div>
        {'onClose' in props && props.onClose && (
          <button
            className="px-3 py-1 text-sm border rounded-md hover:bg-muted"
            onClick={props.onClose}
          >
            {t('common:actions.close')}
          </button>
        )}
      </div>

      {/* 翻译内容 */}
      <CustomScrollArea className="flex-1" viewportClassName="p-4 space-y-4">
        {/* 原文 */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">
            {t('translation:source')}
          </label>
          <div className="p-3 bg-muted/30 rounded-md">
            <p className="text-sm">{translationData?.sourceText}</p>
          </div>
        </div>

        {/* 译文 */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">
            {t('translation:translated')}
          </label>
          <div className="p-3 bg-primary/5 border border-primary/20 rounded-md">
            <p className="text-sm">{translationData?.translatedText}</p>
          </div>
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default TranslationViewerWrapper;
