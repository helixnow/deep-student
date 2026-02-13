/**
 * DSTU 编辑器接口规范
 *
 * 定义编辑器统一接口，确保所有编辑器可在任何地方打开
 * （Learning Hub、Chat V2 Canvas、独立入口等）
 *
 * 核心设计原则：
 * - 编辑器只通过 DSTU API 读写数据
 * - 编辑器只依赖 path 参数，不依赖 Learning Hub 状态
 * - 编辑器可在任何地方复用
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.7-4.11
 */

import type { ComponentType } from 'react';
import type { DstuNodeType } from './types';

// ============================================================================
// 编辑器位置与模式
// ============================================================================

/**
 * 编辑器打开位置
 *
 * 类比操作系统的文件打开方式
 */
export type EditorLocation =
  /** Learning Hub 右侧预览面板（轻量编辑） */
  | 'panel'
  /** 独立路由页面（深度编辑） */
  | 'page'
  /** 全屏模式（沉浸式） */
  | 'fullscreen'
  /** 弹窗（快速修改） */
  | 'modal';

/**
 * 编辑模式
 */
export type EditorMode = 'view' | 'edit';

// ============================================================================
// 资源能力定义
// ============================================================================

/**
 * 资源能力定义
 *
 * 控制右键菜单项的显示
 */
export interface ResourceCapabilities {
  /** 是否可编辑内容 */
  editable: boolean;

  /** 是否可删除 */
  deletable: boolean;

  /** 是否可移动/重命名 */
  movable: boolean;

  /** 是否可复制 */
  copyable: boolean;

  /** 是否可分享 */
  shareable: boolean;

  /** 是否支持版本历史 */
  versionable: boolean;

  /** 是否可被引用到 Chat V2 */
  referenceable: boolean;
}

// ============================================================================
// 编辑器 Props 接口
// ============================================================================

/**
 * 编辑器统一 Props
 *
 * 关键设计原则：
 * - 编辑器只通过 DSTU API 读写数据
 * - 编辑器不依赖 Learning Hub 状态
 * - 编辑器可在任何地方打开
 */
export interface EditorProps {
  /** DSTU 路径，如 '/note_123' 或 '/高考复习/note_123' */
  path: string;

  /** 编辑模式（可覆盖默认值） */
  mode?: EditorMode;

  /** 是否只读（强制覆盖 mode） */
  readOnly?: boolean;

  /** 保存回调（编辑器调用 dstu.update 后触发） */
  onSave?: () => void;

  /** 关闭回调 */
  onClose?: () => void;

  /** 内容变化回调（用于脏状态检测） */
  onDirtyChange?: (isDirty: boolean) => void;

  /** 自定义类名 */
  className?: string;
}

/**
 * 新建模式编辑器 Props
 */
export interface CreateEditorProps {
  /** 创建模式标记 */
  mode: 'create';

  /** 资源类型 */
  type: DstuNodeType;

  /** 创建成功回调，返回新资源路径 */
  onCreate?: (path: string) => void;

  /** 关闭回调 */
  onClose?: () => void;

  /** 自定义类名 */
  className?: string;
}

/**
 * 编辑器组件类型
 *
 * 支持编辑已有资源和创建新资源两种模式
 */
export type EditorComponent = ComponentType<EditorProps | CreateEditorProps>;

// ============================================================================
// 编辑器注册项
// ============================================================================

/**
 * 编辑器注册项
 *
 * 类比操作系统的文件类型关联机制
 */
export interface EditorRegistryEntry {
  /** 资源类型 */
  type: DstuNodeType;

  /** 编辑器组件（懒加载导入） */
  editor: EditorComponent | (() => Promise<{ default: EditorComponent }>);

  /** 默认编辑模式 */
  defaultMode: EditorMode;

  /** 默认打开位置 */
  defaultLocation: EditorLocation;

  /** 资源能力定义 */
  capabilities: ResourceCapabilities;

  /** Lucide 图标名 */
  icon: string;

  /** 显示名称（i18n key，如 'dstu:types.note'） */
  displayName: string;
}

// ============================================================================
// 打开资源选项
// ============================================================================

/**
 * 打开资源选项
 */
export interface OpenResourceOptions {
  /** 覆盖默认编辑模式 */
  mode?: EditorMode;

  /** 覆盖默认打开位置 */
  location?: EditorLocation;

  /** 是否强制只读 */
  readOnly?: boolean;
}

// ============================================================================
// 右键菜单项
// ============================================================================

/**
 * 右键菜单项变体
 */
export type ContextMenuItemVariant = 'default' | 'destructive';

/**
 * 右键菜单项
 */
export interface ContextMenuItem {
  /** 唯一标识 */
  id: string;

  /** 显示标签（i18n key） */
  label: string;

  /** Lucide 图标名 */
  icon?: string;

  /** 点击动作 */
  action?: () => void | Promise<void>;

  /** 样式变体 */
  variant?: ContextMenuItemVariant;

  /** 是否禁用 */
  disabled?: boolean;

  /** 分隔符类型 */
  type?: 'separator';
}

// ============================================================================
// 编辑器状态
// ============================================================================

/**
 * 编辑器内部状态（供自定义 Hook 使用）
 */
export interface EditorState {
  /** 是否正在加载 */
  isLoading: boolean;

  /** 是否有未保存的更改 */
  isDirty: boolean;

  /** 是否正在保存 */
  isSaving: boolean;

  /** 错误信息 */
  error: string | null;

  /** 内容 */
  content: string | null;
}

/**
 * 编辑器操作
 */
export interface EditorActions {
  /** 保存内容 */
  save: () => Promise<void>;

  /** 重新加载内容 */
  reload: () => Promise<void>;

  /** 重置脏状态 */
  resetDirty: () => void;
}
