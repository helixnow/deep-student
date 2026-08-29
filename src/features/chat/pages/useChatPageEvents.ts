import React, { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { extractMessageContentFromBlocks } from '../components/message/messageItemUtils';
import { pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { sessionManager } from '../core/session/sessionManager';
import { registerOpenResourceHandler } from '@/dstu/openResource';
import type { DstuNode } from '@/dstu/types';
import { mapDstuNodeToLearningHubItem } from './openResourceMapping';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';
import type { ResourceListItem, ResourceType } from '@/features/learning-hub/types';
import { useCommandEvents, COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { ChatSession } from '../types/session';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { TFunction } from 'i18next';
import {
  shouldChatHandleOpenNote,
  type DstuOpenNoteDetail,
} from '@/features/notes/openNoteEvent';
import {
  invalidatePendingChatNavigation,
  markChatPageReady,
} from '../navigation/pendingChatNavigation';
import { isHiddenDraftSession } from './draftSession';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export interface UseChatPageEventsDeps {
  notesContext: { openCanvasWithNote?: (noteId: string) => void } | null;
  t: TFunction<any, any>;
  loadSessions: () => Promise<void>;
  isInitialLoading: boolean;
  currentSessionId: string | null;
  createSession: (groupId?: string) => Promise<void>;
  createAnalysisSession: () => Promise<void>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setCurrentSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
  canvasSidebarOpen: boolean;
  toggleCanvasSidebar: () => void;
  setPendingOpenResource: React.Dispatch<React.SetStateAction<ResourceListItem | null>>;
  setOpenApp: React.Dispatch<React.SetStateAction<{ type: ResourceType; id: string; title: string; filePath?: string } | null>>;
  isSmallScreen: boolean;
  setMobileResourcePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  attachmentPreviewOpen: boolean;
  setAttachmentPreviewOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarCollapsed: boolean;
  handleSidebarCollapsedChange: (collapsed: boolean) => void;
  setSessionSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useChatPageEvents(deps: UseChatPageEventsDeps) {
  const {
    notesContext, t, loadSessions, isInitialLoading, currentSessionId,
    createSession, createAnalysisSession,
    setSessions, setCurrentSessionId,
    canvasSidebarOpen, toggleCanvasSidebar, setPendingOpenResource,
    setOpenApp, isSmallScreen, setMobileResourcePanelOpen,
    attachmentPreviewOpen, setAttachmentPreviewOpen,
    sidebarCollapsed, handleSidebarCollapsedChange, setSessionSheetOpen,
  } = deps;
  // 导航事件监听器保持稳定，ready effect 重放事件时读取本次 render 的加载态。
  // 若把 isInitialLoading 放进监听器依赖，React 会先移除旧监听器，再由前面的
  // ready effect 派发，导致重放落在无监听器的间隙。
  const isInitialLoadingRef = useRef(isInitialLoading);
  isInitialLoadingRef.current = isInitialLoading;

  useEffect(() => {
    const handleOpenNote = (event: CustomEvent<DstuOpenNoteDetail>) => {
      if (!shouldChatHandleOpenNote(event.detail)) return;
      const { noteId, source } = event.detail;
      
      // 方案1: 使用 openCanvasWithNote 打开笔记并显示侧边栏
      if (notesContext?.openCanvasWithNote) {
        try {
          notesContext.openCanvasWithNote(noteId);
        } catch (error) {
          console.error('[ChatV2Page] Failed to open note in canvas:', error);
          showGlobalNotification('error', t('page.openNoteFailed'));
        }
      } else {
        // 方案2: 备选 - 发送全局事件请求导航到 Learning Hub
        window.dispatchEvent(new CustomEvent('navigateToNote', {
          detail: { noteId, source }
        }));
      }
    };
    
    // TODO: migrate to centralized event registry
    window.addEventListener('DSTU_OPEN_NOTE' as any, handleOpenNote as any);
    return () => {
      window.removeEventListener('DSTU_OPEN_NOTE' as any, handleOpenNote as any);
    };
  }, [notesContext, t]);

  // 导航握手：初始加载完成（loadSessions 已选定启动会话，不会再覆盖导航）后
  // 进入就绪态并消费挂起的 navigate-to-session / CHAT_NEW_SESSION 意图。
  // 卸载或重新进入加载态时解除就绪。
  useEffect(() => {
    if (isInitialLoading) return;
    return markChatPageReady();
  }, [isInitialLoading]);

  // 只在挂载时加载一次：loadSessions 的身份会随语言切换（t）变化，
  // 若直接依赖会导致切换语言时重新加载并把当前会话重置回启动 draft
  const hasLoadedSessionsRef = useRef(false);
  useEffect(() => {
    if (hasLoadedSessionsRef.current) return;
    hasLoadedSessionsRef.current = true;
    pageLifecycleTracker.log('chat-v2', 'ChatV2Page', 'data_load', 'loadSessions');
    const start = Date.now();
    loadSessions().then(() => {
      pageLifecycleTracker.log('chat-v2', 'ChatV2Page', 'data_ready', undefined, { duration: Date.now() - start });
    });
  }, [loadSessions]);

  // 🔧 保底：初始加载完成后如果仍然没有会话（如 loadSessions 中自动创建失败），再次尝试创建
  const hasTriedAutoCreate = useRef(false);
  useEffect(() => {
    if (!isInitialLoading && !currentSessionId && !hasTriedAutoCreate.current) {
      hasTriedAutoCreate.current = true;
      console.log('[ChatV2Page] No session after initial load, auto-creating...');
      createSession();
    }
  }, [isInitialLoading, currentSessionId, createSession]);

  // ★ 调试插件：允许程序化切换会话（附件流水线测试插件使用）
  useEffect(() => {
    const handler = (e: Event) => {
      const sid = (e as CustomEvent)?.detail?.sessionId;
      if (sid && typeof sid === 'string') {
        console.log('[ChatV2Page] PIPELINE_TEST_SWITCH_SESSION:', sid);
        setCurrentSessionId(sid);
      }
    };
    window.addEventListener('PIPELINE_TEST_SWITCH_SESSION', handler);
    return () => window.removeEventListener('PIPELINE_TEST_SWITCH_SESSION', handler);
  }, [setCurrentSessionId]);

  const handleNavigateToSession = useCallback(async (e: Event) => {
    const sid = (e as CustomEvent<{ sessionId?: string }>)?.detail?.sessionId;
    // 未就绪时，标准事件只供 WorkbenchEventBridge 开窗；导航意图仍保留在
    // pendingChatNavigation，待 loadSessions 完成后重放，避免被启动 draft 覆盖。
    if (!sid || isInitialLoadingRef.current) return;

    // 本次事件已被直接消费：作废更早挂起的导航意图（最新意图生效）
    invalidatePendingChatNavigation();
    setCurrentSessionId(sid);

    try {
      const session = await invoke<ChatSession | null>('chat_v2_get_session', { sessionId: sid });
      if (!session) return;
      // 隐藏 draft 会话不进入左侧列表（外部 ensureActiveChatSession 激活 draft 时也会派发本事件）
      if (isHiddenDraftSession(session)) return;

      setSessions((prev) => {
        if (prev.some((item) => item.id === session.id)) {
          return prev;
        }
        return [session, ...prev];
      });
    } catch (error) {
      console.warn('[ChatV2Page] Failed to navigate to session:', getErrorMessage(error));
    }
  }, [setCurrentSessionId, setSessions]);

  useEventRegistry([
    {
      target: 'window',
      type: 'navigate-to-session',
      listener: handleNavigateToSession as EventListener,
    },
  ], [handleNavigateToSession]);

  // ★ 注册 OpenResourceHandler，让 openResource() 可以在 Chat V2 中工作
  useEffect(() => {
    const handler = {
      openInPanel: (path: string, node: DstuNode, _mode: 'view' | 'edit') => {
        console.log('[ChatV2Page] OpenResourceHandler.openInPanel:', path, node);
        const resourceItem = mapDstuNodeToLearningHubItem(node);
        if (!resourceItem) {
          console.warn('[ChatV2Page] Unsupported openResource node type:', node.type, node);
          showGlobalNotification('warning', t('page.resourceUnsupported'));
          return;
        }
        // 打开 Learning Hub 侧边栏（如果还没打开）
        if (isSmallScreen) {
          setMobileResourcePanelOpen(true);
        } else if (!canvasSidebarOpen) {
          toggleCanvasSidebar();
        }
        // 设置待打开的资源
        setPendingOpenResource(resourceItem);
      },
      openInPage: (path: string, node: DstuNode, mode: 'view' | 'edit') => {
        handler.openInPanel(path, node, mode);
      },
      openInFullscreen: (path: string, node: DstuNode, mode: 'view' | 'edit') => {
        handler.openInPanel(path, node, mode);
      },
      openInModal: (path: string, node: DstuNode, mode: 'view' | 'edit') => {
        handler.openInPanel(path, node, mode);
      },
    };

    // 🔧 P0-28 修复：使用命名空间注册，避免覆盖其他处理器
    const unregister = registerOpenResourceHandler(handler, 'chat-v2');
    return unregister;
  }, [canvasSidebarOpen, isSmallScreen, setMobileResourcePanelOpen, setPendingOpenResource, t, toggleCanvasSidebar]);

  // ★ 当 Learning Hub 侧边栏打开后，处理待打开的资源
  // 直接设置 openApp 状态，复用 UnifiedAppPanel 显示资源

  const handleAttachmentPreview = useCallback((event: Event) => {
    const customEvent = event as CustomEvent<{
      id: string;
      type: string;
      title: string;
    }>;

    const { id, type, title } = customEvent.detail;
    console.log('[ChatV2Page] CHAT_OPEN_ATTACHMENT_PREVIEW received:', customEvent.detail);

    setOpenApp({
      type: type as ResourceType,
      id,
      title,
    });

    if (isSmallScreen) {
      // 📱 移动端：向右滑动打开附件预览（MobileSlidingLayout rightPanel）
      setMobileResourcePanelOpen(true);
    } else {
      setAttachmentPreviewOpen(true);
    }
  }, [isSmallScreen, setAttachmentPreviewOpen, setMobileResourcePanelOpen, setOpenApp]);

  useEventRegistry([
    {
      target: 'window',
      type: 'CHAT_OPEN_ATTACHMENT_PREVIEW',
      listener: handleAttachmentPreview as EventListener,
    },
  ], [handleAttachmentPreview]);

  // 🆕 监听上下文引用预览事件，处理跳转到 Learning Hub
  // ★ 2026-02-09 修复：使用各资源类型的专用导航事件，避免 openResource 处理器竞态
  const handleContextRefPreview = useCallback(async (event: Event) => {
    const customEvent = event as CustomEvent<{
      resourceId: string;
      hash: string;
      typeId: string;
      path?: string;
    }>;

    const { resourceId, typeId } = customEvent.detail;
    console.log('[ChatV2Page] context-ref:preview event received:', customEvent.detail);

    try {
      // 1. 获取资源的真实 sourceId（resourceId 是 chat_v2 的 res_xxx，不是 VFS sourceId）
      const resource = await invoke<{
        id: string;
        sourceId?: string;
        sourceTable?: string;
        resourceType: string;
        metadata?: { title?: string; name?: string };
      } | null>('vfs_get_resource', { resourceId });

      if (!resource) {
        console.warn('[ChatV2Page] Resource not found:', resourceId);
        showGlobalNotification('warning', t('contextRef.previewFailedDesc'), t('contextRef.previewFailedTitle'));
        return;
      }

      const sourceId = resource.sourceId;
      if (!sourceId) {
        console.warn('[ChatV2Page] Resource has no sourceId:', resourceId);
        showGlobalNotification('warning', t('contextRef.previewFailedDesc'), t('contextRef.previewFailedTitle'));
        return;
      }

      const displayName = resource.metadata?.title || resource.metadata?.name || '';
      console.log('[ChatV2Page] Navigating to resource:', { typeId, sourceId, displayName });

      // 2. 统一在右侧面板打开预览（不再跳转离开聊天页面）
      window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
        detail: {
          id: sourceId,
          type: typeId,
          title: displayName || sourceId,
        },
      }));
      console.log('[ChatV2Page] context-ref:preview -> opened in right panel:', { typeId, sourceId });
    } catch (error) {
      console.error('[ChatV2Page] Failed to handle context-ref:preview:', getErrorMessage(error));
      showGlobalNotification('error', getErrorMessage(error), t('contextRef.previewFailedTitle'));
    }
  }, [t]);

  useEventRegistry([
    {
      target: 'document',
      type: 'context-ref:preview',
      listener: handleContextRefPreview as EventListener,
    },
  ], [handleContextRefPreview]);

  // 🆕 监听 PDF 页面引用事件，打开 PDF 并跳转到指定页
  useEffect(() => {
    const isPdfByMeta = (name?: string, mimeType?: string) => {
      const safeName = (name || '').toLowerCase();
      const safeMime = (mimeType || '').toLowerCase();
      return safeMime.includes('pdf') || safeName.endsWith('.pdf');
    };

    const isKnownResourceId = (id?: string) => {
      if (!id) return false;
      return Object.keys(RESOURCE_ID_PREFIX_MAP).some((prefix) => id.startsWith(prefix));
    };

    const shouldDebugPdfRefClick = import.meta.env.DEV && Boolean((window as any).__chatV2DebugPdfRefClick);
    const debugClick = (event: MouseEvent) => {
      const rawTarget = event.target as EventTarget | null;
      const elementTarget = (rawTarget instanceof Element ? rawTarget : null);
      const target = elementTarget?.closest?.('[data-pdf-ref="true"]') as HTMLElement | null;
      if (!target) return;
      console.log('[ChatV2Page] document click pdf-ref:', {
        sourceId: target.dataset.pdfSource,
        pageNumber: target.dataset.pdfPage,
      });
    };
    if (shouldDebugPdfRefClick) {
      document.addEventListener('click', debugClick, true);
    }
    const handlePdfRefOpen = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        sourceId?: string;
        pageNumber: number;
      }>;

      const { sourceId: rawSourceId, pageNumber } = customEvent.detail || {};
      console.log('[ChatV2Page] pdf-ref:open received:', customEvent.detail);
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) return;

      const resolvePdfSourceId = async (requestedSourceId?: string): Promise<string | null> => {
        // 若已是可识别的资源 ID，直接使用（无需额外解析）
        if (requestedSourceId && isKnownResourceId(requestedSourceId)) {
          return requestedSourceId;
        }

        const sessionId = sessionManager.getCurrentSessionId();
        if (!sessionId) {
          console.log('[ChatV2Page] resolvePdfSourceId: no sessionId');
          return null;
        }
        const store = sessionManager.get(sessionId);
        if (!store) {
          console.log('[ChatV2Page] resolvePdfSourceId: no store');
          return null;
        }
        const state = store.getState();

        const candidates: Array<{ sourceId: string; score: number; origin: string }> = [];
        const pushCandidate = (sourceId?: string, score = 0, origin = '') => {
          if (!sourceId) return;
          candidates.push({ sourceId, score, origin });
        };

        // 遍历所有消息，查找 PDF 附件
        for (const messageId of state.messageOrder) {
          const message = state.messageMap.get(messageId);
          if (!message) continue;

          // 1. 先检查 message.attachments（用户上传的附件）
          const attachments = message.attachments || [];
          for (const att of attachments) {
            const name = att.name || '';
            const mimeType = att.mimeType || '';
            const isPdf = isPdfByMeta(name, mimeType);
            if (!isPdf) continue;

            if (requestedSourceId && att.sourceId === requestedSourceId) {
              console.log('[ChatV2Page] resolvePdfSourceId: matched attachment sourceId', att.sourceId);
              return att.sourceId;
            }
            pushCandidate(att.sourceId, 20, 'attachments');
          }

          // 2. 检查 contextSnapshot.userRefs
          const contextSnapshot = message._meta?.contextSnapshot;
          const userRefs = contextSnapshot?.userRefs || [];
          const fileRefs = userRefs.filter((r: any) => r.typeId === 'file');

          for (const ref of fileRefs) {
            // 若引用 id 与请求 id 一致（例如 [PDF@res_xxx]），优先解析
            if (requestedSourceId && ref.resourceId === requestedSourceId) {
              try {
                const resource = await invoke<{
                  id: string;
                  sourceId?: string;
                  resourceType: string;
                  metadata?: { mimeType?: string; name?: string };
                } | null>('vfs_get_resource', { resourceId: ref.resourceId });
                if (resource && isPdfByMeta(resource.metadata?.name, resource.metadata?.mimeType)) {
                  console.log('[ChatV2Page] resolvePdfSourceId: matched userRef resourceId -> sourceId', resource.sourceId);
                  pushCandidate(resource.sourceId, 90, 'userRefs:resourceId');
                }
              } catch {
                // ignore
              }
            }

            try {
              const resource = await invoke<{
                id: string;
                sourceId?: string;
                resourceType: string;
                metadata?: { mimeType?: string; name?: string };
              } | null>('vfs_get_resource', { resourceId: ref.resourceId });
              if (!resource) continue;

              const isPdf = isPdfByMeta(resource.metadata?.name, resource.metadata?.mimeType);
              if (!isPdf) continue;

              if (requestedSourceId && resource.sourceId === requestedSourceId) {
                console.log('[ChatV2Page] resolvePdfSourceId: matched userRef sourceId', resource.sourceId);
                pushCandidate(resource.sourceId, 95, 'userRefs:sourceId');
                continue;
              }

              pushCandidate(resource.sourceId, 10, 'userRefs');
            } catch {
              // ignore
            }
          }
        }

        const sorted = candidates.sort((a, b) => b.score - a.score);
        if (sorted.length > 0) {
          console.log('[ChatV2Page] resolvePdfSourceId: picked candidate', sorted[0]);
          return sorted[0].sourceId;
        }

        console.log('[ChatV2Page] resolvePdfSourceId: no PDF found');
        return null;
      };

      const sourceId = (await resolvePdfSourceId(rawSourceId)) || undefined;
      if (!sourceId) {
        showGlobalNotification(
          'warning',
          t('pdfRef.openFailedTitle'),
          t('pdfRef.openFailedDesc')
        );
        return;
      }

      try {
        const dstuPath = sourceId.startsWith('/') ? sourceId : `/${sourceId}`;
        const isAttachmentLike = sourceId.startsWith('att_') || sourceId.startsWith('file_');

        // 多次派发 focus，兼容面板挂载较慢的情况
        const dispatchFocus = (delayMs: number) => {
          window.setTimeout(() => {
            document.dispatchEvent(new CustomEvent('pdf-ref:focus', {
              detail: {
                sourceId,
                pageNumber,
                path: dstuPath,
              },
            }));
          }, delayMs);
        };

        if (isAttachmentLike) {
          // 走附件预览通道（与"点击附件"一致）
          window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
            detail: {
              id: sourceId,
              type: 'file',
              title: 'PDF',
            },
          }));
          dispatchFocus(0);
          dispatchFocus(250);
          dispatchFocus(800);
          return;
        }

        const navEvent = new CustomEvent('NAVIGATE_TO_VIEW', {
          detail: { view: 'learning-hub', openResource: dstuPath },
        });
        window.dispatchEvent(navEvent);
        console.log('[ChatV2Page] Dispatched NAVIGATE_TO_VIEW to learning-hub (pdf-ref)');
        dispatchFocus(0);
        dispatchFocus(250);
        dispatchFocus(800);
      } catch (error) {
        console.error('[ChatV2Page] Failed to handle pdf-ref:open:', getErrorMessage(error));
        showGlobalNotification('error', getErrorMessage(error), t('pdfRef.openFailedTitle'));
      }
    };

    // TODO: migrate to centralized event registry
    document.addEventListener('pdf-ref:open', handlePdfRefOpen);
    return () => {
      if (shouldDebugPdfRefClick) {
        document.removeEventListener('click', debugClick, true);
      }
      document.removeEventListener('pdf-ref:open', handlePdfRefOpen);
    };
  }, [t]);

  // ========== P1-07: 命令面板 CHAT_* 事件监听 ==========
  // 使用 ref 保存 currentSessionId 以便事件处理器可以访问最新值
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // 获取当前会话 store 的辅助函数
  const getCurrentStore = useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return null;
    return sessionManager.get(sessionId);
  }, []);
  const getCurrentSessionGroupId = useCallback(() => {
    const groupId = getCurrentStore()?.getState().groupId;
    return typeof groupId === 'string' && groupId.trim() ? groupId : undefined;
  }, [getCurrentStore]);

  // 注册命令面板事件监听
  useCommandEvents(
    {
      // 新建会话
      [COMMAND_EVENTS.CHAT_NEW_SESSION]: () => {
        console.log('[ChatV2Page] CHAT_NEW_SESSION triggered');
        // 冷启动早到事件只用于壳层开窗；ready 后由导航握手重放并创建一次。
        if (isInitialLoadingRef.current) return;
        // 事件已被直接消费：清掉握手挂起意图，避免就绪后重复创建
        invalidatePendingChatNavigation();
        createSession(getCurrentSessionGroupId());
      },
      // P1-06: 新建分析会话
      [COMMAND_EVENTS.CHAT_NEW_ANALYSIS_SESSION]: () => {
        console.log('[ChatV2Page] CHAT_NEW_ANALYSIS_SESSION triggered');
        createAnalysisSession();
      },
      // 切换侧边栏
      [COMMAND_EVENTS.CHAT_TOGGLE_SIDEBAR]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_SIDEBAR triggered');
        handleSidebarCollapsedChange(!sidebarCollapsed);
      },
      // 切换功能面板（Learning Hub 侧边栏）
      [COMMAND_EVENTS.CHAT_TOGGLE_PANEL]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_PANEL triggered');
        if (isSmallScreen) {
          // 移动端：打开右侧滑屏资源库
          setMobileResourcePanelOpen(prev => !prev);
          // 打开资源库时关闭左侧栏
          setSessionSheetOpen(false);
        } else {
          toggleCanvasSidebar();
        }
      },
      // 停止生成
      [COMMAND_EVENTS.CHAT_STOP_GENERATION]: () => {
        console.log('[ChatV2Page] CHAT_STOP_GENERATION triggered');
        const store = getCurrentStore();
        if (store) {
          const state = store.getState();
          if (state.canAbort()) {
            state.abortStream().catch(console.error);
          }
        }
      },
      // 切换 RAG 模式
      // 🔧 P0 修复：feature key 与 buildSendOptions 读取端对齐（使用短 key）
      [COMMAND_EVENTS.CHAT_TOGGLE_RAG]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_RAG triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('rag');
        }
      },
      // 切换图谱模式（已废弃，保留命令但使用对齐的 key）
      [COMMAND_EVENTS.CHAT_TOGGLE_GRAPH]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_GRAPH triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('graphRag');
        }
      },
      // 切换联网搜索
      [COMMAND_EVENTS.CHAT_TOGGLE_WEB_SEARCH]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_WEB_SEARCH triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('webSearch');
        }
      },
      // 切换 MCP 工具
      [COMMAND_EVENTS.CHAT_TOGGLE_MCP]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_MCP triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('mcp');
        }
      },
      // 切换学习模式
      [COMMAND_EVENTS.CHAT_TOGGLE_LEARN_MODE]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_LEARN_MODE triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('learnMode');
        }
      },
      // 收藏当前对话
      [COMMAND_EVENTS.CHAT_BOOKMARK_SESSION]: async () => {
        console.log('[ChatV2Page] CHAT_BOOKMARK_SESSION triggered');
        const sessionId = currentSessionIdRef.current;
        if (sessionId) {
          try {
            await invoke('chat_v2_update_session_settings', {
              sessionId,
              settings: { is_favorite: true },
            });
            // 可选：显示成功提示
          } catch (error) {
            console.error('[ChatV2Page] Failed to bookmark session:', getErrorMessage(error));
          }
        }
      },
      // 复制最后一条 AI 回复（幽灵命令补活：chat.copy-last-response）
      [COMMAND_EVENTS.CHAT_COPY_LAST_RESPONSE]: async () => {
        console.log('[ChatV2Page] CHAT_COPY_LAST_RESPONSE triggered');
        const store = getCurrentStore();
        if (!store) return;
        const state = store.getState();
        const lastAssistantId = [...state.messageOrder]
          .reverse()
          .find((id) => state.messageMap.get(id)?.role === 'assistant');
        if (!lastAssistantId) {
          showGlobalNotification('info', t('commands.copyLastEmpty'));
          return;
        }
        // 与消息级复制一致：取显示中的变体块，content 优先、thinking/mcp_tool 兜底
        const blocks = state
          .getDisplayBlockIds(lastAssistantId)
          .map((blockId) => state.blocks.get(blockId))
          .filter((block): block is NonNullable<typeof block> => Boolean(block));
        const text = extractMessageContentFromBlocks(blocks);
        if (!text) {
          showGlobalNotification('info', t('commands.copyLastEmpty'));
          return;
        }
        try {
          await copyTextToClipboard(text);
          showGlobalNotification('success', t('messageItem.actions.copySuccess'));
        } catch (error) {
          console.error('[ChatV2Page] Copy last response failed:', getErrorMessage(error));
          showGlobalNotification('error', t('common:copy_failed'), t('messageItem.actions.copyFailed'));
        }
      },
      // AI 继续（幽灵命令补活：chat.ai-continue）——继续最后一条 AI 回复，
      // 复用消息级 continueMessage（后端同消息继续，失败自动 fallback sendMessage）
      [COMMAND_EVENTS.CHAT_AI_CONTINUE]: async () => {
        console.log('[ChatV2Page] CHAT_AI_CONTINUE triggered');
        const store = getCurrentStore();
        if (!store) return;
        const state = store.getState();
        const isLocked = state.sessionStatus === 'sending'
          || state.sessionStatus === 'streaming'
          || state.sessionStatus === 'aborting'
          || state.activeBlockIds.size > 0;
        if (isLocked) {
          showGlobalNotification('info', t('commands.continueBusy'));
          return;
        }
        const lastAssistantId = [...state.messageOrder]
          .reverse()
          .find((id) => state.messageMap.get(id)?.role === 'assistant');
        if (!lastAssistantId) {
          showGlobalNotification('info', t('commands.continueEmpty'));
          return;
        }
        try {
          await state.continueMessage(lastAssistantId);
        } catch (error) {
          console.error('[ChatV2Page] AI continue failed:', getErrorMessage(error));
          showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.continueFailed'));
        }
      },
    },
    true // 始终启用监听
  );

  // 监听外部预填充输入框事件
  useEffect(() => {
    const handleSetInput = (evt: Event) => {
      const event = evt as CustomEvent<{ content: string; autoSend?: boolean }>;
      const { content } = event?.detail ?? {};
      if (!content) return;

      const store = getCurrentStore();
      if (store) {
        store.getState().setInputValue(content);
        console.log('[ChatV2Page] Input bar content pre-filled');
      }
    };

    // TODO: migrate to centralized event registry
    window.addEventListener('CHAT_V2_SET_INPUT', handleSetInput as EventListener);
    return () => {
      window.removeEventListener('CHAT_V2_SET_INPUT', handleSetInput as EventListener);
    };
  }, [getCurrentStore]);
}
