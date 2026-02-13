/**
 * DSTU 右键菜单生成
 *
 * 根据资源能力 (capabilities) 动态生成右键菜单项。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.11
 */

import type { DstuNode } from './types';
import type { ContextMenuItem } from './editorTypes';
import { editorRegistry } from './editorRegistry';
import { openResource } from './openResource';
import { isErr } from '@/shared/result';
import { dstu } from './api';

// ============================================================================
// 菜单动作处理器
// ============================================================================

/**
 * 菜单动作处理器接口
 *
 * 由宿主组件实现具体动作
 */
export interface ContextMenuActionHandler {
  /** 引用到对话 */
  addToContextRefs?: (node: DstuNode) => Promise<void>;

  /** 打开移动对话框 */
  openMoveDialog?: (path: string) => void;

  /** 开始重命名 */
  startRename?: (path: string) => void;

  /** 打开版本历史 */
  openVersionHistory?: (path: string) => void;

  /** 确认删除 */
  confirmDelete?: (path: string) => Promise<void>;

  /** 复制资源 */
  copyResource?: (path: string) => Promise<void>;

  /** 分享资源 */
  shareResource?: (path: string) => Promise<void>;
}

/**
 * 全局菜单动作处理器
 */
let globalActionHandler: ContextMenuActionHandler | null = null;

/**
 * 注册菜单动作处理器
 */
export function registerContextMenuActionHandler(
  handler: ContextMenuActionHandler
): () => void {
  globalActionHandler = handler;
  return () => {
    if (globalActionHandler === handler) {
      globalActionHandler = null;
    }
  };
}

// ============================================================================
// 菜单构建
// ============================================================================

/**
 * 根据资源能力生成右键菜单
 *
 * @param node 资源节点
 * @param options 额外选项
 */
export function buildContextMenu(
  node: DstuNode,
  options?: {
    /** 是否显示打开选项 */
    showOpen?: boolean;
    /** 自定义菜单项（插入到标准菜单前） */
    customItems?: ContextMenuItem[];
  }
): ContextMenuItem[] {
  const entry = editorRegistry[node.type];
  if (!entry) {
    return [];
  }

  const { capabilities } = entry;
  const items: ContextMenuItem[] = [];
  const { showOpen = true, customItems = [] } = options ?? {};

  // 自定义菜单项
  if (customItems.length > 0) {
    items.push(...customItems);
    items.push({ id: 'custom-separator', type: 'separator', label: '' });
  }

  // ========== 打开操作 ==========

  if (showOpen && node.type !== 'folder') {
    // 打开
    items.push({
      id: 'open',
      label: 'dstu:menu.open',
      icon: 'ExternalLink',
      action: async () => {
        const result = await openResource(node);
        if (isErr(result)) {
          console.error('[DSTU] Open failed:', result.error.toUserMessage());
        }
      },
    });

    // 编辑（如果可编辑）
    if (capabilities.editable) {
      items.push({
        id: 'edit',
        label: 'dstu:menu.edit',
        icon: 'Edit',
        action: async () => {
          const result = await openResource(node, { mode: 'edit' });
          if (isErr(result)) {
            console.error('[DSTU] Edit failed:', result.error.toUserMessage());
          }
        },
      });
    }
  }

  // ========== 引用操作 ==========

  // 引用到对话（如果可引用）
  if (capabilities.referenceable) {
    items.push({
      id: 'reference',
      label: 'dstu:menu.referenceToChat',
      icon: 'MessageSquarePlus',
      action: async () => {
        if (globalActionHandler?.addToContextRefs) {
          await globalActionHandler.addToContextRefs(node);
        } else {
          console.warn('[DSTU] addToContextRefs handler not registered');
        }
      },
    });
  }

  // 分隔符
  if (items.length > 0) {
    items.push({ id: 'separator-1', type: 'separator', label: '' });
  }

  // ========== 编辑操作 ==========

  // 复制（如果可复制）
  if (capabilities.copyable) {
    items.push({
      id: 'copy',
      label: 'dstu:menu.copy',
      icon: 'Copy',
      action: async () => {
        if (globalActionHandler?.copyResource) {
          await globalActionHandler.copyResource(node.path);
        } else {
          // 默认行为：调用 DSTU API
          const result = await dstu.copy(node.path, `${node.path}_copy`);
          if (!isErr(result)) {
            console.log('[DSTU] Copy successful:', result.value.path);
          } else {
            console.error('[DSTU] Copy failed:', result.error.toUserMessage());
          }
        }
      },
    });
  }

  // 移动（如果可移动）
  if (capabilities.movable) {
    items.push({
      id: 'move',
      label: 'dstu:menu.moveTo',
      icon: 'FolderInput',
      action: () => {
        if (globalActionHandler?.openMoveDialog) {
          globalActionHandler.openMoveDialog(node.path);
        } else {
          console.warn('[DSTU] openMoveDialog handler not registered');
        }
      },
    });
  }

  // 重命名（如果可移动）
  if (capabilities.movable) {
    items.push({
      id: 'rename',
      label: 'dstu:menu.rename',
      icon: 'PenLine',
      action: () => {
        if (globalActionHandler?.startRename) {
          globalActionHandler.startRename(node.path);
        } else {
          console.warn('[DSTU] startRename handler not registered');
        }
      },
    });
  }

  // 分享（如果可分享）
  if (capabilities.shareable) {
    items.push({
      id: 'share',
      label: 'dstu:menu.share',
      icon: 'Share2',
      action: async () => {
        if (globalActionHandler?.shareResource) {
          await globalActionHandler.shareResource(node.path);
        } else {
          console.warn('[DSTU] shareResource handler not registered');
        }
      },
    });
  }

  // 分隔符
  const hasEditOperations = capabilities.copyable || capabilities.movable || capabilities.shareable;
  if (hasEditOperations) {
    items.push({ id: 'separator-2', type: 'separator', label: '' });
  }

  // ========== 历史与删除 ==========

  // 版本历史（如果支持）
  if (capabilities.versionable) {
    items.push({
      id: 'history',
      label: 'dstu:menu.versionHistory',
      icon: 'History',
      action: () => {
        if (globalActionHandler?.openVersionHistory) {
          globalActionHandler.openVersionHistory(node.path);
        } else {
          console.warn('[DSTU] openVersionHistory handler not registered');
        }
      },
    });
  }

  // 删除（如果可删除）
  if (capabilities.deletable) {
    // 如果前面有内容，添加分隔符
    if (items.length > 0 && items[items.length - 1].type !== 'separator') {
      items.push({ id: 'separator-3', type: 'separator', label: '' });
    }

    items.push({
      id: 'delete',
      label: 'dstu:menu.delete',
      icon: 'Trash2',
      variant: 'destructive',
      action: async () => {
        if (globalActionHandler?.confirmDelete) {
          await globalActionHandler.confirmDelete(node.path);
        } else {
          // 默认行为：直接删除（需要确认）
          console.warn('[DSTU] confirmDelete handler not registered, skipping delete');
        }
      },
    });
  }

  // 清理尾部多余的分隔符
  while (items.length > 0 && items[items.length - 1].type === 'separator') {
    items.pop();
  }

  return items;
}

