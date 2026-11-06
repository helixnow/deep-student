import { useCallback, useEffect } from 'react';
import {
  APP_EVENTS,
  addAppEventListener,
  toAppEventListener,
  useAppEvent,
} from '@/events';
import type { AppEventPayloads } from '@/events/app';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  requestLearningHubIntent,
  type LearningHubIntentType,
} from '@/features/learning-hub/navigation/pendingLearningHubIntent';
import type { SetCurrentView } from '../navigation/viewRouting';

/**
 * App 壳层：把跨模块的「打开某页」事件路由到经典壳视图——Milkdown / Notes 打开、
 * 新建会话 / 分组 / 笔记的桥接、Crepe demo（仅开发模式），以及 openInLearningHub
 * （切到学习资源页并经握手投递打开意图）。从 App.tsx 原样搬出；返回 openInLearningHub。
 */
export function useShellNavigationEvents(setCurrentView: SetCurrentView) {
  // Milkdown / Notes / 新建桥接 / 知识库：壳层导航监听（owner: App）
  useAppEvent(APP_EVENTS.OPEN_MARKDOWN_EDITOR, () => {
    setCurrentView('learning-hub');
  }, [setCurrentView]);

  useAppEvent(APP_EVENTS.OPEN_NOTES, () => {
    if (workbenchBus.isEnabled()) {
      workbenchBus.launch({ typeId: 'notebook', reason: 'api' });
      return;
    }
    setCurrentView('notes');
  }, [setCurrentView]);

  const handleCreateChatSessionBridge = useCallback((detail: { action?: string } | undefined) => {
    if (
      detail?.action &&
      detail.action !== 'create-session' &&
      detail.action !== 'create-group'
    ) {
      return;
    }
    setCurrentView('chat-v2');
  }, [setCurrentView]);

  useEventRegistry([
    {
      target: 'window',
      type: APP_EVENTS.CHAT_NEW_SESSION,
      listener: toAppEventListener(handleCreateChatSessionBridge),
    },
    {
      target: 'window',
      type: APP_EVENTS.MODERN_SIDEBAR_GROUP_ACTION,
      listener: toAppEventListener(handleCreateChatSessionBridge),
    },
    {
      target: 'window',
      type: APP_EVENTS.NOTES_CREATE_NEW,
      listener: () => {
        setCurrentView('learning-hub');
      },
    },
  ], [handleCreateChatSessionBridge, setCurrentView]);

  // Crepe minimal demo：用于排查编辑器性能的纯净示例（仅开发模式）
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openCrepeDemo = () => setCurrentView('crepe-demo');
    const dispose = addAppEventListener(APP_EVENTS.OPEN_CREPE_DEMO, openCrepeDemo);
    (window as unknown as { openCrepeDemo?: () => void }).openCrepeDemo = openCrepeDemo;
    return () => {
      dispose();
      const w = window as unknown as { openCrepeDemo?: () => void };
      if (w.openCrepeDemo === openCrepeDemo) {
        delete w.openCrepeDemo;
      }
    };
  }, [setCurrentView]);

  // ★ OPEN_RF_DEMO 事件已废弃（图谱演示已移除）

  // 顶部安全区功能已移除

  // 跨页「在学习资源中打开 X」：切到学习资源页并经握手投递打开意图。
  // 监听者在 lazy LearningHubPage 内注册，首次进入 / 触屏 LRU 淘汰后重进时页面尚未
  // 挂载，旧的「隔一帧 / 150ms 再派发」会早到即丢；握手挂起意图，页面监听器就位后重放。
  // Workbench 启用时由 WorkbenchEventBridge 开窗，经典学习资源页不挂载，不挂起意图
  // （否则切回经典壳时会重放陈旧意图）。
  const openInLearningHub = useCallback(<K extends LearningHubIntentType>(
    type: K,
    detail: AppEventPayloads[K],
  ) => {
    setCurrentView('learning-hub');
    if (workbenchBus.isEnabled()) return;
    requestLearningHubIntent(type, detail);
  }, [setCurrentView]);

  return { openInLearningHub };
}

/** useShellNavigationEvents 返回的 openInLearningHub 签名 */
export type OpenInLearningHub = ReturnType<typeof useShellNavigationEvents>['openInLearningHub'];
