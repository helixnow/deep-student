/**
 * DSTU 资源打开函数
 *
 * 根据资源类型查询编辑器注册表，确定打开位置，并渲染编辑器组件。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.9
 */

import React from 'react';
import type { DstuNode, DstuNodeType } from './types';
import type { EditorLocation, EditorMode, EditorProps, OpenResourceOptions } from './editorTypes';
import { editorRegistry, loadEditorComponent } from './editorRegistry';
import { Result, ok, err, VfsError, VfsErrorCode, reportError } from '@/shared/result';

// ============================================================================
// 资源打开状态管理
// ============================================================================

/**
 * 当前打开的资源状态
 */
interface OpenResourceState {
  /** 当前面板中的资源路径 */
  panelPath: string | null;

  /** 当前全屏模式的资源路径 */
  fullscreenPath: string | null;

  /** 当前弹窗中的资源路径 */
  modalPath: string | null;
}

/**
 * 资源打开事件处理器
 */
export interface OpenResourceHandler {
  /** 在面板中打开 */
  openInPanel: (path: string, node: DstuNode, mode: EditorMode) => void;

  /** 在独立页面中打开 */
  openInPage: (path: string, node: DstuNode, mode: EditorMode) => void;

  /** 在全屏模式中打开 */
  openInFullscreen: (path: string, node: DstuNode, mode: EditorMode) => void;

  /** 在弹窗中打开 */
  openInModal: (path: string, node: DstuNode, mode: EditorMode) => void;
}

// ============================================================================
// 🔧 P0-28 修复：多处理器注册系统
// ============================================================================

/**
 * 已注册的处理器映射表
 * key: 命名空间（如 "chat-v2", "learning-hub"）
 */
const handlerRegistry = new Map<string, OpenResourceHandler>();

/**
 * 当前活跃的处理器命名空间
 * 最后一个注册的处理器会成为活跃处理器
 */
let activeHandlerNamespace: string | null = null;

/**
 * 处理器注册顺序（用于确定默认处理器）
 */
const registrationOrder: string[] = [];

/**
 * 注册资源打开处理器
 *
 * @param handler 处理器实现
 * @param namespace 可选的命名空间，用于区分不同的处理器来源
 * @returns 取消注册函数
 *
 * @example
 * // 在 Learning Hub 中注册
 * useEffect(() => {
 *   return registerOpenResourceHandler(handler, 'learning-hub');
 * }, []);
 *
 * // 在 Chat V2 中注册
 * useEffect(() => {
 *   return registerOpenResourceHandler(handler, 'chat-v2');
 * }, []);
 */
export function registerOpenResourceHandler(
  handler: OpenResourceHandler,
  namespace: string = 'default'
): () => void {
  // 🔧 P0-28 修复：使用命名空间注册，不会覆盖其他处理器
  const existingHandler = handlerRegistry.get(namespace);
  if (existingHandler && existingHandler !== handler) {
    console.log(`[DSTU] 替换命名空间 "${namespace}" 的处理器`);
  }

  handlerRegistry.set(namespace, handler);

  // 更新注册顺序
  const orderIndex = registrationOrder.indexOf(namespace);
  if (orderIndex >= 0) {
    registrationOrder.splice(orderIndex, 1);
  }
  registrationOrder.push(namespace);

  // 最新注册的成为活跃处理器
  activeHandlerNamespace = namespace;
  console.log(`[DSTU] 注册处理器 "${namespace}"，当前活跃: "${activeHandlerNamespace}"`);

  return () => {
    if (handlerRegistry.get(namespace) === handler) {
      handlerRegistry.delete(namespace);
      const idx = registrationOrder.indexOf(namespace);
      if (idx >= 0) {
        registrationOrder.splice(idx, 1);
      }

      // 如果被移除的是活跃处理器，切换到最后一个注册的
      if (activeHandlerNamespace === namespace) {
        activeHandlerNamespace = registrationOrder.length > 0
          ? registrationOrder[registrationOrder.length - 1]
          : null;
      }
      console.log(`[DSTU] 移除处理器 "${namespace}"，当前活跃: "${activeHandlerNamespace}"`);
    }
  };
}

