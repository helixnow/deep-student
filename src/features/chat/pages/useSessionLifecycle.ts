import React, { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { sessionManager } from '../core/session/sessionManager';
import { getErrorMessage } from '@/utils/errorUtils';
import { TauriAPI } from '@/utils/tauriApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ChatSession } from '../types/session';
import { retainSessionListStore, useSessionListStore } from '../stores/sessionListStore';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { getSuperAgentSessionId, useSuperAgentEnabledStore } from '@/stores/superAgentEnabledStore';
import type { TFunction } from 'i18next';
import {
  buildHiddenDraftSessionMetadata,
  getDraftSessionScope,
  getHiddenDraftSessionScope,
  getStoredDraftSessionId,
  isHiddenDraftSessionId,
  isHiddenDraftSessionMetadata,
  persistHiddenDraftSessionId,
  clearHiddenDraftSessionId,
  trackHiddenDraftSessionId,
} from './draftSession';
import {
  clearLastActiveSessionId,
  clearLastActiveSessionIdIfMatches,
  isResumableSession,
  readLastActiveSessionId,
  resolveStartupResumableSessionId,
} from './lastActiveSession';
import { peekPendingChatNavigation } from '../navigation/pendingChatNavigation';

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
  currentSessionIdRef?: React.MutableRefObject<string | null>;
  selectionEpochRef?: React.MutableRefObject<number>;
  earlyNewSessionIntentRef?: React.MutableRefObject<boolean>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setCurrentSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setTotalSessionCount: React.Dispatch<React.SetStateAction<number | null>>;
  setUngroupedSessionCount: React.Dispatch<React.SetStateAction<number | null>>;
  setIsInitialLoading: React.Dispatch<React.SetStateAction<boolean>>;
  sessionsRef: React.MutableRefObject<ChatSession[]>;
  t: TFunction<any, any>;
  LAST_SESSION_KEY: string;
}

