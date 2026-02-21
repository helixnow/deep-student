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

import type { ContextRef } from '@/chat-v2/context/types';
import type { ReferenceNode } from '@/components/notes/types/reference';
import type { FolderItemType, VfsFolderItem } from '@/dstu/types/folder';
import type { DstuNode, DstuNodeType } from '@/dstu/types';

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
 * - list: 列表视图（复用 DndFileTree）
 * - grid: 图标/网格视图
 */
export type ViewMode = 'list' | 'grid';

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
  previewType: 'markdown' | 'pdf' | 'image' | 'exam' | 'none' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'audio' | 'video' | 'mindmap';
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
  /** ★ 移动端底部内边距（给底部导航栏留空间），状态栏贴底 */
  mobileBottomPadding?: boolean;
  /** ★ 是否有应用面板打开 */
  hasOpenApp?: boolean;
  /** ★ 关闭应用面板回调 */
  onCloseApp?: () => void;
  /** ★ 隐藏顶部工具栏和导航栏（移动端聊天内嵌模式使用，由外部容器提供面包屑） */
  hideToolbarAndNav?: boolean;
  /** ★ 高亮标记的资源 ID（如分组已关联的资源，显示勾选状态） */
  highlightedIds?: Set<string>;
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

/**
 * Toolbar 工具栏 Props
 */
export interface LearningHubToolbarProps {
  /** 工作模式 */
  mode: WorkMode;
  /** 当前视图模式 */
  viewMode: ViewMode;
  /** 当前数据视图 */
  dataView: DataView;
  /** 搜索关键词 */
  searchQuery: string;
  /** 搜索关键词变更回调 */
  onSearchChange: (query: string) => void;
  /** 视图模式切换回调 */
  onViewModeChange: (mode: ViewMode) => void;
  /** 数据视图切换回调 */
  onDataViewChange: (view: DataView) => void;
  /** 资源类型过滤（资源浏览视图） */
  resourceTypeFilter?: ResourceType;
  /** 资源类型过滤变更回调 */
  onResourceTypeFilterChange?: (type: ResourceType) => void;
  /** 排序字段 */
  sortField?: SortField;
  /** 排序方向 */
  sortOrder?: SortOrder;
  /** 排序变更回调 */
  onSortChange?: (field: SortField, order: SortOrder) => void;
  /** 刷新回调 */
  onRefresh?: () => void;
  /** 关闭回调（Canvas 模式） */
  onClose?: () => void;
  /** 教材导入回调 */
  onImportTextbook?: () => void;
  /** 是否正在导入教材 */
  isImporting?: boolean;
  /** 是否正在加载 */
  isLoading?: boolean;
  /** 自定义样式 */
  className?: string;
  
  // ========== 面包屑导航（文件夹视图） ==========
  /** 面包屑路径 */
  breadcrumbPath?: BreadcrumbItem[];
  /** 导航到文件夹回调 */
  onNavigateToFolder?: (folderId: string | null) => void;
  
  // ========== 多选模式（2025-12-08 新增） ==========
  /** 是否处于多选模式 */
  isMultiSelectMode?: boolean;
  /** 切换多选模式回调 */
  onToggleMultiSelect?: () => void;
  /** 是否显示回收站 */
  showTrash?: boolean;
  /** 切换回收站显示回调 */
  onToggleTrash?: () => void;
}

/**
 * ActionBar 操作栏 Props
 */
export interface LearningHubActionBarProps {
  /** 选中的资源项 */
  selectedItem: ResourceListItem | null;
  /** 引用节点（如果选中的是引用节点） */
  referenceNode?: ReferenceNode;
  /** 资源总数（用于底部状态栏显示） */
  itemCount?: number;
  /** 是否可以引用到对话 */
  canReferenceToChat: boolean;
  /** 引用到对话回调 */
  onReferenceToChat: () => void;
  /** 预览回调 */
  onPreview?: () => void;
  /** 是否正在加载 */
  isLoading?: boolean;
  /** 自定义样式 */
  className?: string;
}

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
 * 从文件名推断预览类型（用于 file 资源兜底）
 */
export function inferFilePreviewTypeFromName(fileName: string): ResourceListItem['previewType'] {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  if (!ext) return 'none';

  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (['xlsx', 'xls', 'xlsb', 'ods'].includes(ext)) return 'xlsx';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';

  if (['txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json', 'xml', 'rtf', 'epub'].includes(ext)) {
    return 'text';
  }

  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'].includes(ext)) {
    return 'audio';
  }

  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'].includes(ext)) {
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

const VALID_PREVIEW_TYPES: Set<ResourceListItem['previewType']> = new Set([
  'markdown',
  'pdf',
  'image',
  'exam',
  'none',
  'docx',
  'xlsx',
  'pptx',
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
