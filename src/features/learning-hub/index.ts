/**
 * Learning Hub 组件导出
 *
 * 根据文档20《统一资源库与访达层改造任务分配》实现
 */

// Prompt 4: 访达侧栏容器
export { LearningHubSidebar } from './LearningHubSidebar';
// 全屏页面组件
export { LearningHubPage } from './LearningHubPage';
// ★ 2026-06-12（审阅问题 FE-M6）：移除死代码导出
// （LearningHubToolbar/LearningHubActionBar/ResourceGridView/FolderTreeView 已删除）
export type {
  LearningHubSidebarProps,
  WorkMode,
  ViewMode,
  DataView,
  ResourceType,
  ResourceListItem,
  LearningHubState,
} from './types';
export {
  initialLearningHubState,
  RESOURCE_TYPE_CONFIG,
  DATA_VIEW_CONFIG,
  VIEW_MODE_CONFIG,
} from './types';

export {
  useReferenceToChat,
  type UseReferenceToChatReturn,
  type ReferenceToChatParams,
  type ReferenceToChatResult,
  type SourceType,
} from './useReferenceToChat';

// 导航上下文
export {
  LearningHubNavigationProvider,
  useLearningHubNavigation,
  useLearningHubNavigationSafe,
  // 📱 全局导航（供 Provider 外部使用，如 App.tsx）
  getGlobalLearningHubNavigation,
  subscribeLearningHubNavigation,
  LEARNING_HUB_NAV_STATE_CHANGED,
} from './LearningHubNavigationContext';

// 真实路径导航类型
export type { RealPathBreadcrumbItem } from './types/navigation';

// 材料原图查看器与 #source-image 引用解析
export {
  SourceImageViewer,
  MAX_CONCURRENT_SOURCE_IMAGE_LOADS,
  isValidSourceImageRegion,
  formatSourceImageLocationLabel,
  buildSourceImageHref,
  parseSourceImageHref,
  parseMaterialImageHref,
  SourceImageLoadScheduler,
  createSourceImageLoadScheduler,
  defaultSourceImageScheduler,
  type SourceImageRegion,
  type ParsedSourceImageRef,
  type SourceImageErrorKind,
  type SourceImageLoadPayload,
  type SourceImageSchedulerStats,
  type SourceImageViewerProps,
} from './components/SourceImageViewer';

// 阅读材料双锚点文字高亮与智能触控笔/掌触拒绝仲裁
export {
  computeContentSignature,
  createTextHighlightAnchor,
  resolveTextHighlightAnchor,
  resetSharedPalmRejectedPointers,
  arbitrateAnnotationPointerInput,
  escapeHighlightHtmlText,
  formatHighlightCitationForPrompt,
  type MaterialFormat,
  type MaterialTextAnchor,
  type CreateTextHighlightAnchorMeta,
  type ResolveTextHighlightAnchorResult,
  type AnnotationPointerAction,
  type AnnotationPointerEventLike,
  type AnnotationPointerArbitrationConfig,
} from './utils/textHighlightAnchors';

// 印刷级讲义阅读器与 IR 工具
export {
  HandoutReaderView,
  handoutIrToMarkdown,
  sanitizeHandoutSvg,
  validateHandoutIr,
  type HandoutDifficulty,
  type HandoutCalloutKind,
  type HandoutCalloutBlock,
  type HandoutFormulaBlock,
  type HandoutDiagramBlock,
  type HandoutCheckpointBlock,
  type HandoutExtendedBlock,
  type HandoutBlock,
  type HandoutContentBlock,
  type HandoutSection,
  type HandoutDocument,
  type HandoutSectionAnchorPayload,
  type HandoutReaderViewProps,
} from './components/HandoutReaderView';

// 媒体课程章节与伴随面板上下文（供跨模块顶层入口复用）
export {
  chapterIndexAt,
  normalizeChapters,
  useMediaChapters,
  type MediaChapter,
} from './apps/views/media/mediaChapters';

export {
  MEDIA_STUDY_TRANSCRIPT_TAB,
  MediaStudyCompanionContext,
  useMediaStudyCompanion,
  type MediaStudyCompanionRenderContext,
  type MediaStudyCompanionTab,
  type MediaStudyCompanionValue,
} from './apps/views/media/mediaStudyCompanion';
