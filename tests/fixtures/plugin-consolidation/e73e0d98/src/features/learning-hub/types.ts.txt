/**
 * Learning Hub 访达侧栏 - 类型定义
 *
 * 文档 20 Prompt 4: 访达侧栏容器
 *
 * 核心功能：
 * - 两种工作模式：Canvas（侧栏）/ Fullscreen（全屏）
 * - 两种视图模式：List（列表）/ Grid（图标）
 * - 两种数据视图：文件夹视图 / 资源浏览视图
 */

import type { ContextRef } from '@/features/chat/context/types';
import type { ReferenceNode } from '@/features/notes/types/reference';
import type { FolderItemType, VfsFolderItem } from '@/dstu/types/folder';
import type { DstuNode, DstuNodeType } from '@/dstu/types';
import {
  AUDIO_PREVIEW_EXTENSIONS,
  VIDEO_PREVIEW_EXTENSIONS,
} from './apps/views/mediaPreviewUtils';
import type React from 'react';

// ============================================================================
// 工作模式
// ============================================================================

/**
 * 工作模式
 * - canvas: 作为侧栏嵌入对话页面
 * - fullscreen: 全屏独立模式
 */
export type WorkMode = 'canvas' | 'fullscreen';

/**
 * 视图模式
 * - list: 列表视图
 * - grid: 图标/网格视图
 * - columns: Finder 分栏视图（仅桌面全屏宿主使用；与 stores/finderStore 的
 *   ViewMode 保持一致，分栏 UI 落地前由 FinderFileList 回退为 grid 渲染）
 */
export type ViewMode = 'list' | 'grid' | 'columns';

/**
 * 数据视图
 * - folder: 文件夹视图（笔记 + 引用节点）
 * - resource: 资源浏览视图（所有可引用资源）
 */
export type DataView = 'folder' | 'resource';

// ============================================================================
// 资源类型与排序
// ============================================================================

/**
 * 资源类型（用于资源浏览视图）
 * 注意：mistake 类型已移除，因为是旧版聊天记录
 * ★ 2025-12-07: 添加 translation 和 essay 以支持内置文件夹
 * ★ 2025-12-09: 添加 image 和 file 以支持附件资源
 */
export type ResourceType = 'note' | 'textbook' | 'exam' | 'translation' | 'essay' | 'image' | 'file' | 'mindmap' | 'all';

/**
 * 排序字段
 */
export type SortField = 'updatedAt' | 'title' | 'type';

/**
 * 排序方向
 */
export type SortOrder = 'asc' | 'desc';

/**
 * 资源列表项（统一结构）
 */
export interface ResourceListItem {
  /** 资源 ID */
  id: string;
  /** 显示标题 */
  title: string;
  /** 资源类型 */
  type: ResourceType;
  /** 预览类型 */
  previewType: 'markdown' | 'pdf' | 'image' | 'exam' | 'none' | 'docx' | 'xlsx' | 'pptx' | 'epub' | 'text' | 'audio' | 'video' | 'mindmap';
  /** 缩略图 URL（可选，用于 Grid 视图） */
  thumbnail?: string;
  /** 内容预览（用于笔记的 Markdown 预览，仅前 200 字符） */
  contentPreview?: string;
  /** 更新时间戳（毫秒） */
  updatedAt: number;
  /** 创建时间戳（毫秒） */
  createdAt?: number;
  /** 原始来源数据库 */
  // ★ 2025-12-09: 添加 translations, essays, attachments
  sourceDb?: 'notes' | 'textbooks' | 'exam_sessions' | 'chat_v2' | 'translations' | 'essays' | 'attachments' | 'mindmaps';
  
  // ========== 教材专属字段 ==========
  /** PDF 文件路径（教材专用，用于前端生成封面） */
  path?: string;
  /** 文件大小（字节） */
  size?: number;
  /** 是否收藏 */
  isFavorite?: boolean;
  
  // ========== 回收站字段 ==========
  /** 是否已删除（在回收站中） */
  isDeleted?: boolean;
  /** 删除时间（ISO 字符串） */
  deletedAt?: string;
}

// ============================================================================
// 组件 Props
// ============================================================================

/**
 * LearningHubSidebar 主组件 Props
 */
