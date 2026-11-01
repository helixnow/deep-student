import { useCallback } from 'react';
import { APP_EVENTS, dispatchAppEvent, toAppEventListener } from '@/events';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useViewStore } from '@/stores/viewStore';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  resolveClassicShellOpenNoteTarget,
  type DstuOpenNoteDetail,
} from '@/features/notes/openNoteEvent';
import { publishNotesHeadingTarget } from '@/features/notes/headingTargetBridge';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type { SetCurrentView } from '../navigation/viewRouting';
import type { OpenInLearningHub } from './useShellNavigationEvents';

/**
 * App 壳层：跨功能交接。试卷 / 翻译 / 作文 / 笔记的「打开」事件经 openInLearningHub
 * 投递到学习资源页；经典壳的 DSTU_OPEN_NOTE 宿主；PREFILL_CHAT_INPUT 切到聊天并（可选
 * 新会话就绪后）填入输入框。从 App.tsx 原样搬出。
 */
export function useCrossFeatureHandoffs(openInLearningHub: OpenInLearningHub, setCurrentView: SetCurrentView) {
  // 其他页面导航事件监听（typed registry + useEventRegistry lifecycle）
  const handleNavigateToExamSheet = useCallback((detail: {
    sessionId: string;
    cardId?: string;
    mistakeId?: string;
  }) => {
    const sessionId = detail?.sessionId;
    if (!sessionId) return;

    openInLearningHub(APP_EVENTS.LEARNING_HUB_OPEN_EXAM, {
      sessionId,
      cardId: detail?.cardId ?? null,
      mistakeId: detail?.mistakeId ?? null,
    });
  }, [openInLearningHub]);

  const handleNavigateToTranslation = useCallback((detail: {
    translationId: string;
    title?: string;
  }) => {
    const translationId = detail?.translationId;
    if (!translationId) return;

    openInLearningHub(APP_EVENTS.LEARNING_HUB_OPEN_TRANSLATION, {
      translationId,
      title: detail?.title,
    });
  }, [openInLearningHub]);

  const handleNavigateToEssay = useCallback((detail: {
    essayId: string;
    title?: string;
  }) => {
    const essayId = detail?.essayId;
    if (!essayId) return;

    openInLearningHub(APP_EVENTS.LEARNING_HUB_OPEN_ESSAY, {
      essayId,
      title: detail?.title,
    });
  }, [openInLearningHub]);

  const handleNavigateToNote = useCallback((detail: {
    noteId: string;
    source?: string;
  }) => {
    const noteId = detail?.noteId;
    if (!noteId) return;

    openInLearningHub(APP_EVENTS.LEARNING_HUB_OPEN_NOTE, {
      noteId,
      source: detail?.source,
    });
  }, [openInLearningHub]);

  // 经典壳的 DSTU_OPEN_NOTE 宿主（Android/iOS 恒为经典壳）。WorkbenchEventBridge 只挂在
  // WorkbenchDesktop 内：此前经典壳里 wikilink / @mention / note:// 链接点了没反应，
  // 块链接跳转（source 'notes-editor'）空等 15s 超时；聊天页不可见时 Chat 自有事件
  // 开进隐藏画布同样无效。落点规则见 resolveClassicShellOpenNoteTarget。
  const handleClassicShellOpenNote = useCallback((event: Event) => {
    if (workbenchBus.isEnabled()) return;
    const detail = (event as CustomEvent<DstuOpenNoteDetail>).detail;
    const target = resolveClassicShellOpenNoteTarget(detail, useViewStore.getState().currentView);
    if (target !== 'learning-hub') return;
    if (detail.heading) {
      publishNotesHeadingTarget({ noteId: detail.noteId, heading: detail.heading });
    }
    handleNavigateToNote({ noteId: detail.noteId, source: detail.source });
  }, [handleNavigateToNote]);

  const handlePrefillChatInput = useCallback((detail: {
    content: string;
    autoSend?: boolean;
    newSession?: boolean;
  }) => {
    const { content, autoSend, newSession } = detail ?? {};
    if (!content) return;

    setCurrentView('chat-v2');
    if (!newSession) {
      setTimeout(() => {
        dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, { content, autoSend });
      }, 150);
      return;
    }
    // 新会话就绪（current-session-changed）后再填入；3s 兜底，避免填进旧会话或丢失
    const previousSessionId = sessionManager.getCurrentSessionId();
    let done = false;
    const fill = () => {
      if (done) return;
      done = true;
      unsubscribe();
      window.clearTimeout(fallbackTimer);
      setTimeout(() => dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, { content, autoSend }), 150);
    };
    const unsubscribe = sessionManager.subscribe((event) => {
      if (event.type === 'current-session-changed' && event.sessionId && event.sessionId !== previousSessionId) fill();
    });
    const fallbackTimer = window.setTimeout(fill, 3000);
    requestAnimationFrame(() => dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION));
  }, [setCurrentView]);

  // ★ irec 相关事件监听已废弃（图谱模块已移除）
  // ★ navigateToMistakeById 事件监听已废弃（2026-01 清理）
  useEventRegistry([
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_EXAM_SHEET, listener: toAppEventListener(handleNavigateToExamSheet) },
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_TRANSLATION, listener: toAppEventListener(handleNavigateToTranslation) },
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_ESSAY, listener: toAppEventListener(handleNavigateToEssay) },
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_NOTE, listener: toAppEventListener(handleNavigateToNote) },
    { target: 'window', type: 'DSTU_OPEN_NOTE', listener: handleClassicShellOpenNote },
    { target: 'window', type: APP_EVENTS.PREFILL_CHAT_INPUT, listener: toAppEventListener(handlePrefillChatInput) },
  ], [handleNavigateToExamSheet, handleNavigateToTranslation, handleNavigateToEssay, handleNavigateToNote, handleClassicShellOpenNote, handlePrefillChatInput]);
}
