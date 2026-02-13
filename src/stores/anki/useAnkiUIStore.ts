/**
 * Anki UI Store
 * 
 * 管理 Anki 制卡模块的 UI 状态。
 * 
 * 设计原则：
 * 1. Store 只管 UI 状态，业务逻辑保持在 ankiWorkflowManager
 * 2. 使用切片模式分离不同功能域
 * 3. 支持细粒度订阅，避免不必要的 re-render
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  AnkiUIStore,
  AnkiUIStoreState,
  DocumentTaskUI,
  DialogsState,
  PanelsState,
  MistakeSummary,
} from './types';
import {
  createInitialState,
  DEFAULT_GENERATION_OPTIONS,
} from './types';
import type {
  AnkiCard,
  AnkiGenerationOptions,
  CustomAnkiTemplate,
} from '../../types';
import { t } from '../../utils/i18n';

/**
 * 创建 Anki UI Store
 */
export const useAnkiUIStore = create<AnkiUIStore>()(
  subscribeWithSelector((set, get) => ({
    // ========================================================================
    // Initial State
    // ========================================================================
    ...createInitialState(),

    // ========================================================================
    // Document Slice Actions
    // ========================================================================
    setDocumentContent: (content: string) => {
      set({ documentContent: content });
    },

    setCurrentDocumentId: (id: string | null) => {
      set({ currentDocumentId: id });
    },

    appendDocumentContent: (content: string, separator = '\n\n---\n\n') => {
      set((state) => {
        const current = state.documentContent.trim();
        if (!current) {
          return { documentContent: content };
        }
        return { documentContent: `${current}${separator}${content}` };
      });
    },

    setSelectedFiles: (files: File[]) => {
      set({ selectedFiles: files });
    },

    setIsProcessingFiles: (value: boolean) => {
      set({ isProcessingFiles: value });
    },

    clearDocument: () => {
      set({
        documentContent: '',
        currentDocumentId: null,
        selectedFiles: [],
      });
    },

    loadMaterialToDocument: (content: string, sourceId: string | null) => {
      set({
        documentContent: content,
        currentDocumentId: sourceId,
      });
    },

    // ========================================================================
    // Template Slice Actions
    // ========================================================================
    setSelectedTemplateId: (id: string | null) => {
      set({ selectedTemplateId: id });
    },

    setAllTemplates: (templates: CustomAnkiTemplate[]) => {
      set({ allTemplates: templates });
    },

    setIsLoadingTemplates: (value: boolean) => {
      set({ isLoadingTemplates: value });
    },

    setShowTemplatePicker: (value: boolean) => {
      set({ showTemplatePicker: value });
    },

    setShowTemplateManager: (value: boolean) => {
      set({ showTemplateManager: value });
    },

    getSelectedTemplate: () => {
      const state = get();
      if (!state.selectedTemplateId) return null;
      return state.allTemplates.find(t => t.id === state.selectedTemplateId) || null;
    },

    // ========================================================================
    // Cards Slice Actions
    // ========================================================================
    setGeneratedCards: (cards: AnkiCard[]) => {
      set({ generatedCards: cards });
    },

    addGeneratedCard: (card: AnkiCard) => {
      set((state) => ({
        generatedCards: [...state.generatedCards, card],
      }));
    },

    updateGeneratedCard: (cardId: string, updates: Partial<AnkiCard>) => {
      set((state) => ({
        generatedCards: state.generatedCards.map((card) =>
          card.id === cardId ? { ...card, ...updates } : card
        ),
      }));
    },

    removeGeneratedCard: (cardId: string) => {
      set((state) => ({
        generatedCards: state.generatedCards.filter((card) => card.id !== cardId),
        selectedCardIds: (() => {
          const next = new Set(state.selectedCardIds);
          next.delete(cardId);
          return next;
        })(),
      }));
    },

    clearGeneratedCards: () => {
      set({
        generatedCards: [],
        selectedCardIds: new Set(),
        documentTasks: [],
        selectedTaskId: null,
      });
    },

    setDocumentTasks: (tasks: DocumentTaskUI[]) => {
      set({ documentTasks: tasks });
    },

    updateDocumentTask: (taskId: string, updates: Partial<DocumentTaskUI>) => {
      set((state) => ({
        documentTasks: state.documentTasks.map((task) =>
          task.task_id === taskId ? { ...task, ...updates } : task
        ),
      }));
    },

    setSelectedTaskId: (id: string | null) => {
      set({ selectedTaskId: id });
    },

    setSelectedCardIds: (ids: Set<string>) => {
      set({ selectedCardIds: ids });
    },

    toggleCardSelection: (cardId: string) => {
      set((state) => {
        const next = new Set(state.selectedCardIds);
        if (next.has(cardId)) {
          next.delete(cardId);
        } else {
          next.add(cardId);
        }
        return { selectedCardIds: next };
      });
    },

    selectAllCards: () => {
      set((state) => ({
        selectedCardIds: new Set(
          state.generatedCards
            .filter((c) => c.id)
            .map((c) => c.id as string)
        ),
      }));
    },

    clearCardSelection: () => {
      set({ selectedCardIds: new Set() });
    },

    setIsGenerating: (value: boolean) => {
      set({ isGenerating: value });
    },

    setIsPaused: (value: boolean) => {
      set({ isPaused: value });
    },

    setGenerationError: (error: string | null) => {
      set({ generationError: error });
    },

    // ========================================================================
    // AnkiConnect Slice Actions
    // ========================================================================
    setIsAnkiConnectAvailable: (value: boolean) => {
      set({ isAnkiConnectAvailable: value });
    },

    setAnkiDeckNames: (names: string[]) => {
      set({ ankiDeckNames: names });
    },

    setAnkiModelNames: (names: string[]) => {
      set({ ankiModelNames: names });
    },

    setConnectionError: (error: string | null) => {
      set({ connectionError: error });
    },

    setIsCheckingConnection: (value: boolean) => {
      set({ isCheckingConnection: value });
    },

    setShowSettingsPanel: (value: boolean) => {
      set({ showSettingsPanel: value });
    },

    updateConnectionStatus: (available: boolean, decks?: string[], models?: string[]) => {
      set({
        isAnkiConnectAvailable: available,
        connectionError: available ? null : t('messages.error.anki_connect_unavailable'),
        ...(decks !== undefined && { ankiDeckNames: decks }),
        ...(models !== undefined && { ankiModelNames: models }),
      });
    },

    // ========================================================================
    // Import Slice Actions
    // ========================================================================
    setMistakeSummaries: (summaries: MistakeSummary[]) => {
      set({ mistakeSummaries: summaries });
    },

    setMistakeSearchTerm: (term: string) => {
      set({ mistakeSearchTerm: term });
    },

    setSelectedMistakeIds: (ids: Set<string>) => {
      set({ selectedMistakeIds: ids });
    },

    toggleMistakeSelection: (id: string) => {
      set((state) => {
        const next = new Set(state.selectedMistakeIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return { selectedMistakeIds: next };
      });
    },

    selectAllMistakes: () => {
      set((state) => ({
        selectedMistakeIds: new Set(state.mistakeSummaries.map((m) => m.id)),
      }));
    },

    clearMistakeSelection: () => {
      set({ selectedMistakeIds: new Set() });
    },

    setIsLoadingMistakes: (value: boolean) => {
      set({ isLoadingMistakes: value });
    },

    setIsApplyingMistakeImport: (value: boolean) => {
      set({ isApplyingMistakeImport: value });
    },

    setShowMistakeImportDialog: (value: boolean) => {
      set({ showMistakeImportDialog: value });
    },

    // ========================================================================
    // UI Slice Actions
    // ========================================================================
    setDialogOpen: (dialog: keyof DialogsState, open: boolean) => {
      set((state) => ({
        dialogs: { ...state.dialogs, [dialog]: open },
      }));
    },

    setPanelOpen: (panel: keyof PanelsState, open: boolean) => {
      set((state) => ({
        panels: { ...state.panels, [panel]: open },
      }));
    },

    setActiveTab: (tab: string) => {
      set({ activeTab: tab });
    },

    setError: (error: string | null) => {
      set({ error });
    },

    setIsBatchMode: (value: boolean) => {
      set({ isBatchMode: value });
    },

    setPreviewingCard: (card: AnkiCard | null) => {
      set({ previewingCard: card });
    },

    setCardViewMode: (mode: 'grid' | 'table') => {
      set({ cardViewMode: mode });
    },

    setSelectedQueueIds: (ids: Set<string>) => {
      set({ selectedQueueIds: ids });
    },

    toggleQueueSelection: (id: string) => {
      set((state) => {
        const next = new Set(state.selectedQueueIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return { selectedQueueIds: next };
      });
    },

    clearQueueSelection: () => {
      set({ selectedQueueIds: new Set() });
    },

    resetUI: () => {
      const initial = createInitialState();
      set({
        dialogs: initial.dialogs,
        panels: initial.panels,
        activeTab: initial.activeTab,
        error: null,
        isBatchMode: false,
        previewingCard: null,
        selectedQueueIds: new Set(),
      });
    },

    // ========================================================================
    // Options Slice Actions
    // ========================================================================
    setOptions: (options: AnkiGenerationOptions) => {
      set({ options });
    },

    updateOption: <K extends keyof AnkiGenerationOptions>(
      key: K,
      value: AnkiGenerationOptions[K]
    ) => {
      set((state) => ({
        options: { ...state.options, [key]: value },
      }));
    },

    resetOptions: () => {
      set({ options: { ...DEFAULT_GENERATION_OPTIONS } });
    },
  }))
);

// ============================================================================
// Selector Hooks（细粒度订阅）
// ============================================================================

/**
 * 订阅文档状态
 */
export const useDocumentState = () =>
  useAnkiUIStore(useShallow((state) => ({
    documentContent: state.documentContent,
    currentDocumentId: state.currentDocumentId,
    isProcessingFiles: state.isProcessingFiles,
  })));

/**
 * 订阅模板状态
 */
export const useTemplateState = () =>
  useAnkiUIStore(useShallow((state) => ({
    selectedTemplateId: state.selectedTemplateId,
    allTemplates: state.allTemplates,
    isLoadingTemplates: state.isLoadingTemplates,
  })));

/**
 * 订阅卡片生成状态
 */
export const useCardsState = () =>
  useAnkiUIStore(useShallow((state) => ({
    generatedCards: state.generatedCards,
    documentTasks: state.documentTasks,
    isGenerating: state.isGenerating,
    isPaused: state.isPaused,
    generationError: state.generationError,
  })));

/**
 * 订阅 AnkiConnect 状态
 */
export const useAnkiConnectState = () =>
  useAnkiUIStore(useShallow((state) => ({
    isAnkiConnectAvailable: state.isAnkiConnectAvailable,
    ankiDeckNames: state.ankiDeckNames,
    ankiModelNames: state.ankiModelNames,
    connectionError: state.connectionError,
  })));

/**
 * 订阅生成选项
 */
export const useGenerationOptions = () =>
  useAnkiUIStore((state) => state.options);

/**
 * 获取 Store Actions（不触发订阅）
 */
export const getAnkiUIStoreActions = () => {
  const state = useAnkiUIStore.getState();
  // 返回所有 action 函数
  return {
    // Document
    setDocumentContent: state.setDocumentContent,
    setCurrentDocumentId: state.setCurrentDocumentId,
    appendDocumentContent: state.appendDocumentContent,
    clearDocument: state.clearDocument,
    loadMaterialToDocument: state.loadMaterialToDocument,
    // Template
    setSelectedTemplateId: state.setSelectedTemplateId,
    setAllTemplates: state.setAllTemplates,
    setIsLoadingTemplates: state.setIsLoadingTemplates,
    getSelectedTemplate: state.getSelectedTemplate,
    // Cards
    setGeneratedCards: state.setGeneratedCards,
    addGeneratedCard: state.addGeneratedCard,
    updateGeneratedCard: state.updateGeneratedCard,
    removeGeneratedCard: state.removeGeneratedCard,
    clearGeneratedCards: state.clearGeneratedCards,
    setDocumentTasks: state.setDocumentTasks,
    updateDocumentTask: state.updateDocumentTask,
    setIsGenerating: state.setIsGenerating,
    setIsPaused: state.setIsPaused,
    setGenerationError: state.setGenerationError,
    // AnkiConnect
    updateConnectionStatus: state.updateConnectionStatus,
    // UI
    setDialogOpen: state.setDialogOpen,
    setPanelOpen: state.setPanelOpen,
    setError: state.setError,
    resetUI: state.resetUI,
    // Options
    setOptions: state.setOptions,
    updateOption: state.updateOption,
    resetOptions: state.resetOptions,
  };
};
