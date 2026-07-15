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

import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ContentViewProps } from '../UnifiedAppPanel';
import {
  essayDstuAdapter,
  type EssayGradingSession,
  type DstuGradingRound,
} from '@/dstu/adapters/essayDstuAdapter';
import { showGlobalNotification } from '@/components/UnifiedNotification';
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
  isActive,
}) => {
  const { t } = useTranslation(['essay_grading', 'common', 'learningHub']);

  // 会话状态
  const [session, setSession] = useState<EssayGradingSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // 记录当前 node ID，用于丢弃切换节点后才完成的过期加载/保存
  const currentNodeIdRef = useRef<string>(node.id);
  // 已完成首次加载的节点 ID：同一节点的后续刷新静默进行，
  // 避免整屏 loading/错误屏卸载工作台导致用户输入丢失
  const loadedNodeIdRef = useRef<string | null>(null);

  // 节点切换时在渲染阶段同步重置状态（React "adjusting state during render" 模式）：
  // 避免新节点首帧短暂渲染上一节点的会话内容
  const [trackedNodeId, setTrackedNodeId] = useState(node.id);
  if (trackedNodeId !== node.id) {
    setTrackedNodeId(node.id);
    currentNodeIdRef.current = node.id;
    loadedNodeIdRef.current = null;
    setSession(null);
    setIsLoading(true);
    setError(null);
  }

  // 提取加载逻辑为独立函数以便重试
  const loadSession = useCallback(async () => {
    // 捕获本次加载对应的 node ID：若加载期间切换了节点，丢弃过期结果，防止串数据
    const requestNodeId = node.id;
    const isStale = () => currentNodeIdRef.current !== requestNodeId;
    // 该节点是否已成功展示过：是则本次为静默刷新，
    // 不得进入整屏 loading/错误屏（会卸载工作台，丢失用户正在输入的内容）
    const isFirstLoad = loadedNodeIdRef.current !== requestNodeId;
    if (isFirstLoad) {
      setIsLoading(true);
      setError(null);
    }

    try {
      // 尝试加载完整会话数据（返回 Result 类型）
      const result = await essayDstuAdapter.getFullSession(node.id);
      if (isStale()) return;
      if (result.ok && result.value) {
        setSession(result.value);
        loadedNodeIdRef.current = requestNodeId;
      } else if (!result.ok) {
        // M-046 fix: 加载失败时进入错误态，而非吞没为空会话
        console.warn('[EssayContentView] Failed to load session:', result.error?.toUserMessage?.() || result.error);
        if (isFirstLoad) {
          setError(result.error?.toUserMessage?.() || t('learningHub:error.loadFailed'));
        }
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
        loadedNodeIdRef.current = requestNodeId;
      }
    } catch (err: unknown) {
      if (isStale()) return;
      // M-046 fix: 异常时进入错误态，而非吞没为空会话
      console.error('[EssayContentView] Failed to load session:', err);
      if (isFirstLoad) {
        setError(getErrorMessage(err));
      }
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
    }
  }, [node, t]);

  // 加载会话数据
  useEffect(() => {
    currentNodeIdRef.current = node.id;
    void loadSession();
  }, [node, loadSession]);

  // 稳定 dstuMode 引用：工作台多个 useCallback 依赖 dstuMode，
  // 每次渲染重建对象会导致其内部回调全部失效重建。
  // 回调绑定创建时的 node ID：切换节点后才完成的保存/新轮次
  // 仍持久化到原会话（不丢数据），但不再污染新节点的视图状态
  const dstuMode = useMemo(() => {
    const boundNodeId = node.id;
    const isCurrent = () => currentNodeIdRef.current === boundNodeId;
    return {
      session,
      onSessionSave: async (updatedSession: EssayGradingSession) => {
        try {
          // 先持久化 DSTU 元数据，成功后再更新本地状态，避免失败时状态与存储不一致
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
          if (isCurrent()) {
            setSession(updatedSession);
          }
        } catch (error: unknown) {
          // 元数据保存失败不代表批改失败（轮次已由后端持久化），
          // 在此给出准确提示并吞掉错误，避免工作台误报"批改失败"
          console.error('[EssayContentView] Failed to save session meta:', error);
          showGlobalNotification('error', t('essay_grading:toast.save_failed', { error: getErrorMessage(error) }));
        }
      },
      onRoundAdd: async (round: DstuGradingRound) => {
        // 轮次已由后端持久化；若节点已切换，跳过本地状态更新，
        // 避免把旧节点的轮次追加进新节点的会话
        if (!isCurrent()) return;
        setSession(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            rounds: [...prev.rounds, round],
            updatedAt: Date.now(),
          };
        });
      },
      resourceId: boundNodeId,
    };
  }, [session, node.id, t]);

  // 加载状态（含会话尚未就绪的兜底）
  if (isLoading || (!error && !session)) {
    return (
      <div className="flex items-center justify-center h-full bg-background" role="status">
        <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading')}
        </span>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-background gap-4" role="alert">
        <p className="text-destructive text-center">{error}</p>
        <div className="flex gap-2">
          <NotionButton variant="primary" size="sm" onClick={() => void loadSession()}>
            {t('common:retry')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="default" size="sm" onClick={onClose}>
              {t('common:close')}
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
          <div className="flex items-center justify-center h-full" role="status">
            <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="ml-2 text-muted-foreground">
              {t('common:loading')}
            </span>
          </div>
        }
      >
        {/* key=node.id：切换节点时强制重挂载工作台（其内部状态仅在挂载时从 session 初始化） */}
        <EssayGradingWorkbench
          key={node.id}
          onBack={onClose}
          isActive={isActive}
          dstuMode={dstuMode}
        />
      </Suspense>
    </div>
  );
};

export default EssayContentView;
