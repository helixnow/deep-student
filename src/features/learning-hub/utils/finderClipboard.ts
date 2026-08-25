/**
 * Finder 内部剪贴板（复制 / 粘贴 / 制造副本，对标访达 Duplicate）
 *
 * 刻意保持轻量：应用内全局单例，只记录「粘贴时怎么重建」所需的最小信息
 * （id + 名称 + 类型），不复制内容本体——真正的复制由后端 dstu_copy 完成。
 * 不写系统剪贴板：DSTU 资源没有跨应用可移植的表示，系统剪贴板留给文本复制。
 *
 * 路径约定（与 finderUndoStack 反向 rename 同理，防 stale path）：
 * - src 一律用 `/{id}`：后端 extract_resource_info 按 ID 前缀推断类型，
 *   与项被移动/改名后的旧 path 无关；
 * - dst 用 `/{folderId}`（fld_/UUID 会被识别为 folders），根目录用 '/'。
 */

import type { DstuNode, DstuNodeType } from '@/dstu/types';

/** 剪贴板单项：粘贴所需最小信息 */
export interface FinderClipboardEntry {
  id: string;
  name: string;
  type: DstuNodeType;
}

export interface FinderClipboardState {
  entries: FinderClipboardEntry[];
  copiedAt: number;
}

/**
 * 后端 dstu_copy 不支持的类型。
 * retrieval 节点的 ID（res_）会被 extract_resource_info 解析为 resources，
 * 落入 dstu_copy 的未知分支报错，在前端直接排除。
 */
const NON_COPYABLE_TYPES: ReadonlySet<DstuNodeType> = new Set(['retrieval']);

/** 该节点能否进入复制剪贴板（folder 支持：后端递归复制） */
export function isCopyableNode(node: Pick<DstuNode, 'type'>): boolean {
  return !NON_COPYABLE_TYPES.has(node.type);
}

/** 复制源路径：一律 `/{id}`，避免移动/改名后的 stale path */
export function buildCopySrcPath(entry: Pick<FinderClipboardEntry, 'id'>): string {
  return `/${entry.id}`;
}

/** 粘贴目标路径：`/{folderId}` 或根目录 '/' */
export function buildPasteDstPath(folderId: string | null): string {
  return folderId ? `/${folderId}` : '/';
}

/** 把 DstuNode 列表规整为剪贴板条目（过滤不可复制类型） */
export function toClipboardEntries(
  nodes: ReadonlyArray<Pick<DstuNode, 'id' | 'name' | 'type'>>,
): FinderClipboardEntry[] {
  return nodes
    .filter(isCopyableNode)
    .map((node) => ({ id: node.id, name: node.name, type: node.type }));
}

export interface FinderClipboard {
  /** 写入剪贴板（空数组视为 no-op，保留原内容） */
  copy: (entries: FinderClipboardEntry[]) => void;
  /** 当前剪贴板内容；空时返回 null */
  get: () => FinderClipboardState | null;
  clear: () => void;
  /** 订阅变化（返回取消函数）；用于粘贴菜单项的可用态 */
  subscribe: (listener: () => void) => () => void;
}

export function createFinderClipboard(): FinderClipboard {
  let state: FinderClipboardState | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    copy: (entries) => {
      if (entries.length === 0) return;
      state = { entries: [...entries], copiedAt: Date.now() };
      notify();
    },
    get: () => state,
    clear: () => {
      if (!state) return;
      state = null;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 全局单例：与 finderStore / finderUndoStack 同作用域语义
 * （多个 files 宿主共享，跨文件夹/跨窗口复制粘贴）。
 */
export const finderClipboard = createFinderClipboard();