/**
 * 获取当前注册的处理器
 *
 * @param namespace 可选的命名空间，不指定则返回活跃处理器
 */
export function getOpenResourceHandler(namespace?: string): OpenResourceHandler | null {
  if (namespace) {
    return handlerRegistry.get(namespace) ?? null;
  }
  // 返回活跃处理器
  if (activeHandlerNamespace) {
    return handlerRegistry.get(activeHandlerNamespace) ?? null;
  }
  return null;
}

/**
 * 设置活跃处理器命名空间
 *
 * 当视图切换时调用，确保使用正确的处理器
 */
export function setActiveOpenResourceHandler(namespace: string): boolean {
  if (handlerRegistry.has(namespace)) {
    activeHandlerNamespace = namespace;
    console.log(`[DSTU] 切换活跃处理器到 "${namespace}"`);
    return true;
  }
  console.warn(`[DSTU] 命名空间 "${namespace}" 未注册处理器`);
  return false;
}

/**
 * 获取所有已注册的处理器命名空间
 */
export function getRegisteredHandlerNamespaces(): string[] {
  return [...registrationOrder];
}

// 🔧 P0-28 兼容性：保留旧的全局处理器访问方式
// 使用 getter 委托到新的注册系统
Object.defineProperty(globalThis, '__dstuGlobalHandler', {
  get() {
    return getOpenResourceHandler();
  },
  configurable: true,
});

// ============================================================================
// 核心打开函数
// ============================================================================

/**
 * 打开资源
 *
 * 完整流程：
 * 1. 获取资源信息（如果只有路径）
 * 2. 查询编辑器注册表
 * 3. 确定打开位置
 * 4. 调用对应的处理器
 *
 * @param pathOrNode 资源路径或节点对象
 * @param options 打开选项
 * @returns Result 包装的空结果，失败时包含错误信息
 */
