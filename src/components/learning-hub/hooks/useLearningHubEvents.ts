/**
 * Learning Hub 事件监听统一 Hook
 *
 * 将多个独立的 window 事件监听合并到一个统一的 hook 中，
 * 简化 LearningHubPage 的代码结构并确保正确清理。
 *
 * 支持的事件：
 * - learningHubOpenExam: 从 App.tsx 打开题目集
 * - learningHubOpenTranslation: 从 App.tsx 打开翻译
 * - learningHubOpenEssay: 从 App.tsx 打开作文
 * - learningHubOpenNote: 从 ChatV2Page 打开笔记
 * - learningHubOpenResource: 通用资源打开（如思维导图）
 * - LEARNING_OPEN_TRANSLATE / LEARNING_OPEN_ESSAY_GRADING: 命令面板事件
 * - learningHubNavigateToKnowledge: 知识库导航
 */

import { useEffect, useRef } from 'react';

// ============================================================================
// 事件数据类型定义
// ============================================================================

/** learningHubOpenExam 事件数据 */
export interface OpenExamEventDetail {
  sessionId: string;
  cardId?: string | null;
  mistakeId?: string | null;
}

/** learningHubOpenTranslation 事件数据 */
export interface OpenTranslationEventDetail {
  translationId: string;
  title?: string;
}

/** learningHubOpenEssay 事件数据 */
export interface OpenEssayEventDetail {
  essayId: string;
  title?: string;
}

/** learningHubOpenNote 事件数据 */
export interface OpenNoteEventDetail {
  noteId: string;
  source?: string;
}

/** learningHubOpenResource 事件数据 */
export interface OpenResourceEventDetail {
  dstuPath: string;
}

/** learningHubNavigateToKnowledge 事件数据 */
export interface NavigateToKnowledgeEventDetail {
  preferTab?: string;
  documentId?: string;
  fileName?: string;
  resourceType?: string;
  memoryId?: string;
}

// ============================================================================
// Hook 参数类型
// ============================================================================

export interface LearningHubEventHandlers {
  /** 处理打开题目集事件 */
  onOpenExam?: (detail: OpenExamEventDetail) => void;
  /** 处理打开翻译事件 */
  onOpenTranslation?: (detail: OpenTranslationEventDetail) => void;
  /** 处理打开作文事件 */
  onOpenEssay?: (detail: OpenEssayEventDetail) => void;
  /** 处理打开笔记事件 */
  onOpenNote?: (detail: OpenNoteEventDetail) => void;
  /** 处理打开通用资源事件 */
  onOpenResource?: (detail: OpenResourceEventDetail) => void;
  /** 处理命令面板打开翻译事件 */
  onCommandOpenTranslate?: () => void;
  /** 处理命令面板打开作文批改事件 */
  onCommandOpenEssayGrading?: () => void;
  /** 处理知识库导航事件 */
  onNavigateToKnowledge?: (detail: NavigateToKnowledgeEventDetail) => void;
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * Learning Hub 事件监听统一 Hook
 *
 * @param handlers - 各事件的处理函数
 *
 * @example
 * ```tsx
 * useLearningHubEvents({
 *   onOpenExam: (detail) => {
 *     setOpenApp({ type: 'exam', id: detail.sessionId, ... });
 *   },
 *   onOpenTranslation: (detail) => {
 *     setOpenApp({ type: 'translation', id: detail.translationId, ... });
 *   },
 *   // ... 其他处理函数
 * });
 * ```
 */
export function useLearningHubEvents(handlers: LearningHubEventHandlers): void {
  // 使用 ref 存储处理函数，避免每次 handlers 变化都重新注册事件
  const handlersRef = useRef(handlers);

  // 每次渲染时更新 ref，确保处理函数始终是最新的
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    // ========== learningHubOpenExam ==========
    const handleOpenExam = (evt: Event) => {
      const detail = (evt as CustomEvent<OpenExamEventDetail>).detail;
      handlersRef.current.onOpenExam?.(detail);
    };

    // ========== learningHubOpenTranslation ==========
    const handleOpenTranslation = (evt: Event) => {
      const detail = (evt as CustomEvent<OpenTranslationEventDetail>).detail;
      handlersRef.current.onOpenTranslation?.(detail);
    };

    // ========== learningHubOpenEssay ==========
    const handleOpenEssay = (evt: Event) => {
      const detail = (evt as CustomEvent<OpenEssayEventDetail>).detail;
      handlersRef.current.onOpenEssay?.(detail);
    };

    // ========== learningHubOpenNote ==========
    const handleOpenNote = (evt: Event) => {
      const detail = (evt as CustomEvent<OpenNoteEventDetail>).detail;
      handlersRef.current.onOpenNote?.(detail);
    };

    // ========== learningHubOpenResource ==========
    const handleOpenResource = (evt: Event) => {
      const detail = (evt as CustomEvent<OpenResourceEventDetail>).detail;
      handlersRef.current.onOpenResource?.(detail);
    };

    // ========== LEARNING_OPEN_TRANSLATE ==========
    const handleCommandOpenTranslate = () => {
      handlersRef.current.onCommandOpenTranslate?.();
    };

    // ========== LEARNING_OPEN_ESSAY_GRADING ==========
    const handleCommandOpenEssayGrading = () => {
      handlersRef.current.onCommandOpenEssayGrading?.();
    };

    // ========== learningHubNavigateToKnowledge ==========
    const handleNavigateToKnowledge = (evt: Event) => {
      const detail = (evt as CustomEvent<NavigateToKnowledgeEventDetail>).detail;
      handlersRef.current.onNavigateToKnowledge?.(detail);
    };

    // 统一注册所有事件监听器
    window.addEventListener('learningHubOpenExam', handleOpenExam);
    window.addEventListener('learningHubOpenTranslation', handleOpenTranslation);
    window.addEventListener('learningHubOpenEssay', handleOpenEssay);
    window.addEventListener('learningHubOpenNote', handleOpenNote);
    window.addEventListener('learningHubOpenResource', handleOpenResource);
    window.addEventListener('LEARNING_OPEN_TRANSLATE', handleCommandOpenTranslate);
    window.addEventListener('LEARNING_OPEN_ESSAY_GRADING', handleCommandOpenEssayGrading);
    window.addEventListener('learningHubNavigateToKnowledge', handleNavigateToKnowledge);

    // 统一清理所有事件监听器
    return () => {
      window.removeEventListener('learningHubOpenExam', handleOpenExam);
      window.removeEventListener('learningHubOpenTranslation', handleOpenTranslation);
      window.removeEventListener('learningHubOpenEssay', handleOpenEssay);
      window.removeEventListener('learningHubOpenNote', handleOpenNote);
      window.removeEventListener('learningHubOpenResource', handleOpenResource);
      window.removeEventListener('LEARNING_OPEN_TRANSLATE', handleCommandOpenTranslate);
      window.removeEventListener('LEARNING_OPEN_ESSAY_GRADING', handleCommandOpenEssayGrading);
      window.removeEventListener('learningHubNavigateToKnowledge', handleNavigateToKnowledge);
    };
  }, []); // 空依赖数组 - 只在挂载时注册，卸载时清理
}
