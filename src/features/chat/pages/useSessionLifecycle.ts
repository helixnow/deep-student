import React, { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { sessionManager } from '../core/session/sessionManager';
import { getErrorMessage } from '@/utils/errorUtils';
import { TauriAPI } from '@/utils/tauriApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ChatSession } from '../types/session';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { TFunction } from 'i18next';
import {
  buildHiddenDraftSessionMetadata,
  getDraftSessionScope,
  getHiddenDraftSessionScope,
  getStoredDraftSessionId,
  persistHiddenDraftSessionId,
  clearHiddenDraftSessionId,
} from './draftSession';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const emitSessionListUpdated = () => {
  window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
};

const requestChatInputFocus = (sessionId: string) => {
  const emitFocus = () => {
    window.dispatchEvent(new CustomEvent('CHAT_V2_FOCUS_INPUT', {
      detail: { sessionId },
    }));
  };

  requestAnimationFrame(emitFocus);
  window.setTimeout(emitFocus, 120);
};

export interface UseSessionLifecycleDeps {
  currentSessionId: string | null;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setCurrentSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setTotalSessionCount: React.Dispatch<React.SetStateAction<number | null>>;
  setUngroupedSessionCount: React.Dispatch<React.SetStateAction<number | null>>;
  setHasMoreSessions: React.Dispatch<React.SetStateAction<boolean>>;
  setIsInitialLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setIsLoadingMore: React.Dispatch<React.SetStateAction<boolean>>;
  setShowChatControl: React.Dispatch<React.SetStateAction<boolean>>;
  isLoadingMore: boolean;
  hasMoreSessions: boolean;
  sessionsRef: React.MutableRefObject<ChatSession[]>;
  t: TFunction<any, any>;
  PAGE_SIZE: number;
  LAST_SESSION_KEY: string;
}

export function useSessionLifecycle(deps: UseSessionLifecycleDeps) {
  const {
    currentSessionId,
    setSessions, setCurrentSessionId, setIsLoading, setTotalSessionCount,
    setUngroupedSessionCount, setHasMoreSessions, setIsInitialLoading,
    setIsLoadingMore, setShowChatControl,
    isLoadingMore, hasMoreSessions, sessionsRef,
    t, PAGE_SIZE, LAST_SESSION_KEY,
  } = deps;

  const loadUngroupedCount = useCallback(async () => {
    try {
      const count = await invoke<number>('chat_v2_count_sessions', {
        status: 'active',
        groupId: '',
      });
      setUngroupedSessionCount(count);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load ungrouped count:', getErrorMessage(error));
    }
  }, []);

  const createHiddenDraftSession = useCallback(async (groupId?: string | null): Promise<ChatSession> => {
    const scope = getDraftSessionScope('chat', groupId ?? null);
    const session = await createSessionWithDefaults({
      mode: 'chat',
      title: null,
      metadata: buildHiddenDraftSessionMetadata(null, scope),
      groupId,
    });
    persistHiddenDraftSessionId(scope, session.id);
    return session;
  }, []);

  const getOrCreateHiddenDraftSession = useCallback(async (groupId?: string | null): Promise<ChatSession> => {
    const scope = getDraftSessionScope('chat', groupId ?? null);
    const storedDraftId = getStoredDraftSessionId(scope);

    if (storedDraftId) {
      try {
        const storedDraft = await invoke<ChatSession | null>('chat_v2_get_session', {
          sessionId: storedDraftId,
        });
        if (storedDraft && getHiddenDraftSessionScope(storedDraft.metadata) === scope) {
          return storedDraft;
        }
      } catch (error) {
        console.warn('[ChatV2Page] Failed to reuse hidden draft session:', getErrorMessage(error));
      }
      clearHiddenDraftSessionId(scope);
    }

    return createHiddenDraftSession(groupId);
  }, [createHiddenDraftSession]);

  const getCurrentHiddenDraftSessionScope = useCallback(() => {
    if (!currentSessionId) {
      return null;
    }

    const store = sessionManager.get(currentSessionId);
    const metadata = store?.getState().sessionMetadata;
    return getHiddenDraftSessionScope(metadata);
  }, [currentSessionId]);

  // 创建新会话（使用全局科目）- 提前定义用于 useMobileHeader
  const createSession = useCallback(async (groupId?: string) => {
    const currentDraftScope = getCurrentHiddenDraftSessionScope();
    const targetDraftScope = getDraftSessionScope('chat', groupId ?? null);
    if (currentDraftScope === targetDraftScope) {
      return;
    }

    setIsLoading(true);
    try {
      const session = await getOrCreateHiddenDraftSession(groupId);
      setCurrentSessionId(session.id);
      requestChatInputFocus(session.id);
    } catch (error) {
      console.error('[ChatV2Page] Failed to create session:', getErrorMessage(error));
      showGlobalNotification('error', t('page.createSessionFailed', '创建会话失败，请稍后重试'));
    } finally {
      setIsLoading(false);
    }
  }, [getCurrentHiddenDraftSessionScope, getOrCreateHiddenDraftSession, t]);

  // P1-06: 创建分析模式会话
  // 打开文件对话框让用户选择图片，然后创建 analysis 模式会话
  const createAnalysisSession = useCallback(async () => {
    try {
      // 打开文件对话框选择图片
      const selected = await dialogOpen({
        multiple: true,
        directory: false,
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
          },
        ],
      });

      // 用户取消选择
      if (!selected || (Array.isArray(selected) && selected.length === 0)) {
        console.log('[ChatV2Page] No images selected for analysis session');
        return;
      }

      // 确保 selected 是数组
      const imagePaths = Array.isArray(selected) ? selected : [selected];

      setIsLoading(true);

      // 读取图片并转换为 base64
      const images: string[] = [];
      for (const path of imagePaths) {
        try {
          const bytes = await TauriAPI.readFileAsBytes(path);
          // 🔒 审计修复: 分块编码 base64，避免 String.fromCharCode(...bytes) 对大文件栈溢出
          // 原代码对 >1MB 文件触发 RangeError: Maximum call stack size exceeded
          const CHUNK_SIZE = 0x8000; // 32KB chunks
          let binary = '';
          for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
            const chunk = bytes.subarray(i, i + CHUNK_SIZE);
            binary += String.fromCharCode.apply(null, Array.from(chunk));
          }
          const base64 = btoa(binary);
          // 根据文件扩展名确定 MIME 类型
          const ext = path.split('.').pop()?.toLowerCase() || 'png';
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
          images.push(`data:${mimeType};base64,${base64}`);
        } catch (error) {
          console.error('[ChatV2Page] Failed to read image:', path, error);
        }
      }

      if (images.length === 0) {
        console.error('[ChatV2Page] Failed to read any images');
        setIsLoading(false);
        return;
      }

      // 创建 analysis 模式会话，并传递图片作为初始化配置
      const session = await createSessionWithDefaults({
        mode: 'analysis',
        title: t('page.analysis_session_title'),
        metadata: {
          initConfig: {
            images,
          },
        },
        initConfig: {
          images,
        },
      });

      setSessions((prev) => [session, ...prev]);
      emitSessionListUpdated();
      setTotalSessionCount((prev) => (prev !== null ? prev + 1 : null));
      void loadUngroupedCount();
      setCurrentSessionId(session.id);

      console.log('[ChatV2Page] Created analysis session:', session.id, 'with', images.length, 'images');
    } catch (error) {
      console.error('[ChatV2Page] Failed to create analysis session:', getErrorMessage(error));
      showGlobalNotification('error', t('page.createAnalysisSessionFailed', '创建分析会话失败，请稍后重试'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // ========== 移动端状态 ==========
  // 🚀 性能优化：使用 useDeferredValue 实现乐观更新
  // - currentSessionId 立即更新（侧边栏高亮立即响应）
  // - deferredSessionId 延迟更新（ChatContainer 重渲染在后台进行）
  const loadSessions = useCallback(async () => {
    try {
      // 并行获取：所有已分组会话 + 未分组首页 + 计数
      const [groupedResult, ungroupedResult, totalCount, ungroupedCount] = await Promise.all([
        // groupId="*" 表示 group_id IS NOT NULL，一次性加载所有已分组会话
        invoke<ChatSession[]>('chat_v2_list_sessions', {
          status: 'active',
          groupId: '*',
          limit: 10000,
          offset: 0,
        }),
        // 未分组会话分页加载
        invoke<ChatSession[]>('chat_v2_list_sessions', {
          status: 'active',
          groupId: '',
          limit: PAGE_SIZE,
          offset: 0,
        }),
        invoke<number>('chat_v2_count_sessions', { status: 'active' }),
        invoke<number>('chat_v2_count_sessions', { status: 'active', groupId: '' }),
      ]);

      const allSessions = [...groupedResult, ...ungroupedResult]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setSessions(allSessions);
      emitSessionListUpdated();
      setTotalSessionCount(totalCount);
      setUngroupedSessionCount(ungroupedCount);
      // "加载更多"只针对未分组会话
      setHasMoreSessions(ungroupedResult.length >= PAGE_SIZE);

      // 启动行为：进入一个隐藏 draft。它不进入左侧列表，只有首条消息后才转正。
      let sessionToSelect: string | null = null;

      try {
        const draftSession = await getOrCreateHiddenDraftSession();
        sessionToSelect = draftSession.id;
      } catch (e) {
        console.warn('[ChatV2Page] Failed to create startup draft session:', e);
        if (allSessions.length > 0) {
          sessionToSelect = allSessions[0].id;
        }
      }

      setCurrentSessionId(sessionToSelect);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load sessions:', getErrorMessage(error));
      showGlobalNotification('error', t('page.loadSessionsFailed', '加载会话失败，请刷新后重试'));
    } finally {
      setIsInitialLoading(false);
    }
  }, [getOrCreateHiddenDraftSession, t]);

  // P1-22: 加载更多会话（无限滚动分页）
  // 🔧 分组懒加载修复：只加载更多未分组会话，已分组会话在初始加载时已全量获取
  // 🔧 批判性修复：使用 sessionsRef 动态计算 offset，避免删除/移动会话后 ref 漂移导致跳过会话
  const loadMoreSessions = useCallback(async () => {
    if (isLoadingMore || !hasMoreSessions) return;

    setIsLoadingMore(true);
    try {
      // 动态计算当前已加载的未分组会话数量作为 offset
      const currentUngroupedLoaded = sessionsRef.current.filter(s => !s.groupId).length;
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '',
        limit: PAGE_SIZE,
        offset: currentUngroupedLoaded,
      });

      if (result.length > 0) {
        setSessions(prev => [...prev, ...result]);
        emitSessionListUpdated();
      }
      // 如果返回数量小于 PAGE_SIZE，说明没有更多数据
      setHasMoreSessions(result.length >= PAGE_SIZE);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load more sessions:', getErrorMessage(error));
      showGlobalNotification('warning', t('page.loadMoreSessionsFailed', '加载更多会话失败，请重试'));
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMoreSessions, t]);

  // ========== 🔧 P1修复：基于消息数量判断是否为空对话 ==========
  // 问题：原逻辑基于标题判断，但标题是后端异步生成的，导致有消息也不能新建
  // 修复：监听当前会话 store 的消息数量，有消息则可新建对话
  // 删除会话：Codex-style active/archive/permanent-delete 模型中，删除即永久删除
  // 🔧 P1-005 修复：使用 ref 获取最新状态，避免闭包竞态条件
  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await invoke('chat_v2_delete_session', { sessionId });
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        emitSessionListUpdated();
        setTotalSessionCount((prev) => (prev !== null ? prev - 1 : null));
        void loadUngroupedCount();

        // 🔧 P1-28: 如果删除的是 localStorage 中保存的会话，清理它
        try {
          const lastSessionId = localStorage.getItem(LAST_SESSION_KEY);
          if (lastSessionId === sessionId) {
            localStorage.removeItem(LAST_SESSION_KEY);
          }
        } catch (e) {
          console.warn('[ChatV2Page] Failed to clear last session ID:', e);
        }

        // 如果删除的是当前会话，切换到下一个
        // 使用 sessionsRef.current 获取最新状态，避免闭包中使用过时的 sessions
        const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);
        if (remaining.length === 0) {
          try {
            const draftSession = await getOrCreateHiddenDraftSession();
            setSessions([]);
            emitSessionListUpdated();
            setTotalSessionCount(0);
            setUngroupedSessionCount(0);
            setCurrentSessionId(draftSession.id);
          } catch (e) {
            console.warn('[ChatV2Page] Failed to create replacement draft session:', e);
            setCurrentSessionId(null);
          }
        } else {
          setCurrentSessionId((prevId) => {
            if (prevId === sessionId) {
              return remaining[0].id;
            }
            return prevId;
          });
        }
      } catch (error) {
        console.error('[ChatV2Page] Failed to delete session:', getErrorMessage(error));
        showGlobalNotification('error', t('page.deleteSessionFailed', '删除会话失败，请稍后重试'));
      }
    },
    [getOrCreateHiddenDraftSession, loadUngroupedCount, t] // 不再依赖 currentSessionId 和 sessions，使用 ref 和函数式更新
  );

  // 🆕 打开/关闭对话控制侧栏
  const toggleChatControl = useCallback(() => {
    setShowChatControl((prev) => !prev);
  }, []);

  // 🆕 2026-01-20: 点击 Worker Agent 查看输出 - 切换到对应会话
  const handleViewAgentSession = useCallback((agentSessionId: string) => {
    console.log('[ChatV2Page] Switching to agent session:', agentSessionId);
    setCurrentSessionId(agentSessionId);
  }, [setCurrentSessionId]);

  return {
    loadUngroupedCount,
    createSession,
    createAnalysisSession,
    loadSessions,
    loadMoreSessions,
    deleteSession,
    toggleChatControl,
    handleViewAgentSession,
  };
}
