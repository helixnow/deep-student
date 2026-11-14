import { CommandError } from '../../../kernel/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { fs } from './local-runtime.ts';
import type { VfsDatabase } from '../api.ts';
import {
  MAX_FOLDER_TITLE_LENGTH,
  MAX_INJECT_RESOURCES,
  folderErrors,
  type BreadcrumbItem,
  type FolderResourcesResult,
  type FolderTreeNode,
  type VfsFolder,
  type VfsFolderItem,
} from './folder-types.ts';
import {
  addItemToFolderWithConn,
  createFolderItemRecord,
  createFolderRecord,
  createFolderWithConn,
  deleteFolderWithConn,
  folderExistsWithConn,
  getBreadcrumbsWithConn,
  getAllResourcesWithConn,
  getFolderItemsAllWithConn,
  getFolderTreeAllWithConn,
  getFolderWithConn,
  listAllFoldersWithConn,
  moveFolderWithConn,
  moveItemToFolderWithConn,
  removeItemFromFolderWithConn,
  renameFolderIfVersionWithConn,
  reorderFoldersWithConn,
  reorderItemsWithConn,
  setFolderExpandedWithConn,
  type FolderLog,
} from '../repository/folders.ts';

export interface FolderCommandDeps {
  readonly database: VfsDatabase;
  readonly log: FolderLog;
}

const VALID_ITEM_TYPES = new Set(['note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap']);
const RESERVED_COLOR_NAMES = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'gray', 'cyan']);
const UNICODE_BYPASS = /[\uFF0F\uFF3C\u2044\u2215\u29F8\u200B\u200C\u200D\uFEFF]/u;

