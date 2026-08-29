import { create } from 'zustand';
import { useStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { useSyncExternalStore } from 'react';
import type { DstuNode, DstuNodeType, DstuListOptions } from '@/dstu/types';
import { dstu } from '@/dstu/api';
import { folderApi, trashApi } from '@/dstu';
import type { BreadcrumbItem as BackendBreadcrumbItem } from '@/dstu/api/folderApi';
import { reportError, type VfsError } from '@/shared/result';
import i18n from '@/i18n';
import type { FinderViewKind, QuickAccessType } from '../learningHubContracts';
import { getQuickAccessTarget } from '../learningHubContracts';
import { getViewKindFromFolderId, isRealFolderId, isSpecialViewFolderId } from '../viewGuards';
import {
  TRASH_RESOURCE_TYPE_MAP,
  isResultTruncated,
  matchesLiveName,
} from '../utils/searchHonesty';
import { pruneSelectionAgainstItems } from './selectionPrune';

/** 视图模式（columns = Finder 分栏视图，仅桌面全屏宿主使用） */
export type ViewMode = 'grid' | 'list' | 'columns';

/** 排序方式（size 为纯前端排序字段，后端列表选项会映射为 name） */
export type SortBy = 'name' | 'updatedAt' | 'createdAt' | 'type' | 'size';
export type SortOrder = 'asc' | 'desc';

export type { QuickAccessType } from '../learningHubContracts';

/** 面包屑项 */
export interface BreadcrumbItem {
  /** 文件夹 ID */
  id: string;
  /** 文件夹名称 */
  name: string;
  /** 
   * 该层级的完整路径（仅用于 UI 显示）
   * @deprecated P2 阶段将从后端 path 解析，移除前端维护 
   */
  dstuPath: string;
}

/**
 * 对资源列表进行排序
 *
 * 对齐访达心智：任何排序字段下文件夹始终置顶（不随升降序翻转），
 * 组内再按字段 + 方向排序。导出供测试断言。
 *
 * @param items 待排序的资源列表
 * @param sortBy 排序字段
 * @param sortOrder 排序顺序
 * @returns 排序后的列表
 */
export function sortItems(items: DstuNode[], sortBy: SortBy, sortOrder: SortOrder): DstuNode[] {
  const compareField = (a: DstuNode, b: DstuNode): number => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name, i18n.language || 'en-US');
      case 'updatedAt':
        return new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
      case 'createdAt':
        return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      case 'type':
        return a.type.localeCompare(b.type);
      case 'size':
        // 文件夹按子项数、文件按字节数；缺失视为 0
        return (a.type === 'folder' ? (a.childCount ?? 0) : (a.size ?? 0))
          - (b.type === 'folder' ? (b.childCount ?? 0) : (b.size ?? 0));
      default:
        return 0;
    }
  };

  return [...items].sort((a, b) => {
    // 文件夹永远排在文件前（访达默认「文件夹置顶」）
    const aIsFolder = a.type === 'folder';
    const bIsFolder = b.type === 'folder';
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;

    const compareResult = compareField(a, b);
    const ordered = sortOrder === 'asc' ? compareResult : -compareResult;
    // 稳定回退：主键相等时按名称，避免等值项抖动
    return ordered !== 0
      ? ordered
      : a.name.localeCompare(b.name, i18n.language || 'en-US');
  });
}

/**
 * 比较两次列表结果是否在 UI 上等价。
 * 用于静默刷新：无差异时跳过 `set({ items })`，避免无效重渲染。
 */
