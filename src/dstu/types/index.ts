/**
 * DSTU 类型导出
 *
 * 统一导出所有 DSTU 类型定义
 */

// 文件夹类型
export type {
  VfsFolder,
  VfsFolderItem,
  FolderTreeNode,
  FolderResourcesResult,
  FolderResourceInfo,
  FolderContextData,
  FolderItemType,
  FolderErrorCode,
  CreateFolderParams,
  AddItemParams,
} from './folder';

export { FOLDER_ERRORS, FOLDER_CONSTRAINTS } from './folder';

// 路径类型（契约 D）
export type {
  ParsedPath,
  ResourceLocation,
  PathUtils,
  BatchMoveRequest,
  BatchMoveResult,
  FailedMoveItem,
  VirtualPathType,
  PathErrorCode,
  PathError,
} from './path';

export {
  RESOURCE_ID_PREFIX_MAP,
  RESOURCE_TYPE_TO_PREFIX,
  VIRTUAL_PATH_PREFIXES,
  PATH_ERROR_CODES,
  createPathError,
} from './path';
