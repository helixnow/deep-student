/**
 * Learning Hub Hooks 导出
 */

export {
  useVfsFolders,
  findFolderInTree,
  getFolderBreadcrumb,
  flattenFolderTree,
} from './useVfsFolders';

export type {
  UseVfsFoldersOptions,
  UseVfsFoldersReturn,
} from './useVfsFolders';

export { useFolderNavigationHistory } from './useFolderNavigationHistory';

export { useFolderNavigation } from './useFolderNavigation';
export type {
  RealPathBreadcrumbItem,
  FolderNavigationState,
  UseFolderNavigationReturn,
} from './useFolderNavigation';

export { useMultiSelect } from './useMultiSelect';
export type { UseMultiSelectOptions, UseMultiSelectReturn } from './useMultiSelect';

export { useVfsContextInject } from './useVfsContextInject';
export type { VfsInjectParams, VfsInjectResult, UseVfsContextInjectReturn } from './useVfsContextInject';

export { useLearningHubEvents } from './useLearningHubEvents';
export type {
  LearningHubEventHandlers,
  OpenExamEventDetail,
  OpenTranslationEventDetail,
  OpenEssayEventDetail,
  OpenNoteEventDetail,
  OpenResourceEventDetail,
  NavigateToKnowledgeEventDetail,
} from './useLearningHubEvents';
