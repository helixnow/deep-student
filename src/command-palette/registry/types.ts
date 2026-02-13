/**
 * 命令面板核心类型定义 - SOTA 版本
 * 支持完整的命令分类和增强的依赖注入
 */

import type { LucideIcon } from 'lucide-react';
import type { CurrentView } from '@/types/navigation';
import type { TFunction } from 'i18next';

// ==================== 命令分类 ====================

/**
 * 命令分类
 * 按功能模块组织，覆盖应用所有主要功能区域
 */
export type CommandCategory =
  | 'navigation'  // 导航 - 视图切换和页面跳转
  | 'chat'        // 聊天 - Chat V2 对话功能
  | 'notes'       // 笔记 - 笔记编辑和管理
  | 'analysis'    // 分析 - 错题分析功能
  | 'anki'        // 制卡 - Anki 卡片生成
  | 'learning'    // 学习 - Learning Hub 功能
  | 'settings'    // 设置 - 应用配置
  | 'global'      // 全局 - 通用操作
  | 'dev';        // 开发者 - 调试工具

// ==================== 依赖解析器 ====================

/**
 * 依赖解析器 - 命令执行时按需获取依赖
 * 采用惰性获取模式，避免集中化 Context 膨胀
 */
export interface DependencyResolver {
  /** 获取导航函数 */
  navigate: (view: CurrentView, params?: Record<string, unknown>) => void;
  /** 获取当前视图 */
  getCurrentView: () => CurrentView;
  /** 获取翻译函数 */
  t: TFunction;
  /** 显示全局通知 */
  showNotification: (type: 'success' | 'error' | 'warning' | 'info', message: string, title?: string) => void;
  /** 切换主题 */
  toggleTheme: () => void;
  /** 获取当前主题 */
  isDarkMode: () => boolean;
  /** 切换语言 */
  switchLanguage: (lang: 'zh-CN' | 'en-US') => void;
  /** 获取当前语言 */
  getCurrentLanguage: () => string;
  /** 打开命令面板 */
  openCommandPalette: () => void;
  /** 关闭命令面板 */
  closeCommandPalette: () => void;
}

// ==================== 命令定义 ====================

/**
 * 命令执行结果
 */
export interface CommandExecutionResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

/**
 * 命令定义
 */
export interface Command {
  /** 唯一标识，格式：`{module}.{action}`，如 `nav.goto.notes` */
  id: string;
  /** 显示名称（i18n key 或直接文本） */
  name: string;
  /** 描述文本（可选） */
  description?: string;
  /** 所属分类 */
  category: CommandCategory;
  /** 快捷键，如 `mod+k`、`mod+shift+p`（mod = Cmd/Ctrl） */
  shortcut?: string;
  /** 图标组件 */
  icon?: LucideIcon;
  /** 执行函数 */
  execute: (deps: DependencyResolver) => void | Promise<void> | CommandExecutionResult | Promise<CommandExecutionResult>;
  /** 动态判断是否可用 */
  isEnabled?: (deps: DependencyResolver) => boolean;
  /** 仅在特定视图显示（空数组或 undefined 表示全局可见） */
  visibleInViews?: CurrentView[];
  /** 额外搜索关键词 */
  keywords?: string[];
  /** 排序权重，越大越靠前（默认 0） */
  priority?: number;
  /** 命令标签，用于快速筛选 */
  tags?: string[];
  /** 是否为危险操作（显示警告样式） */
  dangerous?: boolean;
  /** 是否需要确认 */
  requireConfirm?: boolean;
  /** 确认提示文本 */
  confirmMessage?: string;
}

// ==================== 子命令支持 ====================

/**
 * 带子命令的命令（用于嵌套菜单）
 */
export interface CommandWithSubcommands extends Omit<Command, 'execute'> {
  /** 子命令列表 */
  subcommands: Command[];
  /** 执行时打开子命令菜单 */
  execute?: never;
}

/**
 * 命令或带子命令的命令
 */
export type CommandOrGroup = Command | CommandWithSubcommands;

/**
 * 判断是否为带子命令的命令
 */
export function isCommandGroup(cmd: CommandOrGroup): cmd is CommandWithSubcommands {
  return 'subcommands' in cmd && Array.isArray(cmd.subcommands);
}

// ==================== 注册表类型 ====================

/**
 * 命令变更监听器
 */