export interface LearningHubSidebarProps {
  /** 工作模式 */
  mode: WorkMode;
  /** 引用到对话回调 */
  onReferenceToChat?: (contextRef: ContextRef) => void;
  /** 打开预览回调（全屏模式） */
  onOpenPreview?: (item: ResourceListItem) => void;
  /** 关闭回调（Canvas 模式） */
  onClose?: () => void;
  /** 打开应用回调（在右侧面板打开资源） */
  onOpenApp?: (item: ResourceListItem) => void;
  /** 自定义样式 */
  className?: string;
  /** ★ 是否收缩状态（隐藏分类导航，紧凑列表） */
  isCollapsed?: boolean;
  /** ★ 切换收缩状态回调 */
  onToggleCollapse?: () => void;
  /** ★ 当前在应用面板中打开的文件 ID（用于高亮） */
  activeFileId?: string | null;
  /** ★ 移动端底部安全区内边距 */
  mobileBottomPadding?: boolean;
  /** ★ 是否有应用面板打开 */
  hasOpenApp?: boolean;
  /** ★ 关闭应用面板回调 */
  onCloseApp?: () => void;
  /** ★ 隐藏顶部工具栏和导航栏（移动端聊天内嵌模式使用，由外部容器提供面包屑） */
  hideToolbarAndNav?: boolean;
  /** ★ 桌面端将快捷入口渲染到外层 Shell 侧栏 */
  quickAccessPortalTarget?: HTMLElement | null;
  /** ★ Workbench 资源库窗口：将 Finder 工具栏挂到原生窗口标题栏插槽 */
  toolbarPortalTarget?: HTMLElement | null;
  /** 工具栏所在标题栏类型：普通模式使用全局 shell，OS 模式使用独立窗口 */
  toolbarPortalMode?: 'shell' | 'window';
  /** ★ 高亮标记的资源 ID（如分组已关联的资源，显示勾选状态） */
  highlightedIds?: Set<string>;
  /** ★ LH-HOST：宿主标识（canvas / files / page…）；Step1 仅透传，不改 store 分桶 */
  hostId?: string;
  /** ★ LH-HOST：会话是否活跃；false 时跳过 path→refresh */
  sessionActive?: boolean;
  /**
   * 是否启用 learningHub:* 命令事件（create-folder / focus-search）。
   * 未传时回退到 `useViewVisibility('learning-hub')`；
   * Workbench Files 窗应传 `isActive`，避免与 legacy LH 双监听。
   */
  commandsEnabled?: boolean;
  /** ★ 多选模式变化通知（供外部全局顶栏渲染勾选切换按钮的激活态） */
  onMultiSelectModeChange?: (active: boolean) => void;
  /** ★ 外部全局顶栏可调用的多选模式切换句柄（由本组件持续写入最新闭包） */
  multiSelectToggleRef?: React.MutableRefObject<(() => void) | null>;
}

/**
 * 面包屑路径项
 * 
 * ★ 文档28 Prompt 8: 更新为真实路径版本，兼容旧字段
 */
export interface BreadcrumbItem {
  /** 文件夹 ID，null 表示根目录 */
  id: string | null;
  /** 显示标题 */
  title: string;
  /** 完整路径（可选，用于真实路径导航） */
  fullPath?: string;
}

// ★ 2026-06-12（审阅问题 FE-M6）：LearningHubToolbarProps / LearningHubActionBarProps
// 随死代码组件（LearningHubToolbar/LearningHubActionBar）一并移除

// ============================================================================
// 状态类型
// ============================================================================

/**
 * Learning Hub 内部状态
 */
