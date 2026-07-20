/**
 * 笔记模块类型统一导出
 */

// 引用节点类型
export {
  // 核心类型
  type SourceDatabase,
  type ExtendedSourceDatabase,
  type PreviewType,
  type ReferenceNode,
  type ExtendedFolderStructure,
  type CreateReferenceNodeParams,

  // 联合常量（与类型同源，供运行时枚举）
  SOURCE_DATABASES,
  EXTENDED_SOURCE_DATABASES,
  PREVIEW_TYPES,

  // ID 前缀常量
  NOTE_ID_PREFIX,
  FOLDER_ID_PREFIX,
  REFERENCE_ID_PREFIX,

  // ID 工具函数
  isReferenceId,
  isFolderId,
  isNoteId,
  generateRefId,
  generateFolderId,
  getNodeType,

  // SourceDatabase 辅助
  SOURCE_DB_DISPLAY_NAMES,
  SOURCE_DB_ICONS,
  SOURCE_DB_PREVIEW_TYPES,
  getSourceDbIcon,
  getSourceDbPreviewType,

  // 类型守卫
  isValidSourceDatabase,
  isExtendedSourceDatabase,
  isValidPreviewType,
  isValidReferenceNode,

  // 工厂函数
  createReferenceNode,
} from './reference';
