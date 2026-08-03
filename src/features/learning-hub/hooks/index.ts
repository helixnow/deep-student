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

export type { RealPathBreadcrumbItem } from '../types/navigation';

export { useDialogFocusManagement } from './useDialogFocusManagement';

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
