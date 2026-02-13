import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DstuNode, DstuNodeType, DstuListOptions } from '@/dstu/types';
import { dstu } from '@/dstu/api';
import { folderApi, trashApi } from '@/dstu';
import type { BreadcrumbItem as BackendBreadcrumbItem } from '@/dstu/api/folderApi';
import { reportError } from '@/shared/result';
import i18n from '@/i18n';

/** 视图模式 */
export type ViewMode = 'grid' | 'list';

/** 排序方式 */
export type SortBy = 'name' | 'updatedAt' | 'createdAt' | 'type';
export type SortOrder = 'asc' | 'desc';

/** 快捷入口类型 */
// ★ 2025-12-09: 添加 images 和 files 以支持附件资源
// ★ 2025-12-11: 添加 allFiles 以支持查看真实文件夹结构
// ★ 2026-01-15: 添加 indexStatus 以支持向量化状态视图
// ★ 2026-01-19: 添加 memory 以支持 VFS 记忆管理
// ★ 2026-01-31: 添加 desktop 以支持桌面快捷方式
export type QuickAccessType = 'allFiles' | 'favorites' | 'notes' | 'textbooks' | 'exams' | 'essays' | 'translations' | 'images' | 'files' | 'mindmaps' | 'recent' | 'trash' | 'indexStatus' | 'memory' | 'desktop';

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
 * @param items 待排序的资源列表
 * @param sortBy 排序字段
 * @param sortOrder 排序顺序
 * @returns 排序后的列表
 */
function sortItems(items: DstuNode[], sortBy: SortBy, sortOrder: SortOrder): DstuNode[] {
  const sorted = [...items].sort((a, b) => {
    let compareResult = 0;

    switch (sortBy) {
      case 'name':
        compareResult = a.name.localeCompare(b.name, i18n.language || 'en-US');
        break;
      case 'updatedAt':
        compareResult = new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
        break;
      case 'createdAt':
        compareResult = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
        break;
      case 'type':
        // 文件夹优先，然后按类型排序
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        compareResult = a.type.localeCompare(b.type);
        break;
      default:
        compareResult = 0;
    }

    return sortOrder === 'asc' ? compareResult : -compareResult;
  });

  return sorted;
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
  if (folderId === 'root' || folderId === 'trash') {
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
  /** 
   * 完整路径（仅用于显示面包屑，文件夹优先模式下为文件夹路径）
   * 
   * @deprecated 此字段仅用于 UI 显示，调用后端时请使用 `getDstuListOptions()` 
   * 获取 `folderId` + `typeFilter` 参数，不要直接使用 dstuPath 调用 `dstu.list()`
   */
  dstuPath: string;
  /** 面包屑显示名称数组，每个项包含完整路径 */
  breadcrumbs: BreadcrumbItem[];
  /** ★ 当前文件夹 ID（文件夹导航模式）
   * - null 表示根目录
   * - 'root' 表示根目录（全部文件视图）
   * - 'trash' 表示回收站
   * - 'recent' 表示最近文件（前端维护）
   * - 有值时使用 folderId 参数调用后端 */
  folderId: string | null;
  /** ★ 类型筛选（智能文件夹模式）
   * - null 表示不筛选（显示混合类型）
   * - 有值时使用 typeFilter 参数调用后端 */
  typeFilter: DstuNodeType | null;
  /** 
   * 当前筛选的资源类型
   * @deprecated 请使用 `typeFilter` 字段 
   */
  resourceType: DstuNodeType | null;
}

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
  executeSearch: () => Promise<void>;
  
  /** 刷新当前目录 */
  refresh: () => Promise<void>;
  /** 加载目录内容 */
  loadItems: () => Promise<void>;
  
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
  dstuPath: '/',
  breadcrumbs: [],
  folderId: 'root', // ★ 默认显示真实文件夹结构（全部文件视图）
  typeFilter: null,
  resourceType: null,
};

/** 历史记录最大条数，防止内存无限增长 */
const MAX_HISTORY_SIZE = 100;

