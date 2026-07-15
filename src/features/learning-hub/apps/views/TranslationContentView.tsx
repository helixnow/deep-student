/**
 * TranslationContentView - 翻译内容视图
 *
 * 统一应用面板中的翻译视图。
 * 通过 DSTU 节点获取翻译会话数据，渲染翻译工作台。
 *
 * 新建流程已统一：先创建空文件 → 再打开加载 → 编辑保存
 * 不再需要 __create_new__ 特殊模式
 */

import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, Warning } from '@phosphor-icons/react';
import type { ContentViewProps } from '../UnifiedAppPanel';
import {
  translationDstuAdapter,
  dstuNodeToTranslationSession,
  type TranslationSession,
} from '@/dstu/adapters/translationDstuAdapter';
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
  isActive,
}) => {
  const { t } = useTranslation(['translation', 'common', 'learningHub']);

  // 翻译会话状态
  // 首帧同步初始化：metadata 已含完整内容时（重新打开已有翻译的常见场景）
  // 直接就绪，消除不必要的整屏 loading 闪烁
  const [session, setSession] = useState<TranslationSession | null>(() => {
    try {
      const converted = dstuNodeToTranslationSession(node);
      return converted.sourceText ? converted : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(!session);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // 记录当前 node ID，用于丢弃切换节点后才完成的过期加载/保存
  const currentNodeIdRef = useRef<string>(node.id);
  // 已完成首次加载的节点 ID：同一节点的后续刷新静默进行，
  // 避免整屏 loading/错误屏卸载工作台导致用户输入丢失
  // （同步初始化成功时挂载即视为已加载）
  const loadedNodeIdRef = useRef<string | null>(session ? node.id : null);

  // 节点切换时在渲染阶段同步重置状态（React "adjusting state during render" 模式）：
  // 保证 key 切换后的工作台首帧即拿到正确的初始会话，不会闪现上一节点内容
  const [trackedNodeId, setTrackedNodeId] = useState(node.id);
  if (trackedNodeId !== node.id) {
    setTrackedNodeId(node.id);
    currentNodeIdRef.current = node.id;
    let next: TranslationSession | null = null;
    try {
      const converted = dstuNodeToTranslationSession(node);
      next = converted.sourceText ? converted : null;
    } catch {
      next = null;
    }
    // 无法同步就绪时清空"已加载"标记，让 loadSession 按首次加载处理
    // （出错进入错误屏，而非静默失败后渲染空会话工作台）
    loadedNodeIdRef.current = next ? node.id : null;
    setSession(next);
    setIsLoading(!next);
    setLoadError(null);
  }

  // 加载翻译数据
  const loadSession = useCallback(async () => {
    // 捕获本次加载对应的 node ID：若加载期间切换了节点，丢弃过期结果，防止串数据
    const requestNodeId = node.id;
    const isStale = () => currentNodeIdRef.current !== requestNodeId;
    // 该节点是否已成功展示过：是则本次为静默刷新，
    // 不得进入整屏 loading/错误屏（会卸载工作台，丢失用户正在输入的内容）
    const isFirstLoad = loadedNodeIdRef.current !== requestNodeId;
    if (isFirstLoad) {
      setLoadError(null);
    }
    try {
      // 先尝试从 node.metadata 直接转换
      // 空文件的 metadata 包含默认空值，也能正确转换
      const converted = dstuNodeToTranslationSession(node);
      
      // 检查是否有实际内容（空文件的 sourceText 为空）
      if (converted.sourceText) {
        // 同步就绪，无需进入 loading。本地已有同节点更新的会话（如刚保存过）时
        // 保留本地版本，避免被父级传入的过期 metadata 回退
        setSession(prev =>
          prev && prev.id === converted.id && prev.updatedAt >= converted.updatedAt
            ? prev
            : converted
        );
        loadedNodeIdRef.current = requestNodeId;
      } else {
        // 需要异步获取时才进入 loading（仅首次；静默刷新保持工作台挂载）
        if (isFirstLoad) {
          setIsLoading(true);
        }
        // 尝试从 DSTU 获取完整数据
        const result = await translationDstuAdapter.getTranslation(node.id);
        if (isStale()) return;
        if (result.ok && result.value) {
          setSession(dstuNodeToTranslationSession(result.value));
          loadedNodeIdRef.current = requestNodeId;
        } else if (!result.ok) {
          // S-018 修复：加载失败时进入错误态，阻止保存操作，防止空内容覆盖真实数据
          const errMsg = 'error' in result ? getErrorMessage(result.error) : t('translation:errors.load_failed_generic');
          console.error('[TranslationContentView] Failed to load translation from DSTU:', errMsg);
          if (isFirstLoad) {
            setLoadError(errMsg);
            setSession(null);
          }
          return;
        } else {
          // 空文件：设置为带 node.id 的空会话
          setSession({
            ...converted,
            id: node.id,
          });
          loadedNodeIdRef.current = requestNodeId;
        }
      }
    } catch (error: unknown) {
      if (isStale()) return;
      // S-018 修复：加载异常时进入错误态，不设置空会话，防止空内容覆盖真实数据
      const errMsg = getErrorMessage(error);
      console.error('[TranslationContentView] Failed to load translation:', error);
      if (isFirstLoad) {
        setLoadError(errMsg);
        setSession(null);
      }
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
    }
  }, [node, t]);

  useEffect(() => {
    currentNodeIdRef.current = node.id;
    void loadSession();
  }, [node, loadSession]);

  // 稳定 dstuMode 引用：工作台多个 useCallback 依赖 dstuMode，
  // 每次渲染重建对象会导致其内部回调全部失效重建。
  // 保存回调绑定创建时的 node ID：切换节点后才完成的保存仍写回发起保存的节点
  // （不丢数据），但不再覆盖新节点的视图状态，也不会串写到新节点
  const dstuMode = useMemo(() => {
    const boundNodeId = node.id;
    return {
      session,
      // 已创建的空文件会有 ID，所以始终是更新操作
      onSessionSave: async (updatedSession: TranslationSession) => {
        const sessionToSave = {
          ...updatedSession,
          id: boundNodeId,
        };
        try {
          // 更新翻译记录
          await translationDstuAdapter.updateTranslation(sessionToSave);
          // 仅在仍是当前节点时同步本地状态
          if (currentNodeIdRef.current === boundNodeId) {
            setSession(sessionToSave);
          }
        } catch (error: unknown) {
          console.error('[TranslationContentView] Failed to save translation:', error);
          // 重新抛出，由工作台各调用点统一展示保存失败提示（避免双重 toast）
          throw error;
        }
      },
      resourceId: boundNodeId,
    };
  }, [session, node.id]);

  // 加载中状态
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-background" role="status">
        <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading')}
        </span>
      </div>
    );
  }

  // S-018 修复：加载失败时显示错误态，阻止用户在空表单上操作
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-background gap-4 p-8" role="alert">
        <Warning size={40} className="text-destructive" aria-hidden="true" />
        <p className="text-sm text-destructive text-center max-w-md">
          {t('translation:errors.load_failed', { error: loadError })}
        </p>
        <div className="flex gap-2">
          <NotionButton variant="primary" onClick={() => void loadSession()}>
            {t('common:retry')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="ghost" onClick={onClose}>
              {t('common:back')}
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
        <TranslateWorkbench
          key={node.id}
          onBack={onClose}
          isActive={isActive}
          dstuMode={dstuMode}
        />
      </Suspense>
    </div>
  );
};

export default TranslationContentView;