export function useSessionLifecycle(deps: UseSessionLifecycleDeps) {
  const {
    currentSessionId,
    setSessions, setCurrentSessionId, setIsLoading, setTotalSessionCount,
    setUngroupedSessionCount, setIsInitialLoading, sessionsRef,
    t, LAST_SESSION_KEY,
  } = deps;

  const fallbackCurrentSessionIdRef = useRef<string | null>(currentSessionId);
  fallbackCurrentSessionIdRef.current = currentSessionId;
  const currentSessionIdRef = deps.currentSessionIdRef ?? fallbackCurrentSessionIdRef;

  const fallbackSelectionEpochRef = useRef(0);
  const selectionEpochRef = deps.selectionEpochRef ?? fallbackSelectionEpochRef;

  const fallbackEarlyNewSessionIntentRef = useRef(false);
  const earlyNewSessionIntentRef = deps.earlyNewSessionIntentRef ?? fallbackEarlyNewSessionIntentRef;

  useEffect(() => retainSessionListStore(), []);

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
  }, [setUngroupedSessionCount]);

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

  // 同一 scope 的并发获取共享同一个 Promise，避免快速连点/启动竞态创建出
  // 多个隐藏 draft（后创建的覆盖 localStorage，先创建的成为孤儿空会话泄漏在库里）
  const draftSessionPromisesRef = useRef(new Map<string, Promise<ChatSession>>());

  const getOrCreateHiddenDraftSession = useCallback(async (groupId?: string | null): Promise<ChatSession> => {
    const scope = getDraftSessionScope('chat', groupId ?? null);

    const inFlight = draftSessionPromisesRef.current.get(scope);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const storedDraftId = getStoredDraftSessionId(scope);

      if (storedDraftId) {
        try {
          const storedDraft = await invoke<ChatSession | null>('chat_v2_get_session', {
            sessionId: storedDraftId,
          });
          if (storedDraft && getHiddenDraftSessionScope(storedDraft.metadata) === scope) {
            trackHiddenDraftSessionId(storedDraft.id);
            return storedDraft;
          }
        } catch (error) {
          console.warn('[ChatV2Page] Failed to reuse hidden draft session:', getErrorMessage(error));
        }
        clearHiddenDraftSessionId(scope);
      }

      return createHiddenDraftSession(groupId);
    })().finally(() => {
      draftSessionPromisesRef.current.delete(scope);
    });

    draftSessionPromisesRef.current.set(scope, promise);
    return promise;
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
    // 显式「新会话」意图：递增选择纪元以阻止尚未完成的 loadSessions 覆盖本次操作，
    // 同时清理 lastActiveSessionId，确保刷新时不会违背用户意愿强行跳回旧会话。
    selectionEpochRef.current += 1;
    clearLastActiveSessionId(LAST_SESSION_KEY);

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
      showGlobalNotification('error', t('page.createSessionFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [
    LAST_SESSION_KEY,
    getCurrentHiddenDraftSessionScope,
    getOrCreateHiddenDraftSession,
    selectionEpochRef,
    setCurrentSessionId,
    setIsLoading,
    t,
  ]);

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
      showGlobalNotification('error', t('page.createAnalysisSessionFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [loadUngroupedCount, setCurrentSessionId, setIsLoading, setSessions, setTotalSessionCount, t]);

  // ========== 移动端状态 ==========
  // 🚀 性能优化：使用 useDeferredValue 实现乐观更新
  // - currentSessionId 立即更新（侧边栏高亮立即响应）
  // - deferredSessionId 延迟更新（ChatContainer 重渲染在后台进行）
  const loadSessions = useCallback(async () => {
    const startSelectionEpoch = selectionEpochRef.current;
    const storedLastSessionId = readLastActiveSessionId(LAST_SESSION_KEY);
    const pendingNavAtStart = peekPendingChatNavigation();
    const shouldEagerlyPrepareDraft =
      !storedLastSessionId
      || earlyNewSessionIntentRef.current
      || pendingNavAtStart !== null;

    // ★ 性能（首屏瀑布消除）：无待恢复历史会话（或已有显式新会话/导航意图）时，
    // 启动 draft 获取与列表加载并行发起；有待恢复会话时延迟到确实回退时再创建，
    // 避免每次刷新恢复历史会话都多发一次后端 draft IPC。
    let draftSessionPromise: Promise<ChatSession> | null = shouldEagerlyPrepareDraft
      ? getOrCreateHiddenDraftSession()
      : null;
    // 列表加载失败走 catch 分支时，这里的错误由下方 await 统一处理；
    // 提前挂一个空 catch 防止 unhandled rejection 噪音
    draftSessionPromise?.catch(() => {});

    const hasActiveUserChoice = () =>
      selectionEpochRef.current !== startSelectionEpoch
      || currentSessionIdRef.current !== null;

    try {
      // Sidebar and page join one cached/in-flight list request. Counts are
      // independent: a failed count must not discard an otherwise usable list.
      const [listResult, totalCount, ungroupedCount] = await Promise.allSettled([
        useSessionListStore.getState().ensureLoaded(),
        invoke<number>('chat_v2_count_sessions', { status: 'active' }),
        invoke<number>('chat_v2_count_sessions', { status: 'active', groupId: '' }),
      ]);
      if (listResult.status === 'rejected') throw listResult.reason;
      const allSessions = useSessionListStore.getState().sessions;
      if (totalCount.status === 'fulfilled') setTotalSessionCount(totalCount.value);
      if (ungroupedCount.status === 'fulfilled') setUngroupedSessionCount(ungroupedCount.value);

      // 竞态保护：异步列表加载期间用户已主动切换会话或点击「新会话」时，绝不覆盖用户选择
      if (hasActiveUserChoice()) {
        return;
      }

      const pendingNav = peekPendingChatNavigation();
      const hasExplicitNewSessionIntent =
        earlyNewSessionIntentRef.current || pendingNav?.kind === 'new-session';
      const hasPendingSessionNav = pendingNav?.kind === 'session';

      if (hasExplicitNewSessionIntent) {
        earlyNewSessionIntentRef.current = false;
        clearLastActiveSessionId(LAST_SESSION_KEY);
      }

      let sessionToSelect: string | null = null;

      // 1. 外部入口（如学习资源「引用到对话」ensureActiveChatSession）提前激活并注入内容的草稿会话优先保留
      if (!hasExplicitNewSessionIntent && !hasPendingSessionNav) {
        const existingManagerSessionId = sessionManager.getCurrentSessionId();
        if (existingManagerSessionId && sessionManager.has(existingManagerSessionId)) {
          const existingState = sessionManager.peek(existingManagerSessionId)?.getState();
          const isDraftWithPendingContent = Boolean(
            existingState
            && (isHiddenDraftSessionMetadata(existingState.sessionMetadata)
              || isHiddenDraftSessionId(existingManagerSessionId))
            && (
              existingState.pendingContextRefs.length > 0
              || existingState.attachments.length > 0
              || existingState.inputValue.trim().length > 0
              || existingState.messageOrder.length > 0
            )
          );
          if (isDraftWithPendingContent) {
            sessionToSelect = existingManagerSessionId;
          }
        }
      }

      // 2. P3-2 自动恢复上次活跃会话：先在已加载会话中匹配；若不在首屏列表，单独向后端查验一次，
      // 防止分页/冷启动导致误清 lastActiveSessionId 而跌回空白新建草稿
      if (!sessionToSelect && !hasExplicitNewSessionIntent && !hasPendingSessionNav) {
        const storedId = readLastActiveSessionId(LAST_SESSION_KEY);
        if (storedId) {
          const inList = allSessions.find((session) => session.id === storedId);
          if (inList) {
            sessionToSelect = resolveStartupResumableSessionId(allSessions, LAST_SESSION_KEY);
          } else {
            const fetched = await invoke<ChatSession | null>('chat_v2_get_session', {
              sessionId: storedId,
            }).catch(() => null);
            if (hasActiveUserChoice()) {
              return;
            }
            if (fetched && isResumableSession(fetched)) {
              setSessions((prev) => (prev.some((item) => item.id === fetched.id) ? prev : [fetched, ...prev]));
              sessionToSelect = fetched.id;
            } else {
              sessionToSelect = resolveStartupResumableSessionId(allSessions, LAST_SESSION_KEY);
            }
          }
        }
      }

      // 3. 回退行为：进入隐藏 draft（首次启动、显式新建，或上次会话已删除/归档）。它不进入左侧列表，只有首条消息后才转正。
      if (!sessionToSelect) {
        try {
          if (!draftSessionPromise) {
            draftSessionPromise = getOrCreateHiddenDraftSession();
          }
          const draftSession = await draftSessionPromise;
          sessionToSelect = draftSession.id;
        } catch (e) {
          console.warn('[ChatV2Page] Failed to create startup draft session:', e);
          if (allSessions.length > 0) {
            sessionToSelect = allSessions[0].id;
          }
        }
      }

      // 二次竞态保护：await draft 期间用户可能已主动切换或点击新建
      if (hasActiveUserChoice()) {
        return;
      }

      setCurrentSessionId(sessionToSelect);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load sessions:', getErrorMessage(error));
      showGlobalNotification('error', t('page.loadSessionsFailed'));
    } finally {
      setIsInitialLoading(false);
    }
  }, [
    LAST_SESSION_KEY,
    currentSessionIdRef,
    earlyNewSessionIntentRef,
    getOrCreateHiddenDraftSession,
    selectionEpochRef,
    setCurrentSessionId,
    setIsInitialLoading,
    setTotalSessionCount,
    setUngroupedSessionCount,
    t,
  ]);

  // The page and sidebar share pagination and its in-flight guard as well.
  const loadMoreSessions = useCallback(async () => {
    try {
      await useSessionListStore.getState().loadMoreUngrouped();
    } catch {
      showGlobalNotification('warning', t('page.loadMoreSessionsFailed'));
    }
  }, [t]);

  // ========== 🔧 P1修复：基于消息数量判断是否为空对话 ==========
  // 问题：原逻辑基于标题判断，但标题是后端异步生成的，导致有消息也不能新建
  // 修复：监听当前会话 store 的消息数量，有消息则可新建对话
  // 删除会话：Codex-style active/archive/permanent-delete 模型中，删除即永久删除
  // 🔧 P1-005 修复：使用 ref 获取最新状态，避免闭包竞态条件
  const deleteSession = useCallback(
    async (sessionId: string) => {
      const isDeletingSuperSession = sessionId === getSuperAgentSessionId();
      try {
        await invoke('chat_v2_delete_session', { sessionId });
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        emitSessionListUpdated();
        setTotalSessionCount((prev) => (prev !== null ? prev - 1 : null));
        void loadUngroupedCount();

        // 🔧 P1-28: 如果删除的是 localStorage 中保存的会话，清理它
        clearLastActiveSessionIdIfMatches(sessionId, LAST_SESSION_KEY);

        // 删除 Super-agent 会话：后端已停止其后台任务并新建空的 Super-agent 会话
        // （经 super_session_changed 广播新 id）；拉取最新状态，正停在旧会话时切到新会话。
        if (isDeletingSuperSession) {
          const replacementId = (await useSuperAgentEnabledStore.getState().refresh())?.sessionId ?? null;
          if (replacementId && replacementId !== sessionId) {
            setCurrentSessionId((prevId) => (prevId === sessionId ? replacementId : prevId));
            return;
          }
        }

        // 如果删除的是当前会话，切换到下一个
        // 使用 sessionsRef.current 获取最新状态，避免闭包中使用过时的 sessions
        const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);
        if (remaining.length === 0) {
          try {
            const draftSession = await getOrCreateHiddenDraftSession();
            setSessions([]);
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
        showGlobalNotification('error', t('page.deleteSessionFailed'));
      }
    },
    // 不再依赖 currentSessionId 和 sessions，使用 ref 和函数式更新
    [
      getOrCreateHiddenDraftSession, loadUngroupedCount, LAST_SESSION_KEY, sessionsRef,
      setCurrentSessionId, setSessions, setTotalSessionCount, setUngroupedSessionCount, t,
    ]
  );

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
    getOrCreateHiddenDraftSession,
    handleViewAgentSession,
  };
}
