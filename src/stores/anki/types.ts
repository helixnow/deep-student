/**
 * Anki UI Store 类型定义
 * 
 * 此文件定义 AnkiUIStore 使用的所有类型。
 * 业务逻辑类型（如 AnkiCard, CustomAnkiTemplate）从 src/types 导入。
 * 
 * 设计原则：
 * - Store 只管 UI 状态，业务逻辑保持在 ankiWorkflowManager
 * - 使用切片模式（Slice Pattern）分离不同功能域的状态
 */

import type {
  AnkiCard,
  AnkiGenerationOptions,
  CustomAnkiTemplate,
  AnkiCardTemplate,
  MistakeItem,
} from '../../types';

// ============================================================================
// Document Slice Types
// ============================================================================

/**
 * 文档处理状态
 */
export interface DocumentSliceState {
  /** 当前文档内容 */
  documentContent: string;
  /** 当前文档 ID（来源追踪） */
  currentDocumentId: string | null;
  /** 已选择的文件列表 */
  selectedFiles: File[];
  /** 是否正在处理文件 */
  isProcessingFiles: boolean;
}

export interface DocumentSliceActions {
  setDocumentContent: (content: string) => void;
  setCurrentDocumentId: (id: string | null) => void;
  appendDocumentContent: (content: string, separator?: string) => void;
  setSelectedFiles: (files: File[]) => void;
  setIsProcessingFiles: (value: boolean) => void;
  clearDocument: () => void;
  /** 复合操作：加载素材到文档 */
  loadMaterialToDocument: (content: string, sourceId: string | null) => void;
}

// ============================================================================
// Template Slice Types
// ============================================================================

/**
 * 模板管理状态
 */
export interface TemplateSliceState {
  /** 当前选中的模板 ID */
  selectedTemplateId: string | null;
  /** 所有可用模板 */
  allTemplates: CustomAnkiTemplate[];
  /** 是否正在加载模板 */
  isLoadingTemplates: boolean;
  /** 是否显示模板选择器 */
  showTemplatePicker: boolean;
  /** 是否显示模板管理器 */
  showTemplateManager: boolean;
}

export interface TemplateSliceActions {
  setSelectedTemplateId: (id: string | null) => void;
  setAllTemplates: (templates: CustomAnkiTemplate[]) => void;
  setIsLoadingTemplates: (value: boolean) => void;
  setShowTemplatePicker: (value: boolean) => void;
  setShowTemplateManager: (value: boolean) => void;
  /** 获取当前选中的模板对象 */
  getSelectedTemplate: () => CustomAnkiTemplate | null;
}

// ============================================================================
// Cards Slice Types
// ============================================================================

/**
 * 文档任务状态（来自后端事件流）
 */
export interface DocumentTaskUI {
  task_id: string;
  segment_index: number;
  status: 'pending' | 'processing' | 'streaming' | 'paused' | 'completed' | 'failed' | 'truncated';
  cards: AnkiCard[];
  message?: string | null;
  is_retry?: boolean;
  /** 进度百分比 */
  progress?: number;
  /** 内容预览 */
  content_preview?: string;
  /** 错误信息 */
  error_message?: string | null;
  /** 模板快照 */
  template_snapshot?: AnkiCardTemplate;
}

/**
 * 卡片生成状态
 */
export interface CardsSliceState {
  /** 已生成的所有卡片 */
  generatedCards: AnkiCard[];
  /** 文档任务列表（按段落） */
  documentTasks: DocumentTaskUI[];
  /** 当前选中的任务 ID */
  selectedTaskId: string | null;
  /** 当前选中的卡片 ID 集合 */
  selectedCardIds: Set<string>;
  /** 是否正在生成 */
  isGenerating: boolean;
  /** 是否已暂停 */
  isPaused: boolean;
  /** 生成错误信息 */
  generationError: string | null;
}

