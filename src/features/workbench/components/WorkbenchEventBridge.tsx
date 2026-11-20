/**
 * WorkbenchEventBridge（P11）— 桌面层一次性事件宿主
 *
 * legacy 下这些全局事件由 ChatV2Page / App.tsx 视图切换链路消费；
 * workbench 模式下本桥负责确保目标应用窗口已打开。Chat 自身的会话切换与
 * 新建逻辑继续由单例窗口内的 ChatV2Page 消费。
 *
 * 覆盖事件：
 * - navigate-to-session      → 打开/聚焦 Chat 单例（ChatV2Page 同时完成会话切换）
 * - CHAT_V2_SET_INPUT        → activate 最近聚焦 chat 窗 setInput（无窗则先建会话）
 * - CHAT_NEW_SESSION         → launchNewChatSession（标题栏新建按钮 / 命令面板）
 * - CHAT_OPEN_ATTACHMENT_PREVIEW → launch 对应资源窗
 * - context-ref:preview      → vfs 解析 sourceId 后走 CHAT_OPEN_ATTACHMENT_PREVIEW
 * - pdf-ref:open             → launch textbook/file 窗 + 延迟派发 pdf-ref:focus
 * - media-ref:open           → launch file 窗 + media-ref:focus 带回执重发（seek + 播放）
 * - navigateToNote / navigateToTranslation / navigateToEssay → launch 内容窗
 * - navigateToExamSheet      → launch 题目集窗
 * - NAVIGATE_TO_VIEW{openResource} → launch 对应资源窗（聊天「在学习中心打开」、导图嵌入、快捷助手资源）
 * - NAVIGATE_TO_VIEW{view=社区插件视图 key} → launch plugin-view.<key> 应用（插件管理 / 工坊卡片「打开」）
 * - OPEN_NOTES               → launch/聚焦笔记工作区
 * - DSTU_NAVIGATE_TO_KNOWLEDGE_BASE → 知识库来源：打开该文档；记忆来源：文件应用 › 记忆视图
 *   （这三类在经典壳由 App 视图切换消费；工作台下无人处理，点击毫无反应）
 *
 * 注：旧版 Anki 面板事件桥接已拆除。
 */
