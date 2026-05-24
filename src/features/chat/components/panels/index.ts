/**
 * Chat V2 - 面板组件导出
 *
 * 从旧架构 chat-core/components 复制并适配
 */

// ============================================================================
// 类型定义
// ============================================================================

export type {
  UnifiedSourceBundle,
  UnifiedSourceGroup,
  UnifiedSourceItem,
  RagSourceInfo,
  // 多模态类型
  MultimodalSourceType,
  MultimodalRetrievalSource,
  MultimodalSourceInfo,
} from './sourceTypes';

// ============================================================================
// 纯展示组件（原有）
// ============================================================================

export { default as UnifiedSourcePanel } from './UnifiedSourcePanel';
export { OcrResultCard } from './OcrResultCard';

// 多模态检索结果卡片
export { MultimodalSourceCard } from './MultimodalSourceCard';
export type { MultimodalSourceCardProps } from './MultimodalSourceCard';

// ============================================================================
// V2 封装组件（新增）
// ============================================================================

export {
  SourcePanelV2,
  useMessageSources,
  useHasMessageSources,
  type SourcePanelV2Props,
} from './SourcePanelV2';

// ============================================================================
// 数据适配器（新增）
// ============================================================================

export {
  blocksToSourceBundle,
  extractSourcesFromMessageBlocks,
  extractSourcesFromSharedContext,
  hasSourcesInBlocks,
} from './sourceAdapter';

// V2 封装组件
export {
  OcrResultCardV2,
  useOcrMeta,
  useOcrImages,
  useOcrStatus,
  useOcrData,
  PREVIEW_IMAGE_EVENT,
  type PreviewImageEventDetail,
} from './OcrResultCardV2';
