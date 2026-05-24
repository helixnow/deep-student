import { useMemo } from 'react';
import type { FolderTreeNode } from '@/dstu/types/folder';

export interface UseVfsFoldersOptions {
  /** 预加载的文件夹树 */
  root?: FolderTreeNode[];
}

export interface UseVfsFoldersReturn {
  tree: FolderTreeNode[];
  flattenFolderTree: (nodes: FolderTreeNode[]) => FolderTreeNode[];
  findFolderInTree: (nodes: FolderTreeNode[], folderId: string) => FolderTreeNode | null;
  getFolderBreadcrumb: (nodes: FolderTreeNode[], folderId: string) => FolderTreeNode[];
}

/** 深度优先展开文件夹树，返回所有节点（不含 items） */
export function flattenFolderTree(nodes: FolderTreeNode[]): FolderTreeNode[] {
  const result: FolderTreeNode[] = [];
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    result.push(node);
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }
  return result;
}

/** 在树中查找指定文件夹节点 */
export function findFolderInTree(nodes: FolderTreeNode[], folderId: string): FolderTreeNode | null {
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.folder.id === folderId) return node;
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }
  return null;
}

/** 生成从根到指定节点的面包屑（不包含 items） */
export function getFolderBreadcrumb(nodes: FolderTreeNode[], folderId: string): FolderTreeNode[] {
  const path: FolderTreeNode[] = [];
  const dfs = (list: FolderTreeNode[], target: string): boolean => {
    for (const node of list) {
      path.push(node);
      if (node.folder.id === target) return true;
      if (node.children?.length && dfs(node.children, target)) return true;
      path.pop();
    }
    return false;
  };
  dfs(nodes, folderId);
  return [...path];
}

/** Hook 封装，便于按需提供树并复用工具函数 */
export function useVfsFolders(options?: UseVfsFoldersOptions): UseVfsFoldersReturn {
  const tree = useMemo<FolderTreeNode[]>(() => options?.root ?? [], [options?.root]);
  return {
    tree,
    flattenFolderTree,
    findFolderInTree,
    getFolderBreadcrumb,
  };
}