export interface CardsSliceActions {
  setGeneratedCards: (cards: AnkiCard[]) => void;
  addGeneratedCard: (card: AnkiCard) => void;
  updateGeneratedCard: (cardId: string, updates: Partial<AnkiCard>) => void;
  removeGeneratedCard: (cardId: string) => void;
  clearGeneratedCards: () => void;
  setDocumentTasks: (tasks: DocumentTaskUI[]) => void;
  updateDocumentTask: (taskId: string, updates: Partial<DocumentTaskUI>) => void;
  setSelectedTaskId: (id: string | null) => void;
  setSelectedCardIds: (ids: Set<string>) => void;
  toggleCardSelection: (cardId: string) => void;
  selectAllCards: () => void;
  clearCardSelection: () => void;
  setIsGenerating: (value: boolean) => void;
  setIsPaused: (value: boolean) => void;
  setGenerationError: (error: string | null) => void;
}

// ============================================================================
// AnkiConnect Slice Types
// ============================================================================

/**
 * AnkiConnect 连接状态
 */
export interface AnkiConnectSliceState {
  /** AnkiConnect 是否可用 */
  isAnkiConnectAvailable: boolean;
  /** 可用的牌组列表 */
  ankiDeckNames: string[];
  /** 可用的笔记类型列表 */
  ankiModelNames: string[];
  /** 连接错误信息 */
  connectionError: string | null;
  /** 是否正在检查连接 */
  isCheckingConnection: boolean;
  /** 是否显示设置面板 */
  showSettingsPanel: boolean;
}

export interface AnkiConnectSliceActions {
  setIsAnkiConnectAvailable: (value: boolean) => void;
  setAnkiDeckNames: (names: string[]) => void;
  setAnkiModelNames: (names: string[]) => void;
  setConnectionError: (error: string | null) => void;
  setIsCheckingConnection: (value: boolean) => void;
  setShowSettingsPanel: (value: boolean) => void;
  /** 复合操作：更新连接状态 */
  updateConnectionStatus: (available: boolean, decks?: string[], models?: string[]) => void;
}

// ============================================================================
// Import Slice Types
// ============================================================================

/**
 * 错题摘要（使用现有的 MistakeItem 类型）
 * 直接从 src/types 导入以保持兼容性
 */
export type MistakeSummary = MistakeItem;

/**
 * 导入相关状态
 */
export interface ImportSliceState {
  /** 错题列表 */
  mistakeSummaries: MistakeSummary[];
  /** 错题搜索词 */
  mistakeSearchTerm: string;
  /** 已选中的错题 ID 集合 */
  selectedMistakeIds: Set<string>;
  /** 是否正在加载错题 */
  isLoadingMistakes: boolean;
  /** 是否正在导入错题 */
  isApplyingMistakeImport: boolean;
  /** 是否显示错题导入弹窗 */
  showMistakeImportDialog: boolean;
}

export interface ImportSliceActions {
  setMistakeSummaries: (summaries: MistakeSummary[]) => void;
  setMistakeSearchTerm: (term: string) => void;
  setSelectedMistakeIds: (ids: Set<string>) => void;
  toggleMistakeSelection: (id: string) => void;
  selectAllMistakes: () => void;
  clearMistakeSelection: () => void;
  setIsLoadingMistakes: (value: boolean) => void;
  setIsApplyingMistakeImport: (value: boolean) => void;
  setShowMistakeImportDialog: (value: boolean) => void;
}

// ============================================================================
// UI Slice Types
// ============================================================================

/**
 * 弹窗显示状态
 */
export interface DialogsState {
  templateManager: boolean;
  templatePicker: boolean;
  mistakeImport: boolean;
  cardPreview: boolean;
  errorDetails: boolean;
  exportOptions: boolean;
}

/**
 * 面板显示状态
 */
export interface PanelsState {
  materialQueue: boolean;
  generationOptions: boolean;
  ankiConnect: boolean;
}

/**
 * UI 控制状态
 */
export interface UISliceState {
  /** 弹窗显示状态 */
  dialogs: DialogsState;
  /** 面板显示状态 */
  panels: PanelsState;
  /** 当前激活的标签页 */
  activeTab: string;
  /** 全局错误信息 */
  error: string | null;
  /** 是否显示批量模式 */
  isBatchMode: boolean;
  /** 预览中的卡片 */
  previewingCard: AnkiCard | null;
  /** 卡片列表视图模式 */
  cardViewMode: 'grid' | 'table';
  /** 队列选中的 ID 集合 */
  selectedQueueIds: Set<string>;
}

