/**
 * Learning Hub 组件导出
 *
 * 根据文档20《统一资源库与访达层改造任务分配》实现
 */

// Prompt 4: 访达侧栏容器
export { LearningHubSidebar } from './LearningHubSidebar';
export { LearningHubToolbar } from './LearningHubToolbar';
export { LearningHubActionBar } from './LearningHubActionBar';
// 全屏页面组件
export { LearningHubPage } from './LearningHubPage';
export type {
  LearningHubSidebarProps,
  LearningHubToolbarProps,
  LearningHubActionBarProps,
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

// 其他现有组件
export {
  ResourceGridView,
  type ResourceGridViewProps,
  type ResourceGridItemProps,
} from './ResourceGridView';

export {
  useReferenceToChat,
  type UseReferenceToChatReturn,
  type ReferenceToChatParams,
  type ReferenceToChatResult,
  type SourceType,
} from './useReferenceToChat';

export {
  PreviewRouter,
  type PreviewRouterProps,
  type PreviewRouterData,
} from './PreviewRouter';

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

// ★ 文档28 Prompt 8: 路径面包屑组件
export { PathBreadcrumb, type PathBreadcrumbProps } from './components';

// 真实路径导航类型
export type { RealPathBreadcrumbItem } from './hooks';