export type CommandChangeListener = (commands: Command[]) => void;

/**
 * 命令注册表接口
 */
export interface ICommandRegistry {
  /** 注册单个命令，返回注销函数 */
  register: (command: Command) => () => void;
  /** 批量注册命令，返回注销函数 */
  registerAll: (commands: Command[]) => () => void;
  /** 注销命令 */
  unregister: (id: string) => void;
  /** 获取所有命令 */
  getAll: () => Command[];
  /** 根据当前视图获取可用命令 */
  getAvailable: (currentView: CurrentView, deps: DependencyResolver) => Command[];
  /** 根据 ID 获取命令 */
  getById: (id: string) => Command | undefined;
  /** 根据快捷键获取命令 */
  getByShortcut: (shortcut: string) => Command | undefined;
  /** 根据快捷键解析当前视图下的可执行命令 */
  resolveShortcut: (shortcut: string, currentView: CurrentView, deps: DependencyResolver) => Command | undefined;
  /** 根据分类获取命令 */
  getByCategory: (category: CommandCategory) => Command[];
  /** 根据标签获取命令 */
  getByTag: (tag: string) => Command[];
  /** 执行命令 */
  execute: (id: string, deps: DependencyResolver) => Promise<void>;
  /** 订阅命令变更 */
  subscribe: (listener: CommandChangeListener) => () => void;
  /** 搜索命令（模糊匹配） */
  search: (query: string, currentView: CurrentView, deps: DependencyResolver) => Command[];
  /** 获取命令数量 */
  count: () => number;
}

// ==================== 命令面板状态 ====================

/**
 * 命令面板视图模式
 */
export type CommandPaletteViewMode = 'search' | 'recent' | 'favorites' | 'category';

/**
 * 命令面板状态
 */
export interface CommandPaletteState {
  /** 是否打开 */
  isOpen: boolean;
  /** 搜索词 */
  searchQuery: string;
  /** 当前选中的命令索引 */
  selectedIndex: number;
  /** 过滤后的命令列表 */
  filteredCommands: Command[];
  /** 视图模式 */
  viewMode: CommandPaletteViewMode;
  /** 当前选中的分类筛选 */
  selectedCategory: CommandCategory | null;
}

// ==================== 分类元数据 ====================

/**
 * 分类显示配置
 */
export interface CategoryConfig {
  /** 排序顺序 */
  order: number;
  /** i18n 标签键 */
  labelKey: string;
  /** 默认图标 */
  defaultIcon?: LucideIcon;
  /** 分类颜色（CSS 类名或颜色值） */
  color?: string;
}

/**
 * 分类配置表
 * 按使用频率排序，常用分类在前
 */
export const CATEGORY_CONFIG: Record<CommandCategory, CategoryConfig> = {
  navigation: {
    order: 1,
    labelKey: 'command_palette:categories.navigation',
    color: 'text-blue-500',
  },
  chat: {
    order: 2,
    labelKey: 'command_palette:categories.chat',
    color: 'text-green-500',
  },
  global: {
    order: 3,
    labelKey: 'command_palette:categories.global',
    color: 'text-gray-500',
  },
  notes: {
    order: 4,
    labelKey: 'command_palette:categories.notes',
    color: 'text-yellow-500',
  },
  analysis: {
    order: 5,
    labelKey: 'command_palette:categories.analysis',
    color: 'text-purple-500',
  },
  anki: {
    order: 6,
    labelKey: 'command_palette:categories.anki',
    color: 'text-orange-500',
  },
  learning: {
    order: 7,
    labelKey: 'command_palette:categories.learning',
    color: 'text-pink-500',
  },
  settings: {
    order: 8,
    labelKey: 'command_palette:categories.settings',
    color: 'text-slate-500',
  },
  dev: {
    order: 9,
    labelKey: 'command_palette:categories.dev',
    color: 'text-red-500',
  },
};

/**
 * 获取所有分类（按顺序排列）
 */
export function getAllCategories(): CommandCategory[] {
  return Object.entries(CATEGORY_CONFIG)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([key]) => key as CommandCategory);
}

/**
 * 分类显示名称映射（fallback）
 */
export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  navigation: '导航',
  chat: '对话',
  global: '全局',
  notes: '笔记',
  analysis: '分析',
  anki: '制卡',
  learning: '学习',
  settings: '设置',
  dev: '开发者',
};
