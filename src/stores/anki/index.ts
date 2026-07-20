/**
 * Anki Store Module
 * 
 * 导出 Anki UI Store 和相关类型
 */

// Store
export {
  useAnkiUIStore,
  useDocumentState,
  useTemplateState,
  useCardsState,
  useAnkiConnectState,
  useGenerationOptions,
  getAnkiUIStoreActions,
} from './useAnkiUIStore';

// Types
// ★ 2026-07 清理：错题导入相关类型（ImportSliceState / ImportSliceActions /
//   MistakeSummary）已随废弃的 MistakeImportDialog 一并移除。
export type {
  // State Types
  AnkiUIStore,
  AnkiUIStoreState,
  DocumentSliceState,
  TemplateSliceState,
  CardsSliceState,
  AnkiConnectSliceState,
  UISliceState,
  OptionsSliceState,
  // Action Types
  DocumentSliceActions,
  TemplateSliceActions,
  CardsSliceActions,
  AnkiConnectSliceActions,
  UISliceActions,
  OptionsSliceActions,
  // Data Types
  DocumentTaskUI,
  DialogsState,
  PanelsState,
} from './types';

export {
  createInitialState,
  DEFAULT_GENERATION_OPTIONS,
} from './types';