export interface LearningHubState {
  /** 视图模式 */
  viewMode: ViewMode;
  /** 数据视图 */
  dataView: DataView;
  /** 搜索关键词 */
  searchQuery: string;
  /** 资源类型过滤 */
  resourceTypeFilter: ResourceType;
  /** 排序字段 */
  sortField: SortField;
  /** 排序方向 */
  sortOrder: SortOrder;
  /** 选中的项 ID */
  selectedId: string | null;
  /** 展开的文件夹 ID 列表 */
  expandedIds: string[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  
  // ========== 多选支持（2025-12-08 新增）==========
  /** 是否启用多选模式 */
  isMultiSelectMode: boolean;
  /** 多选的项 ID 列表 */
  selectedIds: string[];
  /** 是否显示回收站 */
  showTrash: boolean;
}

/**
 * 初始状态
 */
export const initialLearningHubState: LearningHubState = {
  viewMode: 'list',
  dataView: 'folder',
  searchQuery: '',
  resourceTypeFilter: 'all',
  sortField: 'updatedAt',
  sortOrder: 'desc',
  selectedId: null,
  expandedIds: [],
  isLoading: false,
  error: null,
  // 多选和回收站支持
  isMultiSelectMode: false,
  selectedIds: [],
  showTrash: false,
};

// ============================================================================
// 常量
// ============================================================================

/**
 * 资源类型显示配置
 */
export const RESOURCE_TYPE_CONFIG: Record<
  ResourceType,
  {
    labelKey: string;
    icon: string;
    color: string;
  }
> = {
  all: {
    labelKey: 'learningHub:resourceType.all',
    icon: 'LayoutGrid',
    color: 'text-muted-foreground',
  },
  note: {
    labelKey: 'learningHub:resourceType.note',
    icon: 'FileText',
    color: 'text-blue-500',
  },
  textbook: {
    labelKey: 'learningHub:resourceType.textbook',
    icon: 'BookOpen',
    color: 'text-orange-500',
  },
  // 注意：mistake 类型已移除，因为是旧版聊天记录
  exam: {
    labelKey: 'learningHub:resourceType.exam',
    icon: 'ClipboardList',
    color: 'text-green-500',
  },
  // ★ 2025-12-07: 添加 translation 和 essay 以支持内置文件夹
  translation: {
    labelKey: 'learningHub:resourceType.translation',
    icon: 'Languages',
    color: 'text-purple-500',
  },
  essay: {
    labelKey: 'learningHub:resourceType.essay',
    icon: 'PenTool',
    color: 'text-pink-500',
  },
  // ★ 2025-12-09: 添加 image 和 file 以支持附件资源
  image: {
    labelKey: 'learningHub:resourceType.image',
    icon: 'Image',
    color: 'text-cyan-500',
  },
  file: {
    labelKey: 'learningHub:resourceType.file',
    icon: 'File',
    color: 'text-gray-500',
  },
  mindmap: {
    labelKey: 'learningHub:resourceType.mindmap',
    icon: 'Workflow',
    color: 'text-indigo-500',
  },
};

/**
 * 数据视图配置
 */
export const DATA_VIEW_CONFIG: Record<
  DataView,
  {
    labelKey: string;
    icon: string;
  }
> = {
  folder: {
    labelKey: 'learningHub:dataView.folder',
    icon: 'Folder',
  },
  resource: {
    labelKey: 'learningHub:dataView.resource',
    icon: 'Database',
  },
};

/**
 * 视图模式配置
 */
export const VIEW_MODE_CONFIG: Record<
  ViewMode,
  {
    labelKey: string;
    icon: string;
  }
> = {
  list: {
    labelKey: 'learningHub:viewMode.list',
    icon: 'List',
  },
  grid: {
    labelKey: 'learningHub:viewMode.grid',
    icon: 'Grid3X3',
  },
  columns: {
    labelKey: 'learningHub:viewMode.columns',
    icon: 'Columns',
  },
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * itemType → ResourceType 映射
 */
export function itemTypeToResourceType(itemType: FolderItemType): ResourceType {
  const mapping: Record<FolderItemType, ResourceType> = {
    note: 'note',
    textbook: 'textbook',
    exam: 'exam',
    translation: 'translation',
    essay: 'essay',
    // ★ 2025-12-09: 添加 image 和 file
    image: 'image',
    file: 'file',
    mindmap: 'mindmap',
  };
  return mapping[itemType] || 'note';
}

/**
 * itemType → previewType 映射
 */
export function itemTypeToPreviewType(itemType: FolderItemType): ResourceListItem['previewType'] {
  const mapping: Record<FolderItemType, ResourceListItem['previewType']> = {
    note: 'markdown',
    textbook: 'pdf',
    exam: 'exam',
    translation: 'markdown',
    essay: 'markdown',
    // ★ 2025-12-09: 添加 image 和 file
    image: 'image',
    file: 'none',
    // ★ 2026-01-30: 修复 mindmap 预览类型，与后端对齐
    mindmap: 'mindmap',
  };
  return mapping[itemType] || 'none';
}

/**
 * 文本预览可识别的扩展名（用于 file 资源兜底推断）。
 * ★ 2026-07-19（B6）：补充常见代码扩展名与 tsv——这类文件的 MIME 常被标为
 * application/octet-stream，此前不在列表中会被误判为"无法预览"。
 */
const TEXT_PREVIEW_EXTENSIONS = new Set([
  // 纯文本 / 文档
  'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'tsv', 'json', 'xml', 'rtf',
  'log', 'tex',
  // 后端可提取文本的老格式电子表格
  'xls', 'xlsb', 'ods',
  // 配置 / 数据
  'jsonc', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties',
  // 代码
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'less',
  'py', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hh', 'cs',
  'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'rb', 'php', 'swift', 'lua',
  'vue', 'svelte', 'graphql', 'diff', 'patch', 'dockerfile', 'makefile',
]);

/**
 * 从文件名推断预览类型（用于 file 资源兜底）
 */
export function inferFilePreviewTypeFromName(fileName: string): ResourceListItem['previewType'] {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  if (!ext) return 'none';

  if (ext === 'pdf') return 'pdf';
  // ★ 2026-06-12（审阅问题 R3）：富文档渲染仅限 OOXML 格式。
  // 老格式（doc/xls/xlsb/ods/ppt）前端渲染库（docx-preview/ExcelJS/pptx-preview）
  // 一律解析失败：xls/xlsb/ods 降级为 text（后端可提取文本），
  // doc/ppt 后端也无法解析 → none（提示下载打开）。
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'epub') return 'epub';

  // 文本判定先于音视频：'ts' 等扩展名两边都认识，按 TypeScript 而非 MPEG-TS 处理
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) {
    return 'text';
  }

