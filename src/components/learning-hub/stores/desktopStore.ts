/**
 * 桌面快捷方式存储
 *
 * 使用 zustand + persist 在前端维护桌面快捷方式。
 * 用户可以将常用的应用、资源、文件夹或智能文件夹添加到桌面，
 * 实现类似操作系统桌面的快捷访问体验。
 *
 * @since 2026-01-31
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18next from 'i18next';
import type { DstuNodeType } from '@/dstu/types';
import type { QuickAccessType } from './finderStore';

/**
 * 快捷方式类型
 */
export type ShortcutType =
  /** 应用快捷方式：打开创建/编辑界面 */
  | 'app'
  /** 资源快捷方式：指向具体的资源（笔记、题目集等） */
  | 'resource'
  /** 文件夹快捷方式：指向文件夹 */
  | 'folder'
  /** 智能文件夹快捷方式：指向快捷入口（收藏、最近等） */
  | 'quickAccess';

/**
 * 应用类型（用于 app 类型快捷方式）
 */
export type AppType = 'note' | 'exam' | 'essay' | 'translation' | 'mindmap' | 'textbook';

/**
 * 应用动作
 */
export type AppAction = 'create' | 'list';

/**
 * 桌面快捷方式
 */
export interface DesktopShortcut {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 快捷方式类型 */
  type: ShortcutType;
  /** 目标信息 */
  target: {
    /** 应用类型（type=app 时使用） */
    appType?: AppType;
    /** 应用动作（type=app 时使用） */
    action?: AppAction;
    /** 资源 ID（type=resource 时使用） */
    resourceId?: string;
    /** 资源类型（type=resource 时使用） */
    resourceType?: DstuNodeType;
    /** 资源路径（type=resource 时使用，用于显示） */
    resourcePath?: string;
    /** 文件夹 ID（type=folder 时使用） */
    folderId?: string;
    /** 文件夹路径（type=folder 时使用，用于显示） */
    folderPath?: string;
    /** 快捷入口类型（type=quickAccess 时使用） */
    quickAccessType?: QuickAccessType;
  };
  /** 自定义图标（暂不实现，预留字段） */
  icon?: string;
  /** 自定义颜色（暂不实现，预留字段） */
  color?: string;
  /** 排序位置（数字越小越靠前） */
  position: number;
  /** 创建时间 */
  createdAt: string;
}

/** Preset shortcut type (same shape as DesktopShortcut minus generated fields) */
export type PresetShortcut = Omit<DesktopShortcut, 'id' | 'position' | 'createdAt'>;

/**
 * 预设的应用快捷方式（用户可以添加到桌面）
 * 返回当前语言的翻译版本，需在运行时调用（i18next 已初始化后）
 */
export function getPresetAppShortcuts(): PresetShortcut[] {
  const t = (key: string, fallback: string) => i18next.t(key, { defaultValue: fallback, ns: 'learningHub' });
  return [
    {
      name: t('desktop.presets.newNote', '新建笔记'),
      type: 'app',
      target: { appType: 'note', action: 'create' },
    },
    {
      name: t('desktop.presets.newExam', '新建题目集'),
      type: 'app',
      target: { appType: 'exam', action: 'create' },
    },
    {
      name: t('desktop.presets.newEssay', '新建作文'),
      type: 'app',
      target: { appType: 'essay', action: 'create' },
    },
    {
      name: t('desktop.presets.newTranslation', '新建翻译'),
      type: 'app',
      target: { appType: 'translation', action: 'create' },
    },
    {
      name: t('desktop.presets.newMindmap', '新建思维导图'),
      type: 'app',
      target: { appType: 'mindmap', action: 'create' },
    },
    {
      name: t('desktop.presets.allNotes', '全部笔记'),
      type: 'quickAccess',
      target: { quickAccessType: 'notes' },
    },
    {
      name: t('desktop.presets.allExams', '全部题目集'),
      type: 'quickAccess',
      target: { quickAccessType: 'exams' },
    },
    {
      name: t('desktop.presets.allEssays', '全部作文'),
      type: 'quickAccess',
      target: { quickAccessType: 'essays' },
    },
    {
      name: t('desktop.presets.allTranslations', '全部翻译'),
      type: 'quickAccess',
      target: { quickAccessType: 'translations' },
    },
    {
      name: t('desktop.presets.mindmaps', '知识导图'),
      type: 'quickAccess',
      target: { quickAccessType: 'mindmaps' },
    },
    {
      name: t('desktop.presets.favorites', '收藏'),
      type: 'quickAccess',
      target: { quickAccessType: 'favorites' },
    },
    {
      name: t('desktop.presets.recentAccess', '最近访问'),
      type: 'quickAccess',
      target: { quickAccessType: 'recent' },
    },
  ];
}

