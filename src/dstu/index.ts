/**
 * DSTU 访达协议层 - 统一导出
 *
 * DSTU (DS-Tauri-Unified) 是 VFS 虚拟文件系统与上层应用之间的统一访问接口。
 *
 * 使用示例：
 * ```typescript
 * import { dstu, type DstuNode } from '@/dstu';
 *
 * // 列出所有笔记（使用 typeFilter 筛选）
 * const notes = await dstu.list('/', { typeFilter: 'note' });
 *
 * // 获取笔记内容
 * const content = await dstu.getContent('/note_123');
 *
 * // 创建新笔记
 * const newNote = await dstu.create('/', {
 *   type: 'note',
 *   name: '期末复习笔记',
 *   content: '# 期末复习\n\n...',
 * });
 * ```
 *
 * @see 21-VFS虚拟文件系统架构设计.md
 * @see 22-VFS与DSTU访达协议层改造任务分配.md
 */

// ── 核心 API ──

export { dstu } from './api';

// ── 资源创建工厂 ──

export {
  createEmpty,
  type CreateEmptyOptions,
  type CreatableResourceType,
} from './factory';

// ── 文件编码工具 ──

export {
  fileToBase64,
  base64ToBlob,
} from './encoding';

// ── 日志系统 ──

export type { DstuLogger, DstuDebugPluginLike } from './logger';

export {
  noopLogger,
  consoleLogger,
  setDstuLogger,
  getDstuLogger,
  resetDstuLogger,
  createLoggerFromDebugPlugin,
} from './logger';

// ── 命名工具 ──

export type { ParsedNameWithNumber } from './naming';

export {
  parseNameWithNumber,
  generateUniqueName,
  generateUniqueNameSafe,
  isValidName,
  sanitizeName,
} from './naming';

// ── 类型定义 ──

export type {
  DstuNodeType,
  DstuPreviewType,
  DstuNode,
  DstuListOptions,
  DstuCreateOptions,
  DstuWatchEventType,
  DstuWatchEvent,
  DstuApi,
  ParsedDstuPath,
  DstuError,
} from './types';

export {
  createDstuError,
  EMPTY_RESOURCE_TEMPLATES,
  type DstuEmptyResourceTemplate,
} from './types';

// ── 路径工具 ──

// 旧格式已废弃，统一使用 pathUtils.parse() 和 pathUtils.build()
export { pathUtils } from './utils/pathUtils';

// ── 编辑器注册表 ──

export type {
  EditorLocation,
  EditorMode,
  ResourceCapabilities,
  EditorRegistryEntry,
} from './editorTypes';

export type {
  EditorProps,
  CreateEditorProps,
} from './editorTypes';

export {
  editorRegistry,
  getEditorEntry,
  getCapabilities,
  hasCapability,
  getReferenceableTypes,
  getEditableTypes,
  loadEditorComponent,
} from './editorRegistry';

// ── Hooks ──

export {
  useDstuList,
  useDstuNotes,
  useDstuTextbooks,
  useDstuExams,
  useDstuTranslations,
  useDstuEssays,
  useDstuResource,
  useDstuCreate,
  useDstuSearch,
  type UseDstuListOptions,
  type UseDstuListReturn,
  type UseDstuResourceOptions,
  type UseDstuResourceReturn,
  type UseDstuCreateReturn,
  type UseDstuSearchOptions,
  type UseDstuSearchReturn,
} from './hooks';

// ── 资源打开函数 ──

export type { OpenResourceOptions } from './editorTypes';

export type {
  OpenResourceHandler,
  EditorRenderProps,
  ParsedEditorRoute,
} from './openResource';

export {
  openResource,
  openInPanel,
  openInPage,
  openInFullscreen,
  openInModal,
  registerOpenResourceHandler,
  getOpenResourceHandler,
  // 🔧 P0-28 修复：新增的命名空间管理函数
  setActiveOpenResourceHandler,
  getRegisteredHandlerNamespaces,
  getEditorForRender,
  getEditorPageRoute,
  parseEditorRoute,
} from './openResource';

// ── 右键菜单 ──

export type {
  ContextMenuItem,
  ContextMenuItemVariant,
  EditorState,
  EditorActions,
  EditorComponent,
} from './editorTypes';

export type {
  ContextMenuActionHandler,
} from './contextMenu';

export {
  buildContextMenu,
  buildQuickMenu,
  buildBatchMenu,
  registerContextMenuActionHandler,
} from './contextMenu';

// ── 模块适配器（Prompt 10: 各模块接入改造） ──

export {
  // 笔记适配器
  notesDstuAdapter,
  useNotesDstu,
  dstuNodeToNoteItem,
  noteItemToDstuNode,
  type UseNotesDstuOptions,
  type UseNotesDstuReturn,
  // 教材适配器
  textbookDstuAdapter,
  useTextbooksDstu,
  dstuNodeToTextbookItem,
  textbookItemToDstuNode,
  type TextbookItem,
  type UseTextbooksDstuOptions,
  type UseTextbooksDstuReturn,
  // 翻译适配器
  translationDstuAdapter,
  useTranslationsDstu,
  dstuNodeToTranslationItem,
  translationItemToDstuNode,
  type UseTranslationsDstuOptions,
  type UseTranslationsDstuReturn,
  // 题目集适配器
  examDstuAdapter,
  useExamsDstu,
  dstuNodeToExamSession,
  examSessionToDstuNode,
  type ExamSheetSession,
  type UseExamsDstuOptions,
  type UseExamsDstuReturn,
  // 作文适配器
  essayDstuAdapter,
  useEssaysDstu,
  dstuNodeToEssaySession,
  essaySessionToDstuNode,
  gradingSessionToDstuNode,
  type EssaySessionItem,
  type UseEssaysDstuOptions,
  type UseEssaysDstuReturn,
} from './adapters';

// ── 文件夹 API（Prompt 6: 前端 DSTU 文件夹 API 封装） ──

export {
  folderApi,
  type FolderApiType,
} from './api/folderApi';

// ── 回收站 API ──

export { trashApi } from './api/trashApi';

// ── 路径 API（Prompt 7: 前端 Path API 封装，文档 28 契约 E） ──

export {
  pathApi,
  type PathApiType,
} from './api/pathApi';

// ── 路径工具（Prompt 7: 纯前端路径工具，文档 28 契约 D3） ──

export {
  parsePath,
  buildPath,
  getResourceType,
  isValidPath,
  isVirtualPath,
  getParentPath,
  getBasename,
  joinPath,
} from './utils/pathUtils';

// 路径类型
export type {
  ParsedPath,
  ResourceLocation,
  PathUtils,
  BatchMoveRequest,
  BatchMoveResult,
  FailedMoveItem,
  PathError,
  PathErrorCode,
  VirtualPathType,
} from './types/path';

export {
  RESOURCE_ID_PREFIX_MAP,
  RESOURCE_TYPE_TO_PREFIX,
  VIRTUAL_PATH_PREFIXES,
  PATH_ERROR_CODES,
  createPathError,
} from './types/path';

// 文件夹类型定义
export type {
  VfsFolder,
  VfsFolderItem,
  FolderTreeNode,
  FolderResourceInfo,
  FolderResourcesResult,
  FolderContextData,
  FolderItemType,
  FolderErrorCode,
  CreateFolderParams,
  AddItemParams,
} from './types/folder';

export {
  FOLDER_ERRORS,
  FOLDER_CONSTRAINTS,
} from './types/folder';