  // ★ 单一真源：与播放器的 MIME 映射表（mediaPreviewUtils）同一套扩展名集合，
  // 避免"推断说不可预览、播放器其实认识"的两处漂移
  if (AUDIO_PREVIEW_EXTENSIONS.has(ext)) {
    return 'audio';
  }

  if (VIDEO_PREVIEW_EXTENSIONS.has(ext)) {
    return 'video';
  }

  return 'none';
}

/**
 * DSTU node.type → 文件夹 itemType 映射
 * 返回 null 表示不支持作为 Learning Hub 资源项打开
 */
export function nodeTypeToFolderItemType(nodeType: DstuNodeType): FolderItemType | null {
  const mapping: Partial<Record<DstuNodeType, FolderItemType>> = {
    note: 'note',
    textbook: 'textbook',
    exam: 'exam',
    translation: 'translation',
    essay: 'essay',
    image: 'image',
    file: 'file',
    mindmap: 'mindmap',
  };

  return mapping[nodeType] ?? null;
}

/**
 * DSTU node.type → FolderItemType（带 'note' 兜底）
 *
 * LearningHubSidebar 打开 / 右键菜单 / 拖拽移动 / 批量移动等处共用，
 * 避免各处手写 switch 漂移（历史上右键菜单分支曾漏掉 image/file）。
 * 不支持的类型（folder / retrieval）回退为 'note'。
 */
export function mapDstuTypeToFolderItemType(nodeType: DstuNodeType): FolderItemType {
  return nodeTypeToFolderItemType(nodeType) ?? 'note';
}

const VALID_PREVIEW_TYPES: Set<ResourceListItem['previewType']> = new Set([
  'markdown',
  'pdf',
  'image',
  'exam',
  'none',
  'docx',
  'xlsx',
  'pptx',
  'epub',
  'text',
  'audio',
  'video',
  'mindmap',
]);

/**
 * 规范化 previewType（兼容旧 card 值）
 */
export function normalizePreviewType(previewType?: string): ResourceListItem['previewType'] | undefined {
  if (!previewType) return undefined;

  const normalized = previewType === 'card' ? 'exam' : previewType;
  if (VALID_PREVIEW_TYPES.has(normalized as ResourceListItem['previewType'])) {
    return normalized as ResourceListItem['previewType'];
  }
  return undefined;
}

/**
 * itemType → sourceDb 映射
 */
export function itemTypeToSourceDb(itemType: FolderItemType): ResourceListItem['sourceDb'] {
  const mapping: Record<FolderItemType, ResourceListItem['sourceDb']> = {
    note: 'notes',
    textbook: 'textbooks',
    exam: 'exam_sessions',
    translation: 'translations',
    essay: 'essays',
    // ★ 2025-12-09: 添加 image 和 file
    image: 'attachments',
    file: 'attachments',
    mindmap: 'mindmaps',
  };
  return mapping[itemType] || 'notes';
}

/**
 * 将 DstuNode 转换为 ResourceListItem
 */
export function dstuNodeToResourceListItem(
  node: DstuNode,
  itemType: FolderItemType
): ResourceListItem {
  const normalizedPreviewType = normalizePreviewType(node.previewType);
  const inferredFilePreviewType = itemType === 'file'
    ? inferFilePreviewTypeFromName(node.name || '')
    : undefined;
  const effectivePreviewType = normalizedPreviewType === 'none' ? undefined : normalizedPreviewType;

  return {
    id: node.id,
    title: node.name || node.id,
    type: itemTypeToResourceType(itemType),
    previewType: effectivePreviewType || inferredFilePreviewType || itemTypeToPreviewType(itemType),
    updatedAt: node.updatedAt,
    createdAt: node.createdAt,
    sourceDb: itemTypeToSourceDb(itemType),
    // 教材专属字段
    path: node.path,
    size: node.size,
    // 从 metadata 提取更多信息
    ...(node.metadata?.isFavorite !== undefined && { isFavorite: Boolean(node.metadata.isFavorite) }),
    ...(node.metadata?.contentPreview && { contentPreview: String(node.metadata.contentPreview) }),
  };
}