/**
 * @deprecated Use getPresetAppShortcuts() for i18n support
 */
export const PRESET_APP_SHORTCUTS = getPresetAppShortcuts;

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `shortcut_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 桌面根目录配置
 */
export interface DesktopRootConfig {
  /** 根目录文件夹 ID（null 表示使用根路径） */
  folderId: string | null;
  /** 根目录文件夹名称（用于显示） */
  folderName: string | null;
  /** 根目录文件夹路径（用于显示） */
  folderPath: string | null;
}

/**
 * 桌面快捷方式状态
 */
interface DesktopState {
  /** 快捷方式列表 */
  shortcuts: DesktopShortcut[];

  /** 桌面根目录配置 */
  desktopRoot: DesktopRootConfig;

  /**
   * 添加快捷方式
   * @param shortcut 快捷方式数据（不含 id、position、createdAt）
   * @returns 新创建的快捷方式 ID
   */
  addShortcut: (shortcut: Omit<DesktopShortcut, 'id' | 'position' | 'createdAt'>) => string;

  /**
   * 从预设添加快捷方式
   * @param presetIndex 预设索引
   * @returns 新创建的快捷方式 ID，如果已存在则返回 null
   */
  addFromPreset: (presetIndex: number) => string | null;

  /**
   * 添加资源快捷方式
   * @param resourceId 资源 ID
   * @param name 资源名称
   * @param resourceType 资源类型
   * @param resourcePath 资源路径（可选）
   * @returns 新创建的快捷方式 ID，如果已存在则返回 null
   */
  addResourceShortcut: (
    resourceId: string,
    name: string,
    resourceType: DstuNodeType,
    resourcePath?: string
  ) => string | null;

  /**
   * 添加文件夹快捷方式
   * @param folderId 文件夹 ID
   * @param name 文件夹名称
   * @param folderPath 文件夹路径（可选）
   * @returns 新创建的快捷方式 ID，如果已存在则返回 null
   */
  addFolderShortcut: (folderId: string, name: string, folderPath?: string) => string | null;

  /**
   * 移除快捷方式
   * @param id 快捷方式 ID
   */
  removeShortcut: (id: string) => void;

  /**
   * 更新快捷方式名称
   * @param id 快捷方式 ID
   * @param name 新名称
   */
  renameShortcut: (id: string, name: string) => void;

  /**
   * 移动快捷方式位置
   * @param id 快捷方式 ID
   * @param newPosition 新位置
   */
  moveShortcut: (id: string, newPosition: number) => void;

  /**
   * 交换两个快捷方式的位置
   * @param id1 第一个快捷方式 ID
   * @param id2 第二个快捷方式 ID
   */
  swapShortcuts: (id1: string, id2: string) => void;

  /**
   * 检查资源是否已添加到桌面
   * @param resourceId 资源 ID
   * @returns 是否已存在
   */
  hasResourceShortcut: (resourceId: string) => boolean;

  /**
   * 检查文件夹是否已添加到桌面
   * @param folderId 文件夹 ID
   * @returns 是否已存在
   */
  hasFolderShortcut: (folderId: string) => boolean;

  /**
   * 检查快捷入口是否已添加到桌面
   * @param quickAccessType 快捷入口类型
   * @returns 是否已存在
   */
  hasQuickAccessShortcut: (quickAccessType: QuickAccessType) => boolean;

  /**
   * 检查应用快捷方式是否已添加到桌面
   * @param appType 应用类型
   * @param action 动作
   * @returns 是否已存在
   */
  hasAppShortcut: (appType: AppType, action: AppAction) => boolean;

  /**
   * 获取排序后的快捷方式列表
   * @returns 按 position 排序的列表
   */
  getSortedShortcuts: () => DesktopShortcut[];

  /**
   * 清空所有快捷方式
   */
  clearShortcuts: () => void;

  /**
   * 初始化默认快捷方式（首次使用时调用）
   */
  initDefaultShortcuts: () => void;

  /**
   * 设置桌面根目录
   * @param folderId 文件夹 ID（null 表示使用根路径）
   * @param folderName 文件夹名称
   * @param folderPath 文件夹路径
   */
  setDesktopRoot: (folderId: string | null, folderName?: string | null, folderPath?: string | null) => void;

  /**
   * 获取桌面根目录配置
   */
  getDesktopRoot: () => DesktopRootConfig;
}

/**
 * 桌面快捷方式 Store
 *
 * 使用 localStorage 持久化，key 为 'learning-hub-desktop'
 */
export const useDesktopStore = create<DesktopState>()(
  persist(
    (set, get) => ({
      shortcuts: [],
      desktopRoot: {
        folderId: null,
        folderName: null,
        folderPath: null,
      },

      addShortcut: (shortcut) => {
        const { shortcuts } = get();
        const id = generateId();
        const maxPosition = shortcuts.length > 0 
          ? Math.max(...shortcuts.map(s => s.position)) 
          : -1;

        const newShortcut: DesktopShortcut = {
          ...shortcut,
          id,
          position: maxPosition + 1,
          createdAt: new Date().toISOString(),
        };

        set({ shortcuts: [...shortcuts, newShortcut] });
        return id;
      },

      addFromPreset: (presetIndex) => {
        const presets = getPresetAppShortcuts();
        const preset = presets[presetIndex];
        if (!preset) return null;

        // 检查是否已存在
        const { shortcuts } = get();
        const exists = shortcuts.some(s => {
          if (preset.type === 'app' && s.type === 'app') {
            return s.target.appType === preset.target.appType 
              && s.target.action === preset.target.action;
          }
          if (preset.type === 'quickAccess' && s.type === 'quickAccess') {
            return s.target.quickAccessType === preset.target.quickAccessType;
          }
          return false;
        });

        if (exists) return null;

        return get().addShortcut(preset);
      },

      addResourceShortcut: (resourceId, name, resourceType, resourcePath) => {
        if (get().hasResourceShortcut(resourceId)) return null;

        return get().addShortcut({
          name,
          type: 'resource',
          target: { resourceId, resourceType, resourcePath },
        });
      },

      addFolderShortcut: (folderId, name, folderPath) => {
        if (get().hasFolderShortcut(folderId)) return null;

        return get().addShortcut({
          name,
          type: 'folder',
          target: { folderId, folderPath },
        });
      },

      removeShortcut: (id) => {
        set({ shortcuts: get().shortcuts.filter(s => s.id !== id) });
      },

      renameShortcut: (id, name) => {
        set({
          shortcuts: get().shortcuts.map(s => 
            s.id === id ? { ...s, name } : s
          ),
        });
      },

      moveShortcut: (id, newPosition) => {
        const { shortcuts } = get();
        const shortcut = shortcuts.find(s => s.id === id);
        if (!shortcut) return;

        const others = shortcuts.filter(s => s.id !== id);
        
        // 重新计算位置
        const sorted = [...others].sort((a, b) => a.position - b.position);
        const updated: DesktopShortcut[] = [];
        
        let inserted = false;
        sorted.forEach((s, index) => {
          if (!inserted && index >= newPosition) {
            updated.push({ ...shortcut, position: index });
            inserted = true;
          }
          updated.push({ ...s, position: inserted ? index + 1 : index });
        });
        
        if (!inserted) {
          updated.push({ ...shortcut, position: sorted.length });
        }

        set({ shortcuts: updated });
      },

      swapShortcuts: (id1, id2) => {
        const { shortcuts } = get();
        const s1 = shortcuts.find(s => s.id === id1);
        const s2 = shortcuts.find(s => s.id === id2);
        if (!s1 || !s2) return;

        set({
          shortcuts: shortcuts.map(s => {
            if (s.id === id1) return { ...s, position: s2.position };
            if (s.id === id2) return { ...s, position: s1.position };
            return s;
          }),
        });
      },

      hasResourceShortcut: (resourceId) => {
        return get().shortcuts.some(
          s => s.type === 'resource' && s.target.resourceId === resourceId
        );
      },

      hasFolderShortcut: (folderId) => {
        return get().shortcuts.some(
          s => s.type === 'folder' && s.target.folderId === folderId
        );
      },

      hasQuickAccessShortcut: (quickAccessType) => {
        return get().shortcuts.some(
          s => s.type === 'quickAccess' && s.target.quickAccessType === quickAccessType
        );
      },

      hasAppShortcut: (appType, action) => {
        return get().shortcuts.some(
          s => s.type === 'app' 
            && s.target.appType === appType 
            && s.target.action === action
        );
      },

      getSortedShortcuts: () => {
        return [...get().shortcuts].sort((a, b) => a.position - b.position);
      },

      clearShortcuts: () => set({ shortcuts: [] }),

      initDefaultShortcuts: () => {
        const { shortcuts } = get();
        if (shortcuts.length > 0) return; // 已有快捷方式，不初始化

        // 添加默认快捷方式
        const defaultPresets = [0, 1, 2, 3, 4]; // 新建笔记、题目集、作文、翻译、思维导图
        defaultPresets.forEach(index => {
          get().addFromPreset(index);
        });
      },

      setDesktopRoot: (folderId, folderName = null, folderPath = null) => {
        set({
          desktopRoot: {
            folderId,
            folderName,
            folderPath,
          },
        });
      },

      getDesktopRoot: () => get().desktopRoot,
    }),
    {
      name: 'learning-hub-desktop',
    }
  )
);