// ============================================================================
// 快捷菜单构建
// ============================================================================

/**
 * 构建简化的快捷菜单（用于工具栏等场景）
 */
export function buildQuickMenu(node: DstuNode): ContextMenuItem[] {
  const entry = editorRegistry[node.type];
  if (!entry) {
    return [];
  }

  const { capabilities } = entry;
  const items: ContextMenuItem[] = [];

  // 打开
  if (node.type !== 'folder') {
    items.push({
      id: 'open',
      label: 'dstu:menu.open',
      icon: 'ExternalLink',
      action: async () => {
        const result = await openResource(node);
        if (isErr(result)) {
          console.error('[DSTU] Open failed:', result.error.toUserMessage());
        }
      },
    });
  }

  // 引用到对话
  if (capabilities.referenceable) {
    items.push({
      id: 'reference',
      label: 'dstu:menu.referenceToChat',
      icon: 'MessageSquarePlus',
      action: async () => {
        if (globalActionHandler?.addToContextRefs) {
          await globalActionHandler.addToContextRefs(node);
        }
      },
    });
  }

  // 删除
  if (capabilities.deletable) {
    items.push({
      id: 'delete',
      label: 'dstu:menu.delete',
      icon: 'Trash2',
      variant: 'destructive',
      action: async () => {
        if (globalActionHandler?.confirmDelete) {
          await globalActionHandler.confirmDelete(node.path);
        }
      },
    });
  }

  return items;
}

// ============================================================================
// 批量操作菜单
// ============================================================================

/**
 * 构建批量操作菜单
 */
export function buildBatchMenu(nodes: DstuNode[]): ContextMenuItem[] {
  if (nodes.length === 0) {
    return [];
  }

  // 检查所有节点的共同能力
  const allDeletable = nodes.every(
    (n) => editorRegistry[n.type]?.capabilities.deletable
  );
  const allMovable = nodes.every(
    (n) => editorRegistry[n.type]?.capabilities.movable
  );
  const allReferenceable = nodes.every(
    (n) => editorRegistry[n.type]?.capabilities.referenceable
  );

  const items: ContextMenuItem[] = [];

  // 批量引用到对话
  if (allReferenceable) {
    items.push({
      id: 'batch-reference',
      label: 'dstu:menu.batchReferenceToChat',
      icon: 'MessageSquarePlus',
      action: async () => {
        if (globalActionHandler?.addToContextRefs) {
          for (const node of nodes) {
            await globalActionHandler.addToContextRefs(node);
          }
        }
      },
    });
  }

  // 批量移动
  if (allMovable && nodes.length > 0) {
    items.push({
      id: 'batch-move',
      label: 'dstu:menu.batchMoveTo',
      icon: 'FolderInput',
      action: () => {
        // 需要特殊处理批量移动
        console.log('[DSTU] Batch move:', nodes.map((n) => n.path));
      },
    });
  }

  // 批量删除
  if (allDeletable) {
    if (items.length > 0) {
      items.push({ id: 'batch-separator', type: 'separator', label: '' });
    }

    items.push({
      id: 'batch-delete',
      label: 'dstu:menu.batchDelete',
      icon: 'Trash2',
      variant: 'destructive',
      action: async () => {
        if (globalActionHandler?.confirmDelete) {
          for (const node of nodes) {
            await globalActionHandler.confirmDelete(node.path);
          }
        }
      },
    });
  }

  return items;
}
