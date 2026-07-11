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
 * - navigateToNote / navigateToTranslation / navigateToEssay → launch 内容窗
 *
 * 注：AnkiPanelHost（open-anki-panel）已拆除——dispatchOpenAnkiPanelEvent 无业务调用。
 */
import React, { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { workbenchBus } from '../core/workbenchBus';
import { useWindowStore } from '../core/windowStore';
import {
  isNotesWorkspaceResourceType,
  resourceTypeToAppTypeId,
} from '../apps/content/typeMap';
import { requestWorkspaceResource } from '../apps/notes/workspaceRegistry';
import { launchNewChatSession } from '../apps/chat/newSession';
import { CHAT_APP_TYPE_ID } from '../apps/chat/register';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { announceWorkbench } from '../hooks/useWorkbenchA11y';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';

/** 失败路径：assertive 公告（勿仅 console.warn） */
function announceBridgeFailure(message: string): void {
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

function launchResourceWindow(resourceId: string, preferredType?: string, title?: string): void {
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
    reason: 'api',
  });
}

function dispatchPdfFocus(sourceId: string, pageNumber: number): void {
  const fire = () => {
    document.dispatchEvent(
      new CustomEvent('pdf-ref:focus', {
        detail: { sourceId, pageNumber, path: sourceId.startsWith('/') ? sourceId : `/${sourceId}` },
      }),
    );
  };
  fire();
  window.setTimeout(fire, 250);
  window.setTimeout(fire, 800);
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export const WorkbenchEventBridge: React.FC = () => {
  useEffect(() => {
    const onNavigateToSession = (e: Event) => {
      const sessionId = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId) return;
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
          } | null>('vfs_get_resource', { resourceId });
          const sourceId = resource?.sourceId;
          if (!sourceId) {
            console.warn('[workbench] context-ref:preview resource has no sourceId:', resourceId);
            announceBridgeFailure(
              i18n.t('workbench:a11y.previewFailed', {
                defaultValue: '无法打开预览：资源缺少来源',
              }),
            );
            return;
          }
          const title = resource?.metadata?.title || resource?.metadata?.name || sourceId;
          launchResourceWindow(sourceId, typeId, title);
        } catch (error) {
          console.warn('[workbench] context-ref:preview failed:', error);
          announceBridgeFailure(
            i18n.t('workbench:a11y.previewFailed', {
              defaultValue: '无法打开预览',
            }),
          );
        }
      })();
    };

    const onPdfRefOpen = (e: Event) => {
      const { sourceId, pageNumber } = (e as CustomEvent<{ sourceId?: string; pageNumber?: number }>)
        .detail ?? {};
      if (!sourceId || !Number.isFinite(pageNumber) || (pageNumber as number) <= 0) {
        // 无显式 sourceId 的引用需要扫描会话附件（legacy 深度解析），workbench 下暂不支持
        if (!sourceId) {
          console.warn('[workbench] pdf-ref:open without sourceId ignored');
          announceBridgeFailure(
            i18n.t('workbench:a11y.pdfRefOpenFailed', {
              defaultValue: '无法打开 PDF 引用：缺少来源',
            }),
          );
        }
        return;
      }
      launchResourceWindow(sourceId);
      dispatchPdfFocus(sourceId, pageNumber as number);
    };

    const onNavigateToNote = (e: Event) => {
      const noteId = (e as CustomEvent<{ noteId?: string }>).detail?.noteId;
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

    window.addEventListener('navigate-to-session', onNavigateToSession);
    window.addEventListener('CHAT_V2_SET_INPUT', onSetInput);
    window.addEventListener('CHAT_NEW_SESSION', onNewSession);
    window.addEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
    document.addEventListener('context-ref:preview', onContextRefPreview);
    document.addEventListener('pdf-ref:open', onPdfRefOpen);
    window.addEventListener('navigateToNote', onNavigateToNote);
    window.addEventListener('navigateToTranslation', onNavigateToTranslation);
    window.addEventListener('navigateToEssay', onNavigateToEssay);
    return () => {
      window.removeEventListener('navigate-to-session', onNavigateToSession);
      window.removeEventListener('CHAT_V2_SET_INPUT', onSetInput);
      window.removeEventListener('CHAT_NEW_SESSION', onNewSession);
      window.removeEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
      document.removeEventListener('context-ref:preview', onContextRefPreview);
      document.removeEventListener('pdf-ref:open', onPdfRefOpen);
      window.removeEventListener('navigateToNote', onNavigateToNote);
      window.removeEventListener('navigateToTranslation', onNavigateToTranslation);
      window.removeEventListener('navigateToEssay', onNavigateToEssay);
    };
  }, []);

  return null;
};

export default WorkbenchEventBridge;