export const useFinderStore = create<FinderState>()(
  persist(
    (set, get) => ({
      // 导航状态
      currentPath: DEFAULT_PATH,
      history: [DEFAULT_PATH],
      historyIndex: 0,
      
      // 视图状态
      viewMode: 'grid',
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      quickAccessCollapsed: false,
      
      // 选择状态
      selectedIds: new Set(),
      lastSelectedId: null,
      
      // 搜索状态
      searchQuery: '',
      isSearching: false,
      
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
        const { history, historyIndex } = get();
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
        });
      },
      
      enterFolder: async (folderId: string, folderName?: string, folderPath?: string) => {
        // ★ 2025-12-27 修复：从后端获取真实的面包屑 ID 链
        const newBreadcrumbs = await fetchBreadcrumbs(folderId);

        // 计算 dstuPath（从面包屑重建完整路径）
        const newDstuPath = newBreadcrumbs.length > 0
          ? newBreadcrumbs[newBreadcrumbs.length - 1].dstuPath
          : '/';

        const { currentPath } = get();
        const newPath: FinderPath = {
          ...currentPath,
          dstuPath: newDstuPath,
          breadcrumbs: newBreadcrumbs,
          folderId: folderId,
          typeFilter: null, // ★ 进入文件夹后清除类型筛选
          resourceType: null, // 保持兼容
        };
        get().navigateTo(newPath);
      },
      
      goUp: () => {
        const { currentPath } = get();
        if (currentPath.breadcrumbs.length === 0) return;
        
        const newBreadcrumbs = currentPath.breadcrumbs.slice(0, -1);
        const parentFolder = newBreadcrumbs.length > 0 ? newBreadcrumbs[newBreadcrumbs.length - 1] : null;
        
        // 简单的路径回退逻辑，实际可能需要更复杂的路径解析
        const newDstuPath = currentPath.dstuPath.split('/').slice(0, -1).join('/') || '/';
        
        const newPath: FinderPath = {
          ...currentPath,
          dstuPath: newDstuPath,
          breadcrumbs: newBreadcrumbs,
          folderId: parentFolder ? parentFolder.id : null,
        };
        
        get().navigateTo(newPath);
      },
      
      goBack: () => {
        const { historyIndex, history } = get();
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          set({
            historyIndex: newIndex,
            currentPath: history[newIndex],
            selectedIds: new Set(),
            lastSelectedId: null,
          });
        }
      },
      
      goForward: () => {
        const { historyIndex, history } = get();
        if (historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          set({
            historyIndex: newIndex,
            currentPath: history[newIndex],
            selectedIds: new Set(),
            lastSelectedId: null,
          });
        }
      },
      
      // ★ 2026-01-15: 设置当前路径但不添加历史记录（用于外部同步）
      // 解决 NavigationContext 和 finderStore 两个历史栈互相干扰导致的循环问题
      setCurrentPathWithoutHistory: async (folderId: string | null) => {
        // 规范化 folderId
        const normalizedFolderId = (folderId === 'root' || folderId === null || folderId === undefined) 
          ? 'root' 
          : folderId;
        
        // 如果已经是当前路径，跳过
        const { currentPath } = get();
        const currentNormalized = (currentPath.folderId === 'root' || currentPath.folderId === null) 
          ? 'root' 
          : currentPath.folderId;
        if (currentNormalized === normalizedFolderId) {
          return;
        }
        
        // 获取面包屑
        const newBreadcrumbs = normalizedFolderId === 'root' 
          ? [] 
          : await fetchBreadcrumbs(normalizedFolderId);
        
        // 计算路径
        const newDstuPath = newBreadcrumbs.length > 0
          ? newBreadcrumbs[newBreadcrumbs.length - 1].dstuPath
          : '/';
        
        // 直接设置当前路径，不添加历史记录
        set({
          currentPath: {
            ...currentPath,
            dstuPath: newDstuPath,
            breadcrumbs: newBreadcrumbs,
            folderId: normalizedFolderId === 'root' ? 'root' : normalizedFolderId,
            typeFilter: null,
            resourceType: null,
          },
          selectedIds: new Set(),
          lastSelectedId: null,
          searchQuery: '',
          isSearching: false,
        });
      },
      
      jumpToBreadcrumb: (index: number) => {
        const { currentPath } = get();

        // ★ 2025-12-31: 支持 index = -1 表示跳转到根目录
        if (index === -1) {
          const rootPath: FinderPath = {
            dstuPath: '/',
            breadcrumbs: [],
            folderId: 'root',
            typeFilter: null,
            resourceType: null,
          };
          get().navigateTo(rootPath);
          return;
        }

        if (index >= currentPath.breadcrumbs.length) return;

        // 如果点击的是最后一个（当前），不做任何事
        if (index === currentPath.breadcrumbs.length - 1) return;

        const newBreadcrumbs = currentPath.breadcrumbs.slice(0, index + 1);
        const targetBreadcrumb = newBreadcrumbs[index];

        // 使用 breadcrumb 中保存的完整路径
        const newPath: FinderPath = {
          ...currentPath,
          dstuPath: targetBreadcrumb.dstuPath,
          breadcrumbs: newBreadcrumbs,
          folderId: targetBreadcrumb.id,
          typeFilter: null, // ★ 跳转后清除类型筛选
          resourceType: null, // 保持兼容
        };
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
        // 仅选择文件，排除文件夹（文件夹不支持批量操作如删除、移动等）
        const fileIds = new Set(
          items.filter(item => item.type !== 'folder').map(item => item.id)
        );
        set({ selectedIds: fileIds });
      },

      clearSelection: () => set({ selectedIds: new Set(), lastSelectedId: null }),

      setSelectedIds: (ids: Set<string>) => set({ selectedIds: ids }),
      
      setSearchQuery: (query: string) => set({ searchQuery: query, isSearching: !!query }),
      
      executeSearch: async () => {
        const { searchQuery, getDstuListOptions, currentPath } = get();

        // 如果搜索关键词为空，不执行搜索
        if (!searchQuery.trim()) {
          set({ isSearching: false });
          return;
        }

        // ★ 生成新的请求 ID，取消之前的请求
        const requestId = get()._currentRequestId + 1;
        set({ isSearching: true, isLoading: true, error: null, _currentRequestId: requestId });

        // 根据当前路径状态选择搜索方式
        let result;
        if (currentPath.folderId && currentPath.folderId !== 'root' && currentPath.folderId !== 'trash') {
          // 在特定文件夹内搜索
          const options = getDstuListOptions();
          result = await dstu.searchInFolder(currentPath.folderId, searchQuery, options);
        } else {
          // 全局搜索
          const options = getDstuListOptions();
          result = await dstu.search(searchQuery, options);
        }

        // ★ 检查请求是否已过期（有更新的请求发起）
        if (get()._currentRequestId !== requestId) {
          console.log('[finderStore] executeSearch 请求已过期，丢弃结果', { requestId, current: get()._currentRequestId });
          return;
        }

        if (result.ok) {
          set({
            items: result.value,
            isSearching: false,
            isLoading: false
          });
        } else {
          reportError(result.error, '搜索资源');
          set({
            error: result.error.message,
            isSearching: false,
            isLoading: false,
            items: []
          });
        }
      },
      
      refresh: async () => {
        const { loadItems } = get();
        await loadItems();
      },
      
      loadItems: async () => {
        // ★ 生成新的请求 ID，取消之前的请求
        const requestId = get()._currentRequestId + 1;
        set({ isLoading: true, error: null, _currentRequestId: requestId });

        const { currentPath, getDstuListOptions } = get();
        let items: DstuNode[] = [];

        // 获取统一的列表选项（包含排序、筛选等）
        const options = getDstuListOptions();

        // 根据当前路径状态选择不同的加载方式
        if (currentPath.folderId === 'recent') {
          // ★ 最近文件模式：从前端存储加载访问记录
          const { useRecentStore } = await import('./recentStore');
          let recentItems = useRecentStore.getState().getRecentItems();

          // ★ 修复1: 支持类型筛选（前端筛选，避免加载不需要的资源）
          if (currentPath.typeFilter) {
            recentItems = recentItems.filter(item => item.type === currentPath.typeFilter);
          }

          // ★ 修复2: 并发加载提升性能（而非串行 for 循环）
          const results = await Promise.all(
            recentItems.map(async (recent) => {
              // ★ 修复3: 优先用 path，失败则用 ID 重试（处理资源移动场景）
              let result = await dstu.get(recent.path);
              if (!result.ok) {
                // 降级：尝试用 ID 构造路径重试
                result = await dstu.get(`/${recent.id}`);
              }
              return { recent, result };
            })
          );

          // 提取成功的资源，清理失效记录
          const nodes: DstuNode[] = [];
          for (const { recent, result } of results) {
            if (result.ok) {
              nodes.push(result.value);
            } else {
              // 如果资源已被删除或不存在，从最近记录中移除
              console.warn('[finderStore] 最近文件已不存在，从记录中移除:', recent.path, recent.id);
              useRecentStore.getState().removeRecent(recent.id);
            }
          }

          items = nodes;
        } else if (currentPath.folderId === 'trash') {
          // ★ 回收站模式：加载已删除的资源
          // 将DstuNodeType映射到资源类型字符串
          const resourceTypeMap: Record<string, string> = {
            note: 'notes',
            textbook: 'textbooks',
            exam: 'exams',
            essay: 'essays',
            translation: 'translations',
            image: 'images',
            file: 'files',
            folder: 'folders',
            retrieval: 'retrieval',
            mindmap: 'mindmaps',
          };
          if (currentPath.typeFilter && resourceTypeMap[currentPath.typeFilter]) {
            const resourceType = resourceTypeMap[currentPath.typeFilter];
            const result = await dstu.listDeleted(resourceType, options.limit, options.offset);
            if (result.ok) {
              items = result.value;
            } else {
              reportError(result.error, '加载回收站');
              set({ error: result.error.message, isLoading: false, items: [] });
              return;
            }
          } else {
            if (currentPath.typeFilter && !resourceTypeMap[currentPath.typeFilter]) {
              console.warn('[finderStore] Unknown typeFilter for trash:', currentPath.typeFilter, '- loading all items');
            }
            // 没有类型过滤或未知类型时，加载所有已删除项
            const result = await trashApi.listTrash(options.limit, options.offset);
            if (result.ok) {
              items = result.value;
            } else {
              reportError(result.error, '加载回收站');
              set({ error: result.error.message, isLoading: false, items: [] });
              return;
            }
          }
        } else if (currentPath.folderId === 'root') {
          // ★ 根目录模式：显示真实文件夹结构
          const foldersResult = await folderApi.listFolders();
          if (!foldersResult.ok) {
            reportError(foldersResult.error, '加载文件夹列表');
            set({ error: foldersResult.error.message, isLoading: false, items: [] });
            return;
          }
          const allFolders = foldersResult.value;
          const rootFolders = allFolders.filter(folder => folder.parentId === null);

          const dstuResult = await dstu.list('/', {
            ...options,
            folderId: null,
          });

          if (!dstuResult.ok) {
            reportError(dstuResult.error, '加载根目录');
            set({ error: dstuResult.error.message, isLoading: false, items: [] });
            return;
          }

          // 将文件夹转换为DstuNode格式并合并
          const folderNodes: DstuNode[] = rootFolders.map(folder => ({
            id: folder.id,
            sourceId: folder.id,
            path: folder.id,
            name: folder.title,
            type: 'folder' as DstuNodeType,
            size: 0,
            createdAt: folder.createdAt,
            updatedAt: folder.updatedAt,
            metadata: {
              icon: folder.icon,
              color: folder.color,
              parentId: folder.parentId,
              sortOrder: folder.sortOrder,
              isExpanded: folder.isExpanded,
              isBuiltin: folder.isBuiltin,
              builtinType: folder.builtinType,
            },
          }));

          items = [...folderNodes, ...dstuResult.value];
        } else if (currentPath.folderId) {
          // ★ 特定文件夹模式：列出文件夹下的所有内容
          const foldersResult = await folderApi.listFolders();
          if (!foldersResult.ok) {
            reportError(foldersResult.error, '加载文件夹列表');
            set({ error: foldersResult.error.message, isLoading: false, items: [] });
            return;
          }
          const allFolders = foldersResult.value;
          const subFolders = allFolders.filter(
            folder => folder.parentId === currentPath.folderId
          );

          const dstuResult = await dstu.list('/', {
            ...options,
            folderId: currentPath.folderId,
          });

          if (!dstuResult.ok) {
            reportError(dstuResult.error, '加载文件夹');
            set({ error: dstuResult.error.message, isLoading: false, items: [] });
            return;
          }

          // 将文件夹转换为DstuNode格式并合并
          const folderNodes: DstuNode[] = subFolders.map(folder => ({
            id: folder.id,
            sourceId: folder.id,
            path: folder.id,
            name: folder.title,
            type: 'folder' as DstuNodeType,
            size: 0,
            createdAt: folder.createdAt,
            updatedAt: folder.updatedAt,
            metadata: {
              icon: folder.icon,
              color: folder.color,
              parentId: folder.parentId,
              sortOrder: folder.sortOrder,
              isExpanded: folder.isExpanded,
              isBuiltin: folder.isBuiltin,
              builtinType: folder.builtinType,
            },
          }));

          items = [...folderNodes, ...dstuResult.value];
        } else {
          // ★ 智能文件夹模式：按类型筛选
          const result = await dstu.list('/', options);
          if (result.ok) {
            items = result.value;
          } else {
            reportError(result.error, '加载列表');
            set({ error: result.error.message, isLoading: false, items: [] });
            return;
          }
        }

        // ★ 检查请求是否已过期（有更新的请求发起）
        if (get()._currentRequestId !== requestId) {
          console.log('[finderStore] loadItems 请求已过期，丢弃结果', { requestId, current: get()._currentRequestId });
          return;
        }

        // 应用前端排序
        const { sortBy, sortOrder } = get();
        items = sortItems(items, sortBy, sortOrder);

        set({
          items,
          isLoading: false
        });
      },
      
      setItems: (items: DstuNode[]) => set({ items }),
      setLoading: (isLoading: boolean) => set({ isLoading }),
      setError: (error: string | null) => set({ error }),

      quickAccessNavigate: (type: QuickAccessType) => {
        // ★ 文件夹优先模型：使用 typeFilter 参数（智能文件夹模式）
        const { currentPath } = get();
        
        // ★ 文档28改造: 全部文件模式 - 显示真实文件夹结构（根目录）
        if (type === 'allFiles') {
          const newPath: FinderPath = {
            ...currentPath,
            dstuPath: '/',
            breadcrumbs: [],
            folderId: 'root', // ★ 特殊值表示根目录
            typeFilter: null, // 不筛选类型
            resourceType: null,
          };
          get().navigateTo(newPath);
          return;
        }
        
        // ★ 文档28改造: 回收站模式 - 显示已删除的资源
        if (type === 'trash') {
          const newPath: FinderPath = {
            ...currentPath,
            dstuPath: '/@trash',
            breadcrumbs: [],
            folderId: 'trash', // ★ 特殊值表示回收站
            typeFilter: null,
            resourceType: null,
          };
          get().navigateTo(newPath);
          return;
        }

        // ★ 最近文件模式 - 显示最近访问的资源
        if (type === 'recent') {
          const newPath: FinderPath = {
            ...currentPath,
            dstuPath: '/@recent',
            breadcrumbs: [],
            folderId: 'recent', // ★ 特殊值表示最近文件
            typeFilter: null,
            resourceType: null,
          };
          get().navigateTo(newPath);
          return;
        }

        // ★ 收藏模式 - 显示已收藏的资源
        if (type === 'favorites') {
          const newPath: FinderPath = {
            ...currentPath,
            dstuPath: '/@favorites',
            breadcrumbs: [],
            folderId: null,
            typeFilter: null,
            resourceType: null,
          };
          get().navigateTo(newPath);
          return;
        }

        // ★ 2026-01-15: 向量化状态模式 - 显示向量化状态视图
        if (type === 'indexStatus') {
          const newPath: FinderPath = {
            ...currentPath,
            dstuPath: '/@indexStatus',
            breadcrumbs: [],
            folderId: 'indexStatus', // ★ 特殊值表示向量化状态视图
            typeFilter: null,
            resourceType: null,
          };
          get().navigateTo(newPath);
          return;
        }

        // ★ 2026-01-19: VFS 记忆管理模式
        if (type === 'memory') {
          const newPath: FinderPath = {
            ...currentPath,
            dstuPath: '/@memory',
            breadcrumbs: [],
            folderId: 'memory', // ★ 特殊值表示记忆管理视图
            typeFilter: null,
            resourceType: null,
          };
          get().navigateTo(newPath);
          return;
        }

        // ★ 2026-01-31: 桌面模式 - 显示快捷方式
        if (type === 'desktop') {
          const newPath: FinderPath = {
            ...currentPath,
            dstuPath: '/@desktop',
            breadcrumbs: [],
            folderId: 'desktop', // ★ 特殊值表示桌面视图
            typeFilter: null,
            resourceType: null,
          };
          get().navigateTo(newPath);
          return;
        }

        let newTypeFilter: DstuNodeType | null = null;
        
        switch (type) {
            case 'notes': newTypeFilter = 'note'; break;
            case 'textbooks': newTypeFilter = 'textbook'; break;
            case 'exams': newTypeFilter = 'exam'; break;
            case 'essays': newTypeFilter = 'essay'; break;
            case 'translations': newTypeFilter = 'translation'; break;
            case 'images': newTypeFilter = 'image'; break;
            case 'files': newTypeFilter = 'file'; break;
            case 'mindmaps': newTypeFilter = 'mindmap'; break;
            // favorites, recent, trash 等特殊文件夹在前面 if 分支处理
            default: newTypeFilter = null;
        }

        const newPath: FinderPath = {
          ...currentPath,
          dstuPath: `/@${type}`,
          breadcrumbs: [],
          folderId: null, // 清除文件夹导航
          typeFilter: newTypeFilter, // ★ 设置类型筛选
          resourceType: newTypeFilter, // 保持兼容
        };
        get().navigateTo(newPath);
      },
      
      getDstuListOptions: () => {
        // ★ 根据当前路径状态构建 DSTU 列表选项
        const { currentPath, sortBy, sortOrder } = get();
        const options: DstuListOptions = {
          sortBy: sortBy === 'type' ? 'name' : sortBy,
          sortOrder,
        };

        // 文件夹导航模式
        if (currentPath.folderId) {
          options.folderId = currentPath.folderId;
        }

        // 智能文件夹模式（类型筛选）
        if (currentPath.typeFilter) {
          options.typeFilter = currentPath.typeFilter;
        }

        // ★ 收藏模式
        if (currentPath.dstuPath === '/@favorites') {
          options.isFavorite = true;
        }

        return options;
      },
      
      /**
       * 重置状态
       */
      reset: () => {
          set({
              currentPath: DEFAULT_PATH,
              history: [DEFAULT_PATH],
              historyIndex: 0,
              selectedIds: new Set(),
              lastSelectedId: null,
              searchQuery: '',
              isSearching: false,
              items: [],
              inlineEdit: {
                editingId: null,
                editingType: null,
                originalName: '',
              },
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
      name: 'learning-hub-finder',
      partialize: (state) => ({
        viewMode: state.viewMode,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        quickAccessCollapsed: state.quickAccessCollapsed,
      }),
    }
  )
);