export function areFinderItemsEquivalent(a: DstuNode[], b: DstuNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.path !== right.path ||
      left.name !== right.name ||
      left.type !== right.type ||
      left.size !== right.size ||
      left.createdAt !== right.createdAt ||
      left.updatedAt !== right.updatedAt ||
      left.childCount !== right.childCount ||
      left.previewType !== right.previewType ||
      left.resourceHash !== right.resourceHash ||
      left.sourceId !== right.sourceId ||
      Boolean(left.metadata?.isFavorite) !== Boolean(right.metadata?.isFavorite)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * ★ 2025-12-27 修复：从后端获取面包屑数据（包含真实 ID 链）
 *
 * 使用后端 dstu_folder_get_breadcrumbs API，返回从根到当前文件夹的完整路径，
 * 每个层级都包含真实的 folderId，解决了点击面包屑中间层导航失败的问题。
 *
 * @param folderId 文件夹 ID
 * @returns BreadcrumbItem 数组（包含 dstuPath）
 */
async function fetchBreadcrumbs(folderId: string): Promise<BreadcrumbItem[]> {
  // 特殊文件夹（root, trash）不需要调用后端 API
  if (isSpecialViewFolderId(folderId)) {
    return [];
  }

  const result = await folderApi.getBreadcrumbs(folderId);

  if (!result.ok) {
    reportError(result.error, '获取面包屑');
    return [];
  }

  // 后端返回的是 { id, name }[]，需要补充 dstuPath
  // 将后端格式转换为前端 BreadcrumbItem 格式（添加 dstuPath）
  const breadcrumbsFromBackend: BackendBreadcrumbItem[] = result.value;
  const breadcrumbs: BreadcrumbItem[] = [];
  let accumulatedPath = '';

  for (const item of breadcrumbsFromBackend) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${item.name}` : item.name;
    breadcrumbs.push({
      id: item.id,
      name: item.name,
      dstuPath: `/${accumulatedPath}`,
    });
  }

  return breadcrumbs;
}

/** 导航路径
 * 
 * ## 文件夹优先模型（27-DSTU统一虚拟路径架构改造设计.md）
 * - `folderId`: 文件夹导航模式，列出该文件夹下的所有资源（混合类型）
 * - `typeFilter`: 智能文件夹模式，按类型筛选资源
 * - ★ 调用后端时使用 `getDstuListOptions()`，不要直接使用 dstuPath
 * 
 */
export interface FinderPath {
  /** 当前视图语义 */
  viewKind: FinderViewKind;
  /** 面包屑显示名称数组，每个项包含完整路径 */
  breadcrumbs: BreadcrumbItem[];
  /** 当前真实文件夹 ID；根目录为 null */
  folderId: string | null;
  /** 类型筛选（智能文件夹模式） */
  typeFilter: DstuNodeType | null;
}

export type QueryItemsForPathResult =
  | { ok: true; value: DstuNode[] }
  | { ok: false; error: VfsError };

/** 内联编辑状态 */
export interface InlineEditState {
  /** 正在编辑的项 ID */
  editingId: string | null;
  /** 编辑类型：文件夹或资源 */
  editingType: 'folder' | 'resource' | null;
  /** 原始名称（用于取消时恢复） */
  originalName: string;
}

interface FinderState {
  // ========== 导航状态 ==========
  /** 当前路径 */
  currentPath: FinderPath;
  /** 历史记录栈 */
  history: FinderPath[];
  /** 当前历史索引 */
  historyIndex: number;
  
  // ========== 视图状态 ==========
  /** 视图模式 */
  viewMode: ViewMode;
  /** 排序方式 */
  sortBy: SortBy;
  /** 排序顺序 */
  sortOrder: SortOrder;
  /** 快捷入口是否折叠 */
  quickAccessCollapsed: boolean;
  
  // ========== 选择状态 ==========
  /** 选中的项 ID 集合 */
  selectedIds: Set<string>;
  /** 最后选中的项（用于 Shift 范围选择） */
  lastSelectedId: string | null;
  
  // ========== 搜索状态 ==========
  /** 搜索关键词 */
  searchQuery: string;
  /** 是否正在搜索 */
  isSearching: boolean;
  /** 搜索截断元数据（诚实提示用；非搜索时为 null） */
  searchMeta: { truncated: boolean; limit: number } | null;
  
  // ========== 数据状态 ==========
  /** 当前目录内容 */
  items: DstuNode[];
  /** 加载状态 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  
  // ========== 请求取消状态 ==========
  /** 
   * ★ 当前请求 ID（用于取消过期请求）
   * 每次发起新请求时递增，请求完成时检查是否匹配当前 ID
   * 如果不匹配说明有更新的请求，应丢弃结果
   */
  _currentRequestId: number;
  
  // ========== 内联编辑状态 ==========
  /** 内联编辑状态 */
  inlineEdit: InlineEditState;
  
  // ========== Actions ==========
  /** 导航到指定路径 */
  navigateTo: (path: FinderPath) => void;
  /** 进入文件夹
   * ★ 2025-12-27 修复：改为异步方法，从后端获取真实的面包屑 ID 链
   * @param folderId 文件夹 ID
   * @param folderName 文件夹名称（可选，用于降级显示）
   * @param folderPath 文件夹完整路径（已废弃，保留用于兼容）
   */
  enterFolder: (folderId: string, folderName?: string, folderPath?: string) => Promise<void>;
  /** 返回上级 */
  goUp: () => void;
  /** 历史后退 */
  goBack: () => void;
  /** 历史前进 */
  goForward: () => void;
  /** 跳转到面包屑位置 */
  jumpToBreadcrumb: (index: number) => void;
  
  /** 切换视图模式 */
  setViewMode: (mode: ViewMode) => void;
  /** 设置排序 */
  setSorting: (sortBy: SortBy, sortOrder?: SortOrder) => void;
  
  /** 选择项 */
  select: (id: string, mode: 'single' | 'toggle' | 'range') => void;
  /** 全选 */
  selectAll: () => void;
  /** 清空选择 */
  clearSelection: () => void;
  /** 设置选中项（用于部分成功后保留失败项） */
  setSelectedIds: (ids: Set<string>) => void;

  /** 设置搜索 */
  setSearchQuery: (query: string) => void;
  /** 执行搜索 */
  executeSearch: (opts?: { silent?: boolean }) => Promise<void>;
  
  /**
   * 刷新当前目录
   * @param opts.silent 静默刷新（stale-while-revalidate）：保留当前列表展示，
   *                    数据到达后若与现有列表等价则跳过写入，否则原地替换；
   *                    不显示 loading 骨架、不打断浏览/选择
   */
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  /** 查询指定路径的内容，不改变全局路径或列表状态。 */
  queryItemsForPath: (path: FinderPath) => Promise<QueryItemsForPathResult>;
  /** 加载目录内容 */
  loadItems: (opts?: { silent?: boolean }) => Promise<void>;
  
  /** ★ 2026-01-15: 设置当前路径但不添加历史记录（用于外部同步） */
  setCurrentPathWithoutHistory: (folderId: string | null) => Promise<void>;
  
  /** 设置当前目录内容（主要用于 Mock 或从外部加载） */
  setItems: (items: DstuNode[]) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;

  /** 快捷入口点击（智能文件夹模式） */
  quickAccessNavigate: (type: QuickAccessType) => void;
  
  /** ★ 获取当前路径的 DSTU 列表选项（文件夹优先模式） */
  getDstuListOptions: () => DstuListOptions;
  
  /** 重置状态 */
  reset: () => void;
  
  // ========== 内联编辑 Actions ==========
  /** 开始内联编辑 */
  startInlineEdit: (id: string, type: 'folder' | 'resource', name: string) => void;
  /** 取消内联编辑 */
  cancelInlineEdit: () => void;
  /** 检查是否正在编辑指定项 */
  isEditingItem: (id: string) => boolean;
}

const DEFAULT_PATH: FinderPath = {
  viewKind: 'folder',
  breadcrumbs: [],
  folderId: null,
  typeFilter: null,
};

export function createFinderPath(overrides: Partial<FinderPath> = {}): FinderPath {
  return {
    viewKind: 'folder',
    breadcrumbs: [],
    folderId: null,
    typeFilter: null,
    ...overrides,
  };
}

function getDstuListOptionsForPath(
  path: FinderPath,
  sortBy: SortBy,
  sortOrder: SortOrder,
): DstuListOptions {
  const options: DstuListOptions = {
    // type / size 为纯前端排序字段（后端仅支持 name/createdAt/updatedAt），
    // 传给后端时降级为 name，真实排序由 sortItems 在前端完成
    sortBy: sortBy === 'type' || sortBy === 'size' ? 'name' : sortBy,
    sortOrder,
  };

  if (path.viewKind === 'folder' && isRealFolderId(path.folderId)) {
    options.folderId = path.folderId;
  }
  if (path.typeFilter) {
    options.typeFilter = path.typeFilter;
  }
  if (path.viewKind === 'favorites') {
    options.isFavorite = true;
  }
  return options;
}

/** 历史记录最大条数，防止内存无限增长 */
const MAX_HISTORY_SIZE = 100;

// ============================================================================
// LH-HOST：按宿主分桶
// ============================================================================

/**
 * 默认桶标识。
 *
 * 旧实现只有一个全局单例，持久化键为 `learning-hub-finder`；default 桶沿用该键，
 * 因此升级后旧数据自动落在 default 桶（无需额外迁移步骤）。
 */
export const DEFAULT_FINDER_HOST_ID = 'default';

/** 持久化键前缀（default 桶不带后缀，等于旧单例键） */
export const FINDER_PERSIST_KEY_PREFIX = 'learning-hub-finder';

/**
 * 全部访达宿主标识。
 *
 * 宿主方（渲染 `LearningHubSidebar` 的页面）与读取方（顶栏面包屑等）必须引用同一
 * 个常量，否则会重新退化成「读到别人桶」的串台问题。
 */
export const FINDER_HOST_IDS = {
  /** workbench Files 窗口 */
  files: 'files',
  /** 学习中心页（桌面） */
  page: 'page',
  /** 学习中心页（移动端） */
  pageMobile: 'page-mobile',
  /** Chat 画布侧的资源库（桌面） */
  canvas: 'canvas',
  /** Chat 画布侧的资源库（移动端右屏） */
  canvasMobile: 'canvas-mobile',
  /** 分组编辑器里的资源选择器 */
  groupPicker: 'group-picker',
} as const;

export type FinderHostId = (typeof FINDER_HOST_IDS)[keyof typeof FINDER_HOST_IDS];

/**
 * 与 default 桶共享状态的宿主。
 *
 * workbench Files 窗口的 activation / agent driver / 拖拽与悬浮预览 hook 直接引用
 * `useFinderStore`（即 default 桶），它们不在本次改动范围内，所以 files 宿主继续
 * 落在 default 桶；page / page-mobile / canvas / group-picker 等宿主各自独立。
 */
const HOSTS_SHARING_DEFAULT_BUCKET = new Set<string>([FINDER_HOST_IDS.files]);

/** 把宿主标识解析为实际的桶标识 */
export function resolveFinderHostId(hostId?: string | null): string {
  if (!hostId || HOSTS_SHARING_DEFAULT_BUCKET.has(hostId)) return DEFAULT_FINDER_HOST_ID;
  return hostId;
}

/** 桶对应的持久化键 */
export function finderPersistKey(bucketId: string): string {
  return bucketId === DEFAULT_FINDER_HOST_ID
    ? FINDER_PERSIST_KEY_PREFIX
    : `${FINDER_PERSIST_KEY_PREFIX}:${bucketId}`;
}

/** 持久化的视图偏好（partialize 的形状） */
export interface FinderViewPreferences {
  viewMode: ViewMode;
  sortBy: SortBy;
  sortOrder: SortOrder;
  quickAccessCollapsed: boolean;
}

export const DEFAULT_FINDER_VIEW_PREFERENCES: FinderViewPreferences = {
  viewMode: 'grid',
  sortBy: 'updatedAt',
  sortOrder: 'desc',
  quickAccessCollapsed: false,
};

type PersistStorageLike = Pick<Storage, 'getItem'>;

const FINDER_VIEW_MODES = new Set<ViewMode>(['grid', 'list', 'columns']);
const FINDER_SORT_FIELDS = new Set<SortBy>(['name', 'updatedAt', 'createdAt', 'type', 'size']);
const FINDER_SORT_ORDERS = new Set<SortOrder>(['asc', 'desc']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whitelist persisted Finder preferences at the storage boundary.
 *
 * Zustand's default merge trusts structurally valid JSON. A stale/corrupt value
 * such as `{ viewMode: {} }` would therefore replace the typed initial state
 * after our first read and later crash render/sort paths.
 */
export function sanitizeFinderViewPreferences(input: unknown): Partial<FinderViewPreferences> {
  if (!isRecord(input)) return {};
  const result: Partial<FinderViewPreferences> = {};
  if (FINDER_VIEW_MODES.has(input.viewMode as ViewMode)) {
    result.viewMode = input.viewMode as ViewMode;
  }
  if (FINDER_SORT_FIELDS.has(input.sortBy as SortBy)) {
    result.sortBy = input.sortBy as SortBy;
  }
  if (FINDER_SORT_ORDERS.has(input.sortOrder as SortOrder)) {
    result.sortOrder = input.sortOrder as SortOrder;
  }
  if (typeof input.quickAccessCollapsed === 'boolean') {
    result.quickAccessCollapsed = input.quickAccessCollapsed;
  }
  return result;
}

function readPersistedPreferences(
  storage: PersistStorageLike,
  key: string,
): Partial<FinderViewPreferences> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const preferences = sanitizeFinderViewPreferences(parsed.state);
    return Object.keys(preferences).length > 0 ? preferences : null;
  } catch {
    return null;
  }
}

/**
 * 解析某个桶的初始视图偏好。
 *
 * 本桶尚无数据时回落到旧单例（= default 桶）的偏好，让新分桶的宿主继承用户
 * 已有的视图模式/排序，而不是突然回到出厂默认。
 */
export function resolveInitialViewPreferences(
  bucketId: string,
  storage?: PersistStorageLike | null,
): FinderViewPreferences {
  if (!storage) return { ...DEFAULT_FINDER_VIEW_PREFERENCES };
  const own = readPersistedPreferences(storage, finderPersistKey(bucketId));
  if (own) return { ...DEFAULT_FINDER_VIEW_PREFERENCES, ...own };
  const legacy = bucketId === DEFAULT_FINDER_HOST_ID
    ? null
    : readPersistedPreferences(storage, FINDER_PERSIST_KEY_PREFIX);
  return { ...DEFAULT_FINDER_VIEW_PREFERENCES, ...(legacy ?? {}) };
}

function getDefaultStorage(): PersistStorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export type FinderStoreApi = ReturnType<typeof createFinderStore>;

export function createFinderStore(bucketId: string) {
  const initialPreferences = resolveInitialViewPreferences(bucketId, getDefaultStorage());

  return create<FinderState>()(
  persist(
    (set, get) => ({
      // 导航状态
      currentPath: DEFAULT_PATH,
      history: [DEFAULT_PATH],
      historyIndex: 0,
      
      // 视图状态（本桶无持久化数据时继承旧单例偏好）
      viewMode: initialPreferences.viewMode,
      sortBy: initialPreferences.sortBy,
      sortOrder: initialPreferences.sortOrder,
      quickAccessCollapsed: initialPreferences.quickAccessCollapsed,
      
      // 选择状态
      selectedIds: new Set(),
      lastSelectedId: null,
      
      // 搜索状态
      searchQuery: '',
      isSearching: false,
      searchMeta: null,
      
      // 数据状态
      items: [],
      isLoading: false,
      error: null,
      
      // ★ 请求取消状态
      _currentRequestId: 0,
      
      // 内联编辑状态
      inlineEdit: {
        editingId: null,
        editingType: null,
        originalName: '',
      },
      
      // Actions
      navigateTo: (path: FinderPath) => {
        const { history, historyIndex, _currentRequestId } = get();
        // 截断历史记录，添加新路径
        let newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(path);
        
        // ★ 如果超过上限，移除最旧的记录，防止内存无限增长
        if (newHistory.length > MAX_HISTORY_SIZE) {
          newHistory = newHistory.slice(-MAX_HISTORY_SIZE);
        }
        
        set({
          currentPath: path,
          history: newHistory,
          historyIndex: newHistory.length - 1,
          selectedIds: new Set(),
          lastSelectedId: null,
          searchQuery: '',
          isSearching: false,
          searchMeta: null,
          _currentRequestId: _currentRequestId + 1,
        });
      },
      
      enterFolder: async (folderId: string, folderName?: string, folderPath?: string) => {
        // ★ 先乐观导航再回填面包屑：
        // 旧实现先 await fetchBreadcrumbs 再 navigateTo，慢网络下点击文件夹
        // 会卡在旧目录数百毫秒，且迟到的导航还可能把过期路径压进历史栈。
        // 现在进入立即生效（乐观面包屑 = 当前面包屑 + 该文件夹），
        // 后端真实 ID 链到达后原地回填；期间用户再次导航则丢弃回填。
        const { currentPath } = get();
        const parentCrumbs = currentPath.viewKind === 'folder' ? currentPath.breadcrumbs : [];
        const optimisticName = folderName || folderId;
        const optimisticCrumbs: BreadcrumbItem[] = isSpecialViewFolderId(folderId)
          ? []
          : [
              ...parentCrumbs,
              {
                id: folderId,
                name: optimisticName,
                dstuPath:
                  folderPath ||
                  `${parentCrumbs[parentCrumbs.length - 1]?.dstuPath ?? ''}/${optimisticName}`,
              },
            ];

        const newPath: FinderPath = createFinderPath({
          ...currentPath,
          viewKind: 'folder',
          breadcrumbs: optimisticCrumbs,
          folderId,
          typeFilter: null,
        });
        get().navigateTo(newPath);

        // navigateTo 已递增 _currentRequestId，以此作为本次导航的请求票据
        const requestId = get()._currentRequestId;

        const realBreadcrumbs = await fetchBreadcrumbs(folderId);

        // 过期判定：票据未变 → 期间无任何新导航/加载，直接回填；
        // 票据已变时（同文件夹的 loadItems / 刷新也会递增 ID），退化为
        // 路径判定 —— 仅当用户已离开该文件夹才丢弃回填。
        const { currentPath: pathNow, _currentRequestId: latestRequestId } = get();
        const isStale =
          latestRequestId !== requestId &&
          (pathNow.viewKind !== 'folder' || pathNow.folderId !== folderId);
        if (isStale) return;
        // 后端失败（fetchBreadcrumbs 返回空）时保留乐观面包屑，避免标题闪回根目录
        if (realBreadcrumbs.length === 0) return;

        set((state) => {
          const updatedPath: FinderPath = { ...state.currentPath, breadcrumbs: realBreadcrumbs };
          const history = [...state.history];
          if (history[state.historyIndex]) {
            history[state.historyIndex] = updatedPath;
          }
          return { currentPath: updatedPath, history };
        });
      },
      
      goUp: () => {
        const { currentPath } = get();
        if (currentPath.breadcrumbs.length === 0) return;
        
        const newBreadcrumbs = currentPath.breadcrumbs.slice(0, -1);
        const parentFolder = newBreadcrumbs.length > 0 ? newBreadcrumbs[newBreadcrumbs.length - 1] : null;

        const newPath: FinderPath = createFinderPath({
          ...currentPath,
          viewKind: 'folder',
          breadcrumbs: newBreadcrumbs,
          folderId: parentFolder ? parentFolder.id : null,
          typeFilter: null,
        });
        
        get().navigateTo(newPath);
      },
      
      goBack: () => {
        const { historyIndex, history, _currentRequestId } = get();
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          set({
            historyIndex: newIndex,
            currentPath: history[newIndex],
            selectedIds: new Set(),
            lastSelectedId: null,
            searchQuery: '',
            isSearching: false,
            searchMeta: null,
            _currentRequestId: _currentRequestId + 1,
          });
        }
      },
      
      goForward: () => {
        const { historyIndex, history, _currentRequestId } = get();
        if (historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          set({
            historyIndex: newIndex,
            currentPath: history[newIndex],
            selectedIds: new Set(),
            lastSelectedId: null,
            searchQuery: '',
            isSearching: false,
            searchMeta: null,
            _currentRequestId: _currentRequestId + 1,
          });
        }
      },
      
      // ★ 2026-01-15: 设置当前路径但不添加历史记录（用于外部同步）
      // 解决 NavigationContext 和 finderStore 两个历史栈互相干扰导致的循环问题
      setCurrentPathWithoutHistory: async (folderId: string | null) => {
        const normalizedFolderId = folderId === 'root' || folderId == null ? null : folderId;
        const viewKind = getViewKindFromFolderId(normalizedFolderId);
        
        // 如果已经是当前路径，跳过
        const { currentPath, _currentRequestId } = get();
        if (currentPath.folderId === normalizedFolderId && currentPath.viewKind === viewKind) {
          return;
        }
        
        // Invalidate any current search/load before awaiting breadcrumbs.
        set({ _currentRequestId: _currentRequestId + 1 });

        // 获取面包屑
        const newBreadcrumbs = normalizedFolderId && isRealFolderId(normalizedFolderId)
          ? await fetchBreadcrumbs(normalizedFolderId)
          : [];
        
        // 直接设置当前路径，不添加历史记录
        set({
          currentPath: createFinderPath({
            ...currentPath,
            viewKind,
            breadcrumbs: newBreadcrumbs,
            folderId: viewKind === 'folder' ? normalizedFolderId : null,
            typeFilter: null,
          }),
          selectedIds: new Set(),
          lastSelectedId: null,
          searchQuery: '',
          isSearching: false,
          searchMeta: null,
          _currentRequestId: get()._currentRequestId,
        });
      },
      
      jumpToBreadcrumb: (index: number) => {
        const { currentPath } = get();

        // ★ 2025-12-31: 支持 index = -1 表示跳转到根目录
        if (index === -1) {
          const rootPath: FinderPath = createFinderPath();
          get().navigateTo(rootPath);
          return;
        }

        if (index >= currentPath.breadcrumbs.length) return;

        // 如果点击的是最后一个（当前），不做任何事
        if (index === currentPath.breadcrumbs.length - 1) return;

        const newBreadcrumbs = currentPath.breadcrumbs.slice(0, index + 1);
        const targetBreadcrumb = newBreadcrumbs[index];

        // 使用 breadcrumb 中保存的完整路径
        const newPath: FinderPath = createFinderPath({
          ...currentPath,
          viewKind: 'folder',
          breadcrumbs: newBreadcrumbs,
          folderId: targetBreadcrumb.id,
          typeFilter: null,
        });
        get().navigateTo(newPath);
      },
      
      setViewMode: (mode: ViewMode) => set({ viewMode: mode }),
      
      setSorting: (sortBy: SortBy, sortOrder?: SortOrder) => {
        const currentOrder = get().sortOrder;
        set({
          sortBy,
          sortOrder: sortOrder || (sortBy === get().sortBy && currentOrder === 'asc' ? 'desc' : 'asc'),
        });
        get().refresh();
      },
      
      select: (id: string, mode: 'single' | 'toggle' | 'range') => {
        const { selectedIds, items, lastSelectedId } = get();
        const newSelected = new Set(mode === 'toggle' ? selectedIds : []);
        
        if (mode === 'single') {
          newSelected.add(id);
          set({ selectedIds: newSelected, lastSelectedId: id });
        } else if (mode === 'toggle') {
          if (newSelected.has(id)) {
            newSelected.delete(id);
          } else {
            newSelected.add(id);
          }
          set({ selectedIds: newSelected, lastSelectedId: id });
        } else if (mode === 'range' && lastSelectedId) {
          // 范围选择逻辑
          const lastIndex = items.findIndex(item => item.id === lastSelectedId);
          const currentIndex = items.findIndex(item => item.id === id);
          if (lastIndex !== -1 && currentIndex !== -1) {
            const start = Math.min(lastIndex, currentIndex);
            const end = Math.max(lastIndex, currentIndex);
            const rangeIds = items.slice(start, end + 1).map(item => item.id);
            // 保持之前的选择，添加新的范围
            // 通常范围选择会清除之前的非范围选择，或者基于 shift 键
            // 这里简化为：清除旧的，选中范围
             const rangeSet = new Set<string>();
             rangeIds.forEach(rid => rangeSet.add(rid));
             set({ selectedIds: rangeSet }); // 这里假设 range 是排他的
          } else {
             // Fallback to single select
             const singleSet = new Set<string>();
             singleSet.add(id);
             set({ selectedIds: singleSet, lastSelectedId: id });
          }
        } else {
            // Range but no last selected
             const singleSet = new Set<string>();
             singleSet.add(id);
             set({ selectedIds: singleSet, lastSelectedId: id });
        }
      },
      
      selectAll: () => {
        const { items } = get();
        // 对齐访达：Cmd/Ctrl+A 全选当前视图全部项目（含文件夹）
        // 批量操作侧再按类型过滤不可用项
        set({ selectedIds: new Set(items.map(item => item.id)) });
      },

      clearSelection: () => set({ selectedIds: new Set(), lastSelectedId: null }),

      setSelectedIds: (ids: Set<string>) => set({ selectedIds: ids }),
      
      setSearchQuery: (query: string) => set({
        searchQuery: query,
        isSearching: !!query,
        searchMeta: query.trim() ? get().searchMeta : null,
      }),
      
      executeSearch: async (opts) => {
        const { searchQuery, getDstuListOptions, currentPath, sortBy, sortOrder } = get();
        const options = getDstuListOptions();
        const silent = opts?.silent === true;

        // 如果搜索关键词为空，不执行搜索
        if (!searchQuery.trim()) {
          set({ isSearching: false, searchMeta: null });
          return;
        }

        // ★ 生成新的请求 ID，取消之前的请求
        const requestId = get()._currentRequestId + 1;
        if (silent) {
          set({ isSearching: true, error: null, searchMeta: null, _currentRequestId: requestId });
        } else {
          set({ isSearching: true, isLoading: true, error: null, searchMeta: null, _currentRequestId: requestId });
        }

        // 根据当前路径状态选择搜索方式
        let result;
        let effectiveLimit = options.limit ?? 50;
        let resultsTruncated = false;
        if (currentPath.viewKind === 'indexStatus' || currentPath.viewKind === 'memory' || currentPath.viewKind === 'desktop') {
          result = { ok: true as const, value: [] as DstuNode[] };
        } else if (currentPath.viewKind === 'recent') {
          // hydrate-then-filter：先 dstu.get 再用活名 filter（避免改名后搜新名漏命中）
          const { useRecentStore } = await import('./recentStore');
          let recentItems = useRecentStore.getState().getRecentItems();
          if (currentPath.typeFilter) {
            recentItems = recentItems.filter((item) => item.type === currentPath.typeFilter);
          }

          const hydrated = await Promise.all(
            recentItems.map(async (recent) => {
              let getResult = await dstu.get(recent.path);
              if (!getResult.ok) {
                getResult = await dstu.get(`/${recent.id}`);
              }
              return { recent, node: getResult.ok ? getResult.value : null };
            }),
          );

          const liveNodes: DstuNode[] = [];
          for (const { recent, node } of hydrated) {
            if (!node) {
              useRecentStore.getState().removeRecent(recent.id);
              continue;
            }
            liveNodes.push(node);
          }
          result = {
            ok: true as const,
            value: liveNodes.filter((node) => matchesLiveName(node, searchQuery)),
          };
          effectiveLimit = useRecentStore.getState().maxItems ?? 50;
        } else if (currentPath.viewKind === 'trash') {
          effectiveLimit = options.limit ?? 100;
          const requestLimit = effectiveLimit + 1;
          const trashResult = currentPath.typeFilter && TRASH_RESOURCE_TYPE_MAP[currentPath.typeFilter]
            ? await dstu.listDeleted(
              TRASH_RESOURCE_TYPE_MAP[currentPath.typeFilter],
              requestLimit,
              options.offset,
            )
            : await trashApi.listTrash(requestLimit, options.offset);

          if (trashResult.ok) {
            resultsTruncated = trashResult.value.length > effectiveLimit;
            result = {
              ok: true as const,
              value: trashResult.value
                .filter((item) =>
                  (!currentPath.typeFilter ||
                    TRASH_RESOURCE_TYPE_MAP[currentPath.typeFilter] ||
                    item.type === currentPath.typeFilter) &&
                  matchesLiveName(item, searchQuery),
                )
                .slice(0, effectiveLimit),
            };
          } else {
            result = trashResult;
          }
        } else if (currentPath.viewKind === 'favorites') {
          result = await dstu.search(searchQuery, { ...options, isFavorite: true });
        } else if (isRealFolderId(currentPath.folderId)) {
          result = await dstu.searchInFolder(currentPath.folderId, searchQuery, options);
        } else {
          // 全局搜索
          result = await dstu.search(searchQuery, options);
        }

        // ★ 检查请求是否已过期（有更新的请求发起）
        if (get()._currentRequestId !== requestId) {
          console.log('[finderStore] executeSearch 请求已过期，丢弃结果', { requestId, current: get()._currentRequestId });
          return;
        }

        if (result.ok) {
          // type / size 会在后端查询参数中降级为 name，且 recent / trash
          // 也不保证返回当前排序；所有搜索结果统一在前端按 Finder 规则重排。
          const sortedItems = sortItems(result.value, sortBy, sortOrder);
          const { selectedIds, lastSelectedId, items: previousItems } = get();
          const truncated = currentPath.viewKind === 'trash'
            ? resultsTruncated
            : isResultTruncated(result.value.length, effectiveLimit);
          const searchMeta = { truncated, limit: effectiveLimit };

          // 列表无差异时尽量跳过写入；仅同步 searchMeta / loading 收尾
          if (areFinderItemsEquivalent(previousItems, sortedItems)) {
            const prevMeta = get().searchMeta;
            const metaUnchanged =
              prevMeta?.truncated === searchMeta.truncated &&
              prevMeta?.limit === searchMeta.limit;
            if (get().isLoading || !metaUnchanged) {
              set({
                isSearching: true,
                isLoading: false,
                searchMeta,
              });
            }
            return;
          }

          const pruned = pruneSelectionAgainstItems(selectedIds, sortedItems, lastSelectedId, {
            preserveLastSelectedIfWasSelected: true,
          });
          set({
            items: sortedItems,
            isSearching: true,
            isLoading: false,
            selectedIds: pruned.selectedIds,
            lastSelectedId: pruned.lastSelectedId,
            searchMeta,
          });
        } else {
          reportError(result.error, '搜索资源');
          if (silent) {
            set({
              error: result.error.message,
              isSearching: true,
              isLoading: false,
              searchMeta: null,
            });
            return;
          }
          const { selectedIds, lastSelectedId } = get();
          const pruned = pruneSelectionAgainstItems(selectedIds, [], lastSelectedId, {
            preserveLastSelectedIfWasSelected: true,
          });
          set({
            error: result.error.message,
            isSearching: true,
            isLoading: false,
            items: [],
            selectedIds: pruned.selectedIds,
            lastSelectedId: pruned.lastSelectedId,
            searchMeta: null,
          });
        }
      },
      
      queryItemsForPath: async (path) => {
        const { sortBy, sortOrder } = get();
        const options = getDstuListOptionsForPath(path, sortBy, sortOrder);

        if (path.viewKind === 'indexStatus' || path.viewKind === 'memory' || path.viewKind === 'desktop') {
          return { ok: true, value: [] };
        }

        if (path.viewKind === 'recent') {
          const { useRecentStore } = await import('./recentStore');
          let recentItems = useRecentStore.getState().getRecentItems();
          if (path.typeFilter) {
            recentItems = recentItems.filter((item) => item.type === path.typeFilter);
          }

          const results = await Promise.all(recentItems.map(async (recent) => {
            let result = await dstu.get(recent.path);
            if (!result.ok) result = await dstu.get(`/${recent.id}`);
            return { recent, result };
          }));

          const items: DstuNode[] = [];
          for (const { recent, result } of results) {
            if (result.ok) items.push(result.value);
            else useRecentStore.getState().removeRecent(recent.id);
          }
          return { ok: true, value: items };
        }

        if (path.viewKind === 'trash') {
          const result = path.typeFilter && TRASH_RESOURCE_TYPE_MAP[path.typeFilter]
            ? await dstu.listDeleted(TRASH_RESOURCE_TYPE_MAP[path.typeFilter], options.limit, options.offset)
            : await trashApi.listTrash(options.limit, options.offset);
          if (!result.ok) return result;

          // Unsupported backend resource types (folder/image/file/etc.) are
          // intentionally filtered locally from the complete trash listing.
          return {
            ok: true,
            value: path.typeFilter && !TRASH_RESOURCE_TYPE_MAP[path.typeFilter]
              ? result.value.filter((item) => item.type === path.typeFilter)
              : result.value,
          };
        }

        const result = path.viewKind === 'favorites'
          ? await dstu.list('/', { ...options, isFavorite: true })
          : await dstu.list('/', options);
        return result;
      },

      refresh: async (opts) => {
        const { searchQuery, executeSearch, loadItems } = get();
        if (searchQuery.trim()) {
          await executeSearch(opts);
          return;
        }
        await loadItems(opts);
      },
      
      loadItems: async (opts) => {
        // ★ 2026-06-12（审阅问题 FE-S1）：silent 模式实现 stale-while-revalidate。
        // 文件变更事件触发的后台刷新不再显示 loading 骨架屏，
        // 保留当前列表直至新数据到达后原地替换，避免打断用户浏览。
        // ★ 2026-07-21：结果与现有列表等价时跳过 items 写入，避免无效重渲染。
        const silent = opts?.silent === true;
        // ★ 生成新的请求 ID，取消之前的请求
        const requestId = get()._currentRequestId + 1;
        if (silent) {
          set({ error: null, _currentRequestId: requestId });
        } else {
          set({ isLoading: true, error: null, _currentRequestId: requestId });
        }
        // silent 模式下加载失败时保留现有列表（避免内容闪失）
        const failLoad = (message: string) => {
          if (silent) {
            set({ error: message, isLoading: false });
          } else {
            const { selectedIds, lastSelectedId } = get();
            const pruned = pruneSelectionAgainstItems(selectedIds, [], lastSelectedId, {
              preserveLastSelectedIfWasSelected: true,
            });
            set({
              error: message,
              isLoading: false,
              items: [],
              selectedIds: pruned.selectedIds,
              lastSelectedId: pruned.lastSelectedId,
            });
          }
        };

        const { currentPath, queryItemsForPath } = get();
        const result = await queryItemsForPath(currentPath);

        // 查询期间若已有更新请求，成功和失败结果都必须丢弃。旧实现只在成功
        // 分支检查，导致迟到的失败会清空新视图列表并覆盖其 loading / error。
        if (get()._currentRequestId !== requestId) {
          console.log('[finderStore] loadItems 请求已过期，丢弃结果', { requestId, current: get()._currentRequestId });
          return;
        }

        if (!result.ok && 'error' in result) {
          reportError(result.error, '加载列表');
          failLoad(result.error.message);
          return;
        }
        let items = result.value;

        // 应用前端排序
        const { sortBy, sortOrder, selectedIds, lastSelectedId, items: previousItems } = get();
        items = sortItems(items, sortBy, sortOrder);

        // 列表无差异时跳过 items 写入；仅在仍显示 loading 时收尾
        if (areFinderItemsEquivalent(previousItems, items)) {
          if (get().isLoading) {
            set({ isLoading: false });
          }
          return;
        }

        const pruned = pruneSelectionAgainstItems(selectedIds, items, lastSelectedId, {
          preserveLastSelectedIfWasSelected: true,
        });
        set({
          items,
          isLoading: false,
          selectedIds: pruned.selectedIds,
          lastSelectedId: pruned.lastSelectedId,
        });
      },
      
      setItems: (items: DstuNode[]) => {
        const { selectedIds, lastSelectedId } = get();
        const pruned = pruneSelectionAgainstItems(selectedIds, items, lastSelectedId, {
          preserveLastSelectedIfWasSelected: true,
        });
        set({
          items,
          selectedIds: pruned.selectedIds,
          lastSelectedId: pruned.lastSelectedId,
        });
      },
      setLoading: (isLoading: boolean) => set({ isLoading }),
      setError: (error: string | null) => set({ error }),

      quickAccessNavigate: (type: QuickAccessType) => {
        const { currentPath } = get();
        const target = getQuickAccessTarget(type);
        const newPath: FinderPath = createFinderPath({
          ...currentPath,
          viewKind: target.viewKind,
          breadcrumbs: [],
          folderId: null,
          typeFilter: target.typeFilter,
        });
        get().navigateTo(newPath);
      },
      
      getDstuListOptions: () => {
        // ★ 根据当前路径状态构建 DSTU 列表选项
        const { currentPath, sortBy, sortOrder } = get();
        const options: DstuListOptions = {
          // 同 getDstuListOptionsForPath：type / size 降级为 name（前端排序兜底）
          sortBy: sortBy === 'type' || sortBy === 'size' ? 'name' : sortBy,
          sortOrder,
        };

        // 文件夹导航模式
        if (currentPath.viewKind === 'folder' && isRealFolderId(currentPath.folderId)) {
          options.folderId = currentPath.folderId;
        }

        // 智能文件夹模式（类型筛选）
        if (currentPath.typeFilter) {
          options.typeFilter = currentPath.typeFilter;
        }

        if (currentPath.viewKind === 'favorites') {
          options.isFavorite = true;
        }

        return options;
      },
      
      /**
       * 重置状态
       */
      reset: () => {
          const { _currentRequestId } = get();
          set({
              currentPath: DEFAULT_PATH,
              history: [DEFAULT_PATH],
              historyIndex: 0,
              selectedIds: new Set(),
              lastSelectedId: null,
              searchQuery: '',
              isSearching: false,
              searchMeta: null,
              items: [],
              inlineEdit: {
                editingId: null,
                editingType: null,
                originalName: '',
              },
              _currentRequestId: _currentRequestId + 1,
          })
      },
      
      // 内联编辑 Actions
      startInlineEdit: (id: string, type: 'folder' | 'resource', name: string) => {
        set({
          inlineEdit: {
            editingId: id,
            editingType: type,
            originalName: name,
          },
        });
      },
      
      cancelInlineEdit: () => {
        set({
          inlineEdit: {
            editingId: null,
            editingType: null,
            originalName: '',
          },
        });
      },
      
      isEditingItem: (id: string) => {
        return get().inlineEdit.editingId === id;
      },
    }),
    {
      name: finderPersistKey(bucketId),
      partialize: (state) => ({
        viewMode: state.viewMode,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        quickAccessCollapsed: state.quickAccessCollapsed,
      }),
      // The eager seed above and Zustand's hydration both read the same
      // payload. Keep the second read behind the same whitelist; otherwise the
      // default shallow merge can re-introduce values rejected by migration.
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...sanitizeFinderViewPreferences(persistedState),
      }),
    }
  )
  );
}

const finderStoreRegistry = new Map<string, FinderStoreApi>();

/**
 * 取得某个宿主的 Finder store 实例。
 *
 * 同一宿主永远返回同一实例；不同宿主之间 currentPath / searchQuery /
 * selectedIds / viewMode 完全隔离。
 */
export function getFinderStore(hostId?: string | null): FinderStoreApi {
  const bucketId = resolveFinderHostId(hostId);
  let store = finderStoreRegistry.get(bucketId);
  if (!store) {
    store = createFinderStore(bucketId);
    finderStoreRegistry.set(bucketId, store);
  }
  return store;
}

/** 仅供测试：清空已创建的宿主桶，并把活跃宿主复位到 default */
export function resetFinderStoreRegistryForTests(): void {
  for (const [bucketId, store] of finderStoreRegistry) {
    store.getState().reset();
    if (bucketId !== DEFAULT_FINDER_HOST_ID) finderStoreRegistry.delete(bucketId);
  }
  setActiveFinderHostId(DEFAULT_FINDER_HOST_ID);
}

/** default 桶：保持旧的模块级单例语义，外部（agent driver / Files 窗口）继续直接引用 */
export const useFinderStore = getFinderStore(DEFAULT_FINDER_HOST_ID);

/** 在组件中按宿主取 store（hostId 在一次挂载内通常是常量） */
export function useFinderStoreFor(hostId?: string | null): FinderStoreApi {
  return getFinderStore(hostId);
}

// ============================================================================
// LH-HOST：活跃宿主（供 App 级导航壳层跟随当前可见的访达）
// ============================================================================

let activeFinderHostId = DEFAULT_FINDER_HOST_ID;
const activeFinderHostListeners = new Set<() => void>();

export function getActiveFinderHostId(): string {
  return activeFinderHostId;
}

export function setActiveFinderHostId(hostId?: string | null): void {
  const next = resolveFinderHostId(hostId);
  if (next === activeFinderHostId) return;
  activeFinderHostId = next;
  activeFinderHostListeners.forEach((listener) => listener());
}

function subscribeActiveFinderHost(listener: () => void): () => void {
  activeFinderHostListeners.add(listener);
  return () => {
    activeFinderHostListeners.delete(listener);
  };
}

/**
 * 当前活跃宿主的 store。
 *
 * 全局壳层（如 LearningHubNavigationContext 的前进/后退）没有 hostId 上下文，
 * 跟随最近一次注册为活跃的全屏访达宿主；无人注册时回落 default 桶。
 */
export function useActiveFinderStore(): FinderStoreApi {
  const hostId = useSyncExternalStore(
    subscribeActiveFinderHost,
    getActiveFinderHostId,
    getActiveFinderHostId,
  );
  return getFinderStore(hostId);
}

/** 便捷读取：在活跃宿主 store 上做 selector 订阅 */
export function useActiveFinderState<T>(selector: (state: FinderState) => T): T {
  return useStore(useActiveFinderStore(), selector);
}