function fail(message: string): never {
  throw new CommandError(message);
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function containsInvalidChars(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function validateStringInput(value: string, fieldName: string, maxLength: number, log: FolderLog): void {
  if (containsInvalidChars(value)) {
    log.warn('[DSTU::folder_handlers] validate_string_input: %s contains invalid control characters', fieldName);
    fail(`${fieldName} 包含非法字符`);
  }
  if (UNICODE_BYPASS.test(value)) {
    log.warn('[DSTU::folder_handlers] validate_string_input: %s contains Unicode bypass characters', fieldName);
    fail(`${fieldName} 包含非法Unicode字符`);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    log.warn('[DSTU::folder_handlers] validate_string_input: %s contains path separators', fieldName);
    fail(`${fieldName} 不能包含路径分隔符`);
  }
  if (utf8ByteLength(value) > maxLength) {
    log.warn('[DSTU::folder_handlers] validate_string_input: %s exceeds max length %d', fieldName, maxLength);
    fail(`${fieldName} 长度超过限制`);
  }
}

function isValidColor(value: string): boolean {
  if (value === '') return true;
  if ([...value].some(character => character.charCodeAt(0) > 0x7F)) return false;
  if (value.length === 7 && value.startsWith('#')) return /^[0-9a-fA-F]{6}$/.test(value.slice(1));
  return RESERVED_COLOR_NAMES.has(value);
}

function validateTitle(title: string, log: FolderLog): void {
  if (rustTrim(title).length === 0) fail('文件夹标题不能为空');
  validateStringInput(title, '文件夹标题', MAX_FOLDER_TITLE_LENGTH, log);
}

export function createFolderCommand(
  deps: FolderCommandDeps,
  title: string,
  parentId?: string | null,
  icon?: string | null,
  color?: string | null,
): VfsFolder {
  return command(() => {
    validateTitle(title, deps.log);
    if (icon !== undefined && icon !== null) validateStringInput(icon, '图标', 50, deps.log);
    if (color !== undefined && color !== null && !isValidColor(color)) {
      deps.log.warn('[DSTU::folder_handlers] dstu_folder_create: invalid color format: %s', color);
      fail('颜色格式错误，请使用 #RRGGBB 格式或预定义颜色名称');
    }
    const actualParentId = parentId === 'root' || parentId === '' ? undefined : parentId ?? undefined;
    const folder = createFolderRecord(title, actualParentId, icon ?? undefined, color ?? undefined);
    createFolderWithConn(deps.database.getConnSafe(), folder);
    return folder;
  });
}

export function getFolderCommand(deps: FolderCommandDeps, folderId: string): VfsFolder | null {
  return command(() => getFolderWithConn(deps.database.getConnSafe(), folderId) ?? null);
}

export function renameFolderCommand(deps: FolderCommandDeps, folderId: string, title: string): null {
  return command(() => {
    validateTitle(title, deps.log);
    const conn = deps.database.getConnSafe();
    const folder = getFolderWithConn(conn, folderId);
    if (folder === undefined) fail('资源不存在');
    renameFolderIfVersionWithConn(conn, folderId, title, folder.updatedAt, deps.log);
    return null;
  });
}

export function deleteFolderCommand(deps: FolderCommandDeps, folderId: string): null {
  return command(() => {
    deleteFolderWithConn(deps.database.getConnSafe(), folderId, {
      deviceId: fs.deviceIdEnv(),
      log: deps.log,
    });
    return null;
  });
}

export function moveFolderCommand(deps: FolderCommandDeps, folderId: string, newParentId?: string | null): null {
  return command(() => {
    if (newParentId !== undefined && newParentId !== null && newParentId === folderId) {
      fail(folderErrors.INVALID_PARENT);
    }
    moveFolderWithConn(deps.database.getConnSafe(), folderId, newParentId ?? undefined, deps.log);
    return null;
  });
}

export function setFolderExpandedCommand(deps: FolderCommandDeps, folderId: string, isExpanded: boolean): null {
  return command(() => {
    setFolderExpandedWithConn(deps.database.getConnSafe(), folderId, isExpanded);
    return null;
  });
}

export function addFolderItemCommand(
  deps: FolderCommandDeps,
  folderId: string | null | undefined,
  itemType: string,
  itemId: string,
): VfsFolderItem {
  return command(() => {
    if (!VALID_ITEM_TYPES.has(itemType)) fail('参数格式错误');
    const conn = deps.database.getConnSafe();
    if (folderId !== undefined && folderId !== null && !folderExistsWithConn(conn, folderId)) {
      fail('目标文件夹不存在');
    }
    const item = createFolderItemRecord(folderId ?? undefined, itemType, itemId);
    addItemToFolderWithConn(conn, item);
    return item;
  });
}

export function removeFolderItemCommand(deps: FolderCommandDeps, itemType: string, itemId: string): null {
  return command(() => {
    removeItemFromFolderWithConn(deps.database.getConnSafe(), itemType, itemId);
    return null;
  });
}

export function moveFolderItemCommand(
  deps: FolderCommandDeps,
  itemType: string,
  itemId: string,
  newFolderId?: string | null,
): null {
  return command(() => {
    moveItemToFolderWithConn(deps.database.getConnSafe(), itemType, itemId, newFolderId ?? undefined);
    return null;
  });
}

export function listFoldersCommand(deps: FolderCommandDeps): VfsFolder[] {
  return command(() => listAllFoldersWithConn(deps.database.getConnSafe()));
}

export function getFolderTreeCommand(deps: FolderCommandDeps): FolderTreeNode[] {
  return command(() => getFolderTreeAllWithConn(deps.database.getConnSafe()));
}

export function getFolderItemsCommand(deps: FolderCommandDeps, folderId?: string | null): VfsFolderItem[] {
  return command(() => getFolderItemsAllWithConn(deps.database.getConnSafe(), folderId ?? null));
}

export function getFolderResourcesCommand(
  deps: FolderCommandDeps,
  folderId: string,
  includeSubfolders: boolean,
  includeContent: boolean,
): FolderResourcesResult {
  return command(() => {
    const result = getAllResourcesWithConn(
      deps.database.getConnSafe(),
      folderId,
      includeSubfolders,
      includeContent,
    );
    if (result.totalCount > MAX_INJECT_RESOURCES) {
      deps.log.warn(
        '[DSTU::folder_handlers] Folder %s contains %s resources, exceeds recommended limit %s',
        folderId,
        result.totalCount,
        MAX_INJECT_RESOURCES,
      );
    }
    return result;
  });
}

export function reorderFoldersCommand(deps: FolderCommandDeps, folderIds: string[]): null {
  return command(() => {
    reorderFoldersWithConn(deps.database.getConnSafe(), folderIds);
    return null;
  });
}

export function reorderFolderItemsCommand(deps: FolderCommandDeps, _folderId: string | null | undefined, itemIds: string[]): null {
  return command(() => {
    reorderItemsWithConn(deps.database.getConnSafe(), itemIds);
    return null;
  });
}

export function getFolderBreadcrumbsCommand(deps: FolderCommandDeps, folderId: string): BreadcrumbItem[] {
  return command(() => {
    const conn = deps.database.getConnSafe();
    return getBreadcrumbsWithConn(conn, folderId);
  });
}