export interface UISliceActions {
  setDialogOpen: (dialog: keyof DialogsState, open: boolean) => void;
  setPanelOpen: (panel: keyof PanelsState, open: boolean) => void;
  setActiveTab: (tab: string) => void;
  setError: (error: string | null) => void;
  setIsBatchMode: (value: boolean) => void;
  setPreviewingCard: (card: AnkiCard | null) => void;
  setCardViewMode: (mode: 'grid' | 'table') => void;
  setSelectedQueueIds: (ids: Set<string>) => void;
  toggleQueueSelection: (id: string) => void;
  clearQueueSelection: () => void;
  /** 复合操作：重置所有 UI 状态 */
  resetUI: () => void;
}

// ============================================================================
// Generation Options Slice Types
// ============================================================================

/**
 * 生成选项状态
 */
export interface OptionsSliceState {
  /** 当前生成选项 */
  options: AnkiGenerationOptions;
}

export interface OptionsSliceActions {
  setOptions: (options: AnkiGenerationOptions) => void;
  updateOption: <K extends keyof AnkiGenerationOptions>(
    key: K,
    value: AnkiGenerationOptions[K]
  ) => void;
  resetOptions: () => void;
}

// ============================================================================
// Combined Store Types
// ============================================================================

/**
 * AnkiUIStore 完整状态（所有切片的联合）
 */
export interface AnkiUIStoreState extends
  DocumentSliceState,
  TemplateSliceState,
  CardsSliceState,
  AnkiConnectSliceState,
  ImportSliceState,
  UISliceState,
  OptionsSliceState {}

/**
 * AnkiUIStore 完整 Actions
 */
export interface AnkiUIStoreActions extends
  DocumentSliceActions,
  TemplateSliceActions,
  CardsSliceActions,
  AnkiConnectSliceActions,
  ImportSliceActions,
  UISliceActions,
  OptionsSliceActions {}

/**
 * AnkiUIStore 完整类型
 */
export type AnkiUIStore = AnkiUIStoreState & AnkiUIStoreActions;

// ============================================================================
// Initial State Factory
// ============================================================================

/**
 * 默认生成选项
 */
export const DEFAULT_GENERATION_OPTIONS: AnkiGenerationOptions = {
  deck_name: 'Default',
  note_type: 'Basic',
  enable_images: false,
  max_cards_per_source: 5,
  max_tokens: 16384,
  temperature: 0.7,
};

/**
 * 创建初始状态
 */
export function createInitialState(): AnkiUIStoreState {
  return {
    // Document Slice
    documentContent: '',
    currentDocumentId: null,
    selectedFiles: [],
    isProcessingFiles: false,

    // Template Slice
    selectedTemplateId: null,
    allTemplates: [],
    isLoadingTemplates: false,
    showTemplatePicker: false,
    showTemplateManager: false,

    // Cards Slice
    generatedCards: [],
    documentTasks: [],
    selectedTaskId: null,
    selectedCardIds: new Set(),
    isGenerating: false,
    isPaused: false,
    generationError: null,

    // AnkiConnect Slice
    isAnkiConnectAvailable: false,
    ankiDeckNames: [],
    ankiModelNames: [],
    connectionError: null,
    isCheckingConnection: false,
    showSettingsPanel: false,

    // Import Slice
    mistakeSummaries: [],
    mistakeSearchTerm: '',
    selectedMistakeIds: new Set(),
    isLoadingMistakes: false,
    isApplyingMistakeImport: false,
    showMistakeImportDialog: false,

    // UI Slice
    dialogs: {
      templateManager: false,
      templatePicker: false,
      mistakeImport: false,
      cardPreview: false,
      errorDetails: false,
      exportOptions: false,
    },
    panels: {
      materialQueue: true,
      generationOptions: false,
      ankiConnect: false,
    },
    activeTab: 'generate',
    error: null,
    isBatchMode: false,
    previewingCard: null,
    cardViewMode: 'grid',
    selectedQueueIds: new Set(),

    // Options Slice
    options: { ...DEFAULT_GENERATION_OPTIONS },
  };
}
