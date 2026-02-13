/**
 * TranslationContentView - 翻译内容视图
 *
 * 统一应用面板中的翻译视图。
 * 通过 DSTU 节点获取翻译会话数据，渲染翻译工作台。
 *
 * 新建流程已统一：先创建空文件 → 再打开加载 → 编辑保存
 * 不再需要 __create_new__ 特殊模式
 */

import React, { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { ContentViewProps } from '../UnifiedAppPanel';
import {
  translationDstuAdapter,
  dstuNodeToTranslationSession,
  type TranslationSession,
} from '@/dstu/adapters/translationDstuAdapter';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { NotionButton } from '@/components/ui/NotionButton';

// 懒加载翻译工作台
const TranslateWorkbench = lazy(() => 
  import('@/components/TranslateWorkbench').then(m => ({ default: m.TranslateWorkbench }))
);

/**
 * 翻译内容视图
 */
const TranslationContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
}) => {
  const { t } = useTranslation(['translation', 'common', 'learningHub']);

  // 翻译会话状态
  const [session, setSession] = useState<TranslationSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // 记录当前 node ID，用于判断是否为同一文件的首次保存
  const currentNodeIdRef = useRef<string>(node.id);

  // 加载翻译数据
  const loadSession = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      // 先尝试从 node.metadata 直接转换
      // 空文件的 metadata 包含默认空值，也能正确转换
      const converted = dstuNodeToTranslationSession(node);
      
      // 检查是否有实际内容（空文件的 sourceText 为空）
      if (converted.sourceText) {
        setSession(converted);
      } else {
        // 尝试从 DSTU 获取完整数据
        const result = await translationDstuAdapter.getTranslation(node.id);
        if (result.ok && result.value) {
          setSession(dstuNodeToTranslationSession(result.value));
        } else if (!result.ok) {
          // S-018 修复：加载失败时进入错误态，阻止保存操作，防止空内容覆盖真实数据
          const errMsg = 'error' in result ? getErrorMessage(result.error) : t('translation:errors.load_failed_generic', '加载翻译数据失败');
          console.error('[TranslationContentView] Failed to load translation from DSTU:', errMsg);
          setLoadError(errMsg);
          setSession(null);
          return;
        } else {
          // 空文件：设置为带 node.id 的空会话
          setSession({
            ...converted,
            id: node.id,
          });
        }
      }
    } catch (error: unknown) {
      // S-018 修复：加载异常时进入错误态，不设置空会话，防止空内容覆盖真实数据
      const errMsg = getErrorMessage(error);
      console.error('[TranslationContentView] Failed to load translation:', error);
      showGlobalNotification('error', t('translation:errors.load_failed', { error: errMsg }));
      setLoadError(errMsg);
      setSession(null);
    } finally {
      setIsLoading(false);
    }
  }, [node, t]);

  useEffect(() => {
    currentNodeIdRef.current = node.id;
    void loadSession();
  }, [node, loadSession]);

  // 保存会话回调
  // 已创建的空文件会有 ID，所以始终是更新操作
  const handleSessionSave = useCallback(async (updatedSession: TranslationSession) => {
    try {
      // 确保使用当前 node 的 ID
      const sessionToSave = {
        ...updatedSession,
        id: currentNodeIdRef.current,
      };
      
      // 更新翻译记录
      await translationDstuAdapter.updateTranslation(sessionToSave);
      setSession(sessionToSave);
    } catch (error: unknown) {
      console.error('[TranslationContentView] Failed to save translation:', error);
      showGlobalNotification('error', t('translation:toast.save_failed', { error: getErrorMessage(error) }));
      throw error; // 重新抛出，让工作台知道保存失败
    }
  }, [t]);

  // 加载中状态
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
        </span>
      </div>
    );
  }

  // S-018 修复：加载失败时显示错误态，阻止用户在空表单上操作
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-background gap-4 p-8">
        <AlertTriangle className="w-10 h-10 text-destructive" />
        <p className="text-sm text-destructive text-center max-w-md">
          {t('translation:errors.load_failed', { error: loadError })}
        </p>
        <div className="flex gap-2">
          <NotionButton variant="primary" onClick={() => void loadSession()}>
            {t('common:retry', '重试')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="ghost" onClick={onClose}>
              {t('common:back', '返回')}
            </NotionButton>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">
              {t('common:loading', '加载中...')}
            </span>
          </div>
        }
      >
        <TranslateWorkbench
          onBack={onClose}
          dstuMode={{
            session,
            onSessionSave: handleSessionSave,
          }}
        />
      </Suspense>
    </div>
  );
};

export default TranslationContentView;
