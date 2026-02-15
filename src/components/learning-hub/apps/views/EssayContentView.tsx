/**
 * EssayContentView - 作文批改内容视图
 *
 * 统一应用面板中的作文批改视图。
 * 通过 DSTU 节点获取批改会话数据，渲染作文批改工作台。
 *
 * 新建流程已统一：先创建空文件 → 再打开加载 → 编辑保存
 * 不再需要 __create_new__ 特殊模式
 * 历史由 Learning Hub 管理，工作台中隐藏历史 Tab
 */

import React, { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ContentViewProps } from '../UnifiedAppPanel';
import {
  essayDstuAdapter,
  type EssayGradingSession,
  type DstuGradingRound,
} from '@/dstu/adapters/essayDstuAdapter';
import { getErrorMessage } from '@/utils/errorUtils';

// 懒加载作文批改工作台
const EssayGradingWorkbench = lazy(() => 
  import('@/components/EssayGradingWorkbench').then(m => ({ default: m.EssayGradingWorkbench }))
);

/**
 * 作文批改内容视图
 */
const EssayContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
}) => {
  const { t } = useTranslation(['essay_grading', 'common', 'learningHub']);

  // 会话状态
  const [session, setSession] = useState<EssayGradingSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // 记录当前 node ID
  const currentNodeIdRef = useRef<string>(node.id);

  // 提取加载逻辑为独立函数以便重试
  const loadSession = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // 尝试加载完整会话数据（返回 Result 类型）
      const result = await essayDstuAdapter.getFullSession(node.id);
      if (result.ok && result.value) {
        setSession(result.value);
      } else if (!result.ok) {
        // M-046 fix: 加载失败时进入错误态，而非吞没为空会话
        console.warn('[EssayContentView] Failed to load session:', result.error?.toUserMessage?.() || result.error);
        setError(result.error?.toUserMessage?.() || t('common:loadFailed', '加载失败'));
      } else {
        // result.ok 但无数据（空文件）：设置一个带 node.id 的空会话
        setSession({
          id: node.id,
          title: node.name || t('learningHub:exam.untitledEssay'),
          inputText: '',
          essayType: (node.metadata?.essayType as string) || '',
          gradeLevel: (node.metadata?.gradeLevel as string) || '',
          modeId: (node.metadata?.modeId as string) || 'practice',
          rounds: [],
          isFavorite: false,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        });
      }
    } catch (err: unknown) {
      // M-046 fix: 异常时进入错误态，而非吞没为空会话
      console.error('[EssayContentView] Failed to load session:', err);
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [node, t]);

  // 加载会话数据
  useEffect(() => {
    currentNodeIdRef.current = node.id;
    loadSession();
  }, [node, loadSession]);

  // 保存会话回调
  const handleSessionSave = useCallback(async (updatedSession: EssayGradingSession) => {
    console.log('[EssayContentView] Session saved:', updatedSession.id);
    // 更新本地状态
    setSession(updatedSession);
    // 更新 DSTU 元数据
    await essayDstuAdapter.updateSessionMeta(
      updatedSession.id,
      {
        title: updatedSession.title,
        essayType: updatedSession.essayType,
        gradeLevel: updatedSession.gradeLevel,
        modeId: updatedSession.modeId,   // ★ M-047 修复：持久化 modeId
        customPrompt: updatedSession.customPrompt,
        isFavorite: updatedSession.isFavorite,
      }
    );
  }, []);

  // 新轮次添加回调
  const handleRoundAdd = useCallback(async (round: DstuGradingRound) => {
    console.log('[EssayContentView] Round added:', round.round_number);
    // 更新本地状态
    setSession(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        rounds: [...prev.rounds, round],
        updatedAt: Date.now(),
      };
    });
  }, []);

  // 加载状态
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
        </span>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive text-center">{error}</p>
        <div className="flex gap-2">
          <NotionButton variant="primary" size="sm" onClick={loadSession}>
            {t('common:retry', '重试')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="default" size="sm" onClick={onClose}>
              {t('common:close', '关闭')}
            </NotionButton>
          )}
        </div>
      </div>
    );
  }

  // 会话未加载完成
  if (!session) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
        </span>
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
        <EssayGradingWorkbench
          onBack={onClose}
          dstuMode={{
            session,
            onSessionSave: handleSessionSave,
            onRoundAdd: handleRoundAdd,
          }}
        />
      </Suspense>
    </div>
  );
};

export default EssayContentView;