import React, { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { APP_EVENTS, addAppEventListener, type SettingsNavigateTabDetail } from '@/events/app';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { workbenchBus } from '../core/workbenchBus';
import type { LaunchPlacement } from '../core/types';
import { useWindowStore } from '../core/windowStore';
import {
  isNotesWorkspaceResourceType,
  resourceTypeToAppTypeId,
} from '../apps/content/typeMap';
import { requestWorkspaceResource } from '../apps/notes/workspaceRegistry';
import { launchNewChatSession } from '../apps/chat/newSession';
import { CHAT_APP_TYPE_ID } from '../apps/chat/register';
import { resolvePluginViewAppTypeId } from '../apps/plugin-views/register';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { announceWorkbench } from '../hooks/useWorkbenchA11y';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';
import { publishNotesHeadingTarget } from '@/features/notes/headingTargetBridge';
import {
  shouldWorkbenchHandleOpenNote,
  type DstuOpenNoteDetail,
} from '@/features/notes/openNoteEvent';
import {
  MEDIA_REF_OPEN_EVENT,
  requestMediaFocusUntilHandled,
  type MediaRefOpenDetail,
} from '@/features/learning-hub/apps/views/media/mediaRefEvents';

/** 笔记工作区应用 typeId（同 apps/notes/register 的 NOTES_APP_TYPE_ID；不引入该注册模块以免拉起整个工作区依赖）。 */
const NOTES_WORKSPACE_APP_TYPE_ID = 'notes';

/** 失败路径：可见 toast + assertive 公告（勿仅 console.warn） */
function announceBridgeFailure(message: string): void {
  showGlobalNotification('warning', message);
  announceWorkbench(message, 'assertive');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Chat 单例当前选中的业务会话。 */
function findRecentChatSessionId(): string | null {
  const currentSessionId = sessionManager.getCurrentSessionId();
  if (currentSessionId) return currentSessionId;
  const s = useWindowStore.getState();
  for (let i = s.focusStack.length - 1; i >= 0; i--) {
    const win = s.windows[s.focusStack[i]];
    if (win?.typeId === CHAT_APP_TYPE_ID && win.instanceKey) return win.instanceKey;
  }
  const candidates = Object.values(s.windows)
    .filter((w) => w.typeId === CHAT_APP_TYPE_ID && w.instanceKey)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
  return candidates[0]?.instanceKey ?? null;
}

/** 资源 id 前缀 → workbench typeId（未知/附件类回退 'file'） */
function resourceIdToResourceType(resourceId: string): string {
  for (const [prefix, type] of Object.entries(RESOURCE_ID_PREFIX_MAP)) {
    if (resourceId.startsWith(prefix)) {
      return type;
    }
  }
  return 'file';
}

/** 带已知资源前缀（tb_ / file_ / note_ …）的 id；附件 hash 等旧引用不算 */
function isKnownResourceId(id: string): boolean {
  return Object.keys(RESOURCE_ID_PREFIX_MAP).some((prefix) => id.startsWith(prefix));
}

function launchResourceWindow(
  resourceId: string,
  preferredType?: string,
  title?: string,
  placement?: LaunchPlacement,
): void {
  const resourceType = preferredType || resourceIdToResourceType(resourceId);
  const typeId = resourceTypeToAppTypeId(resourceType) ?? 'file';
  const opensInWorkspace = isNotesWorkspaceResourceType(resourceType);
  if (opensInWorkspace) {
    void requestWorkspaceResource({ type: resourceType, id: resourceId });
  }
  workbenchBus.launch({
    typeId,
    instanceKey: opensInWorkspace ? undefined : resourceId,
    payload: opensInWorkspace
      ? { resourceType, resourceId, ...(title ? { title } : {}) }
      : title
        ? { title }
        : undefined,
    ...(placement ? { placement } : {}),
    reason: 'api',
  });
}

/** 引用跳转（L1）：阅读器开在来源窗（点击所在窗口）旁边，不盖住刚点的回答 */
function besidePlacement(sourceWindowId: unknown): LaunchPlacement {
  return {
    mode: 'beside',
    anchorWindowId: typeof sourceWindowId === 'string' && sourceWindowId ? sourceWindowId : null,
  };
}

function dispatchPdfFocus(sourceId: string, pageNumber: number, quote?: string): void {
  const fire = () => {
    document.dispatchEvent(
      new CustomEvent('pdf-ref:focus', {
        detail: { sourceId, pageNumber, quote, path: sourceId.startsWith('/') ? sourceId : `/${sourceId}` },
      }),
    );
  };
  fire();
  window.setTimeout(fire, 250);
  window.setTimeout(fire, 800);
}

/** 与对话页右侧面板同一套重发节奏（features/chat/pages/chatPdfFocus.ts） */
const PDF_FOCUS_RETRY_DELAYS_MS = [0, 250, 800, 1600, 3000, 5000];

/**
 * 带回执重发 pdf-ref:focus，直到有阅读器确认已跳页。
 * 资源窗冷开时监听还没挂上，固定三连发（dispatchPdfFocus）会全部落空、停在第 1 页。
 */
function dispatchPdfFocusUntilHandled(sourceId: string, pageNumber: number, quote?: string): void {
  const path = sourceId.startsWith('/') ? sourceId : `/${sourceId}`;
  let handled = false;
  for (const delay of PDF_FOCUS_RETRY_DELAYS_MS) {
    window.setTimeout(() => {
      if (handled) return;
      document.dispatchEvent(
        new CustomEvent('pdf-ref:focus', {
          detail: {
            sourceId,
            pageNumber,
            quote,
            path,
            acknowledge: (ok: boolean) => {
              if (ok) handled = true;
            },
          },
        }),
      );
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export const WorkbenchEventBridge: React.FC = () => {
  useEffect(() => {
    const onNavigateToSession = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; syncOnly?: boolean }>).detail;
      const sessionId = detail?.sessionId;
      // 仅同步当前会话（如外部引用前确保有活动会话）：不打开 / 聚焦对话窗口
      if (!sessionId || detail?.syncOnly) return;
      workbenchBus.launch({ typeId: CHAT_APP_TYPE_ID, instanceKey: sessionId, reason: 'api' });
    };

    const onSetInput = (e: Event) => {
      const { content } = (e as CustomEvent<{ content?: string }>).detail ?? {};
      if (!content) return;
      const sessionId = findRecentChatSessionId();
      if (sessionId) {
        void workbenchBus.activate({
          typeId: CHAT_APP_TYPE_ID,
          instanceKey: sessionId,
          action: 'setInput',
          payload: { content, focus: true, sessionId },
        });
        return;
      }
      void launchNewChatSession({ reason: 'api' }).then((result) => {
        void workbenchBus.activate({
          typeId: CHAT_APP_TYPE_ID,
          instanceKey: result.sessionId,
          action: 'setInput',
          payload: { content, focus: true, sessionId: result.sessionId },
        });
      });
    };

    const onNewSession = (e: Event) => {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action;
      if (action && action !== 'create-session' && action !== 'create-group') return;
      const existing = Object.values(useWindowStore.getState().windows)
        .find((win) => win.typeId === CHAT_APP_TYPE_ID);
      if (existing) {
        useWindowStore.getState().focusWindow(existing.id);
        return;
      }
      void launchNewChatSession({ reason: 'command' });
    };

    const onAttachmentPreview = (e: Event) => {
      const { id, type, title } = (e as CustomEvent<{ id?: string; type?: string; title?: string }>)
        .detail ?? {};
      if (!id) return;
      launchResourceWindow(id, type, title);
    };

    const onContextRefPreview = (e: Event) => {
      const { resourceId, typeId } = (e as CustomEvent<{ resourceId?: string; typeId?: string }>)
        .detail ?? {};
      if (!resourceId) return;
      void (async () => {
        try {
          // resourceId 是 chat_v2 的 res_xxx，需解析出真实 sourceId（与 legacy 逻辑一致）
          const resource = await invoke<{
            sourceId?: string;
            metadata?: { title?: string; name?: string };
            data?: unknown;
          } | null>('vfs_get_resource', { resourceId });

          // P0 选区即上下文：selection 快照资源没有 sourceId，回链目标在
          // data.source（kind/sourceId/locator/title）。ChatV2Page 也监听同一事件
          // （经典壳路由 + message 滚动定位），本桥负责 workbench 壳开窗：
          // - message：交给 ChatV2Page scrollToMessage，本桥无动作（且不报错）
          // - pdf：launch 对应资源窗 + pdf-ref:focus 三连发跳页
          // - mindmap/note：launch 对应资源窗（与 CHAT_OPEN_ATTACHMENT_PREVIEW
          //   同 instanceKey，重复 launch 退化为聚焦，无害）
          if (typeId === 'selection') {
            let parsed: { source?: { kind?: string; sourceId?: string; locator?: string; title?: string } } | null = null;
            try {
              const raw = resource?.data;
              parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as typeof parsed;
            } catch {
              parsed = null;
            }
            const source = parsed?.source;
            if (!source?.kind || source.kind === 'message') return;
            if (!source.sourceId) return;
            if (source.kind === 'pdf') {
              launchResourceWindow(source.sourceId, undefined, source.title);
              const pageMatch = /^page:(\d+)$/.exec(source.locator ?? '');
              if (pageMatch) dispatchPdfFocus(source.sourceId, Number(pageMatch[1]));
              return;
            }
            if (source.kind === 'mindmap' || source.kind === 'note') {
              launchResourceWindow(source.sourceId, undefined, source.title);
            }
            return;
          }

          const sourceId = resource?.sourceId;
          if (!sourceId) {
            console.warn('[workbench] context-ref:preview resource has no sourceId:', resourceId);
            announceBridgeFailure(
              i18n.t('workbench:a11y.previewFailed'),
            );
            return;
          }
          const title = resource?.metadata?.title || resource?.metadata?.name || sourceId;
          launchResourceWindow(sourceId, typeId, title);
        } catch (error) {
          console.warn('[workbench] context-ref:preview failed:', error);
          announceBridgeFailure(
            i18n.t('workbench:a11y.previewFailed'),
          );
        }
      })();
    };

    const onPdfRefOpen = (e: Event) => {
      const { sourceId, pageNumber, quote, sourceWindowId } = (e as CustomEvent<{
        sourceId?: string;
        pageNumber?: number;
        quote?: string;
        sourceWindowId?: string;
      }>).detail ?? {};
      if (!Number.isFinite(pageNumber) || (pageNumber as number) <= 0) return;
      // 只认带资源 id 前缀的引用（与 useChatPageEvents 的分工对称）：没有 sourceId 或
      // 不是资源 id 的旧引用要扫描会话附件解析，由对话页处理（解析失败它自己提示）。
      // 这里再开一扇 'file' 窗会和对话页的右侧面板各开一份，或开出打不开的窗。
      if (!sourceId || !isKnownResourceId(sourceId)) return;
      launchResourceWindow(sourceId, undefined, undefined, besidePlacement(sourceWindowId));
      // 带回执重发直到阅读器真的跳了页：资源窗冷开要先加载 chunk 与 PDF，常超过 800ms，
      // 固定三连发会全部落空。学习桌面里对话页不再为这类引用另开右侧面板（见
      // useChatPageEvents 的 pdf-ref:open），这扇窗是唯一的阅读器，不能停在第 1 页。
      dispatchPdfFocusUntilHandled(sourceId, pageNumber as number, quote);
    };

    const onMediaRefOpen = (e: Event) => {
      const { resourceId, seconds, sourceWindowId } = (e as CustomEvent<MediaRefOpenDetail>).detail ?? {};
      if (!resourceId || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        return;
      }
      launchResourceWindow(resourceId, 'file', undefined, besidePlacement(sourceWindowId));
      requestMediaFocusUntilHandled({ resourceId, seconds });
    };

    const onNavigateToNote = (e: Event) => {
      const noteId = (e as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (noteId) launchResourceWindow(noteId, 'note');
    };
    const onDstuOpenNote = (e: Event) => {
      const detail = (e as CustomEvent<DstuOpenNoteDetail>).detail;
      if (!shouldWorkbenchHandleOpenNote(detail)) return;
      const noteId = detail?.noteId;
      if (noteId && detail?.heading) {
        publishNotesHeadingTarget({ noteId, heading: detail.heading });
      }
      if (noteId) launchResourceWindow(noteId, 'note');
    };
    const onNavigateToTranslation = (e: Event) => {
      const translationId = (e as CustomEvent<{ translationId?: string }>).detail?.translationId;
      if (translationId) launchResourceWindow(translationId, 'translation');
    };
    const onNavigateToEssay = (e: Event) => {
      const essayId = (e as CustomEvent<{ essayId?: string }>).detail?.essayId;
      if (essayId) launchResourceWindow(essayId, 'essay');
    };

    const onNavigateToExamSheet = (e: Event) => {
      const sessionId = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sessionId) launchResourceWindow(sessionId, 'exam');
    };

    const onNavigateToView = (e: Event) => {
      const detail = (e as CustomEvent<{ view?: string; openResource?: string }>).detail;
      const openResource = detail?.openResource;
      if (typeof openResource !== 'string' || !openResource.trim()) {
        if (detail?.view === 'settings') {
          workbenchBus.launch({ typeId: 'settings', reason: 'api' });
          return;
        }
        // 社区插件视图（ctx.ui.navigate / kernel.navigation.navigate(viewKey)）→ 对应插件应用窗口
        const pluginAppTypeId = resolvePluginViewAppTypeId(detail?.view);
        if (pluginAppTypeId) workbenchBus.launch({ typeId: pluginAppTypeId, reason: 'api' });
        return;
      }
      const resourceId = openResource.trim().replace(/^\/+/, '');
      if (resourceId) launchResourceWindow(resourceId);
    };

    // 设置直达事件（欢迎引导、维护模式横幅、模型就绪提示、快捷键 ⌘, 等）：
    // 先写入 pendingSettingsRoute 供设置窗冷挂载消费，再确保设置单例窗打开/聚焦。
    const onSettingsNavigateTab = (detail: SettingsNavigateTabDetail) => {
      if (detail?.tab) {
        setPendingSettingsRoute({
          tab: detail.tab,
          ...(detail.dataGovernanceTab ? { dataGovernanceTab: detail.dataGovernanceTab } : {}),
        });
      }
      workbenchBus.launch({ typeId: 'settings', reason: 'api' });
    };

    const onNavigateToTab = (detail: { tabName?: string }) => {
      const tabName = detail?.tabName;
      if (tabName === 'settings') {
        workbenchBus.launch({ typeId: 'settings', reason: 'api' });
      }
    };

    // PWA 主屏快捷入口（/?shortcut=chat|library|review）在学习桌面启动时直接打开对应应用
    try {
      const params = new URLSearchParams(window.location.search);
      const shortcut = params.get('shortcut');
      if (shortcut === 'chat' || shortcut === 'library' || shortcut === 'review') {
        const typeId = shortcut === 'chat' ? 'chat' : shortcut === 'library' ? 'files' : 'flashcards';
        workbenchBus.launch({ typeId, reason: 'api' });
        params.delete('shortcut');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
        window.history.replaceState(window.history.state, '', nextUrl);
      }
    } catch {
      /* 忽略受限 URL 环境 */
    }

    // OPEN_NOTES（如插件卡片「去笔记里试试」）：经典壳切到资源库，学习桌面打开/聚焦笔记工作区
    const onOpenNotes = () => {
      workbenchBus.launch({ typeId: NOTES_WORKSPACE_APP_TYPE_ID, reason: 'api' });
    };

    const onNavigateToKnowledgeBase = (e: Event) => {
      const detail = (e as CustomEvent<{
        preferTab?: string;
        locator?: { sourceId?: string; resourceId?: string; resourceType?: string; title?: string };
      }>).detail ?? {};
      if (detail.preferTab === 'memory') {
        // 记忆定位 id 已由派发方写入 pendingMemoryLocate，记忆视图挂载后消费
        void workbenchBus.activate({
          typeId: 'files',
          instanceKey: '',
          action: 'openQuickAccess',
          payload: { type: 'memory' },
          fallbackLaunch: { typeId: 'files', reason: 'api' },
        });
        return;
      }
      const id = detail.locator?.sourceId || detail.locator?.resourceId;
      if (id) {
        launchResourceWindow(id, detail.locator?.resourceType, detail.locator?.title);
        return;
      }
      announceBridgeFailure(i18n.t('workbench:bridge.knowledgeLocateFailed', { defaultValue: '无法定位该知识来源' }));
    };

    window.addEventListener('navigate-to-session', onNavigateToSession);
    window.addEventListener('CHAT_V2_SET_INPUT', onSetInput);
    window.addEventListener('CHAT_NEW_SESSION', onNewSession);
    window.addEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
    document.addEventListener('context-ref:preview', onContextRefPreview);
    document.addEventListener('pdf-ref:open', onPdfRefOpen);
    document.addEventListener(MEDIA_REF_OPEN_EVENT, onMediaRefOpen);
    window.addEventListener('navigateToNote', onNavigateToNote);
    window.addEventListener('DSTU_OPEN_NOTE', onDstuOpenNote);
    window.addEventListener('navigateToTranslation', onNavigateToTranslation);
    window.addEventListener('navigateToEssay', onNavigateToEssay);
    window.addEventListener('navigateToExamSheet', onNavigateToExamSheet);
    window.addEventListener('NAVIGATE_TO_VIEW', onNavigateToView);
    const disposeSettingsNavigateTab = addAppEventListener(APP_EVENTS.SETTINGS_NAVIGATE_TAB, onSettingsNavigateTab);
    const disposeNavigateToTab = addAppEventListener(APP_EVENTS.NAVIGATE_TO_TAB, onNavigateToTab);
    const disposeOpenNotes = addAppEventListener(APP_EVENTS.OPEN_NOTES, onOpenNotes);
    window.addEventListener('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', onNavigateToKnowledgeBase);
    return () => {
      window.removeEventListener('navigate-to-session', onNavigateToSession);
      window.removeEventListener('CHAT_V2_SET_INPUT', onSetInput);
      window.removeEventListener('CHAT_NEW_SESSION', onNewSession);
      window.removeEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
      document.removeEventListener('context-ref:preview', onContextRefPreview);
      document.removeEventListener('pdf-ref:open', onPdfRefOpen);
      document.removeEventListener(MEDIA_REF_OPEN_EVENT, onMediaRefOpen);
      window.removeEventListener('navigateToNote', onNavigateToNote);
      window.removeEventListener('DSTU_OPEN_NOTE', onDstuOpenNote);
      window.removeEventListener('navigateToTranslation', onNavigateToTranslation);
      window.removeEventListener('navigateToEssay', onNavigateToEssay);
      window.removeEventListener('navigateToExamSheet', onNavigateToExamSheet);
      window.removeEventListener('NAVIGATE_TO_VIEW', onNavigateToView);
      disposeSettingsNavigateTab();
      disposeNavigateToTab();
      disposeOpenNotes();
      window.removeEventListener('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', onNavigateToKnowledgeBase);
    };
  }, []);

  return null;
};

export default WorkbenchEventBridge;