export async function openResource(
  pathOrNode: string | DstuNode,
  options?: OpenResourceOptions
): Promise<Result<void, VfsError>> {
  // 🔧 P0-28 修复：使用新的处理器注册系统
  const handler = getOpenResourceHandler();

  // 如果处理器未注册，返回错误
  if (!handler) {
    const error = new VfsError(
      VfsErrorCode.INVALID_STATE,
      'OpenResourceHandler 未注册',
      false
    );
    console.warn('[DSTU] OpenResourceHandler not registered. Cannot open resource.');
    reportError(error, '打开资源');
    return err(error);
  }

  let node: DstuNode;
  let path: string;

  // 解析输入
  if (typeof pathOrNode === 'string') {
    path = pathOrNode;
    // 需要从 DSTU API 获取节点信息
    const { dstu } = await import('./api');
    const nodeResult = await dstu.get(path);
    if (!nodeResult.ok) {
      reportError(nodeResult.error, '打开资源');
      return err(nodeResult.error);
    }
    if (!nodeResult.value) {
      const error = new VfsError(
        VfsErrorCode.NOT_FOUND,
        `资源未找到: ${path}`,
        true,
        { path }
      );
      reportError(error, '打开资源');
      return err(error);
    }
    node = nodeResult.value;
  } else {
    node = pathOrNode;
    path = node.path;
  }

  // 文件夹不能直接打开编辑器
  if (node.type === 'folder') {
    const error = new VfsError(
      VfsErrorCode.INVALID_STATE,
      '文件夹不能在编辑器中打开',
      false,
      { path, type: node.type }
    );
    console.warn('[DSTU] Cannot open folder in editor:', path);
    reportError(error, '打开资源');
    return err(error);
  }

  // 查询编辑器注册表
  const entry = editorRegistry[node.type];
  if (!entry) {
    const error = new VfsError(
      VfsErrorCode.INVALID_STATE,
      `未注册类型为 ${node.type} 的编辑器`,
      false,
      { type: node.type }
    );
    console.warn('[DSTU] No editor registered for type:', node.type);
    reportError(error, '打开资源');
    return err(error);
  }

  // 确定打开位置和模式
  const location = options?.location ?? entry.defaultLocation;
  const mode = options?.readOnly ? 'view' : (options?.mode ?? entry.defaultMode);

  // 根据位置调用对应处理器
  // 🔧 P0-28 修复：使用本地 handler 变量而非全局变量
  switch (location) {
    case 'panel':
      handler.openInPanel(path, node, mode);
      break;
    case 'page':
      handler.openInPage(path, node, mode);
      break;
    case 'fullscreen':
      handler.openInFullscreen(path, node, mode);
      break;
    case 'modal':
      handler.openInModal(path, node, mode);
      break;
    default:
      const error = new VfsError(
        VfsErrorCode.VALIDATION,
        `未知的打开位置: ${location}`,
        false,
        { location }
      );
      console.warn('[DSTU] Unknown location:', location);
      reportError(error, '打开资源');
      return err(error);
  }

  return ok(undefined);
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 在面板中打开资源
 */
export async function openInPanel(
  pathOrNode: string | DstuNode,
  options?: Omit<OpenResourceOptions, 'location'>
): Promise<Result<void, VfsError>> {
  return openResource(pathOrNode, { ...options, location: 'panel' });
}

/**
 * 在独立页面中打开资源
 */
export async function openInPage(
  pathOrNode: string | DstuNode,
  options?: Omit<OpenResourceOptions, 'location'>
): Promise<Result<void, VfsError>> {
  return openResource(pathOrNode, { ...options, location: 'page' });
}

/**
 * 在全屏模式中打开资源
 */
export async function openInFullscreen(
  pathOrNode: string | DstuNode,
  options?: Omit<OpenResourceOptions, 'location'>
): Promise<Result<void, VfsError>> {
  return openResource(pathOrNode, { ...options, location: 'fullscreen' });
}

/**
 * 在弹窗中打开资源
 */
export async function openInModal(
  pathOrNode: string | DstuNode,
  options?: Omit<OpenResourceOptions, 'location'>
): Promise<Result<void, VfsError>> {
  return openResource(pathOrNode, { ...options, location: 'modal' });
}

// ============================================================================
// 编辑器渲染辅助
// ============================================================================

/**
 * 编辑器渲染 Props
 */
export interface EditorRenderProps {
  /** 资源路径 */
  path: string;

  /** 资源节点 */
  node: DstuNode;

  /** 编辑模式 */
  mode: EditorMode;

  /** 关闭回调 */
  onClose?: () => void;

  /** 自定义类名 */
  className?: string;
}

/**
 * 获取编辑器组件用于渲染
 *
 * 供 Learning Hub 等宿主组件使用
 */
export async function getEditorForRender(
  type: DstuNodeType
): Promise<React.ComponentType<EditorRenderProps> | null> {
  try {
    const Component = await loadEditorComponent(type);
    // 返回包装后的组件
    return function EditorWrapper(props: EditorRenderProps) {
      const { path, mode, onClose, className } = props;
      // 使用 React.createElement 替代 JSX（因为这是 .ts 文件）
      return React.createElement(Component as React.ComponentType<EditorProps>, {
        path,
        mode,
        onClose,
        className,
      });
    };
  } catch (error: unknown) {
    console.error('[DSTU] Failed to load editor component:', error);
    return null;
  }
}

// ============================================================================
// 路由集成辅助
// ============================================================================

/**
 * 生成编辑器页面路由路径
 *
 * 用于 page 位置的路由导航
 */
export function getEditorPageRoute(node: DstuNode): string {
  const encodedPath = encodeURIComponent(node.path);
  return `/editor/${node.type}/${encodedPath}`;
}

/**
 * 从路由参数解析资源信息
 */
export interface ParsedEditorRoute {
  type: DstuNodeType;
  path: string;
}

/**
 * 解析编辑器页面路由参数
 */
export function parseEditorRoute(
  type: string,
  encodedPath: string
): ParsedEditorRoute | null {
  if (!type || !encodedPath) {
    return null;
  }

  const validTypes: DstuNodeType[] = [
    'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file'
  ];

  if (!validTypes.includes(type as DstuNodeType)) {
    return null;
  }

  try {
    return {
      type: type as DstuNodeType,
      path: decodeURIComponent(encodedPath),
    };
  } catch {
    return null;
  }
}
