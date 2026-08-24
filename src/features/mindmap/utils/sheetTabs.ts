/**
 * 多 sheet 切换器的纯逻辑（消费 meta.sheets）。
 *
 * meta.sheets 只在多 sheet 导入时写入，记录「哪个一级子节点来自哪个源 sheet」。
 * 切换器把 viewRootId 聚焦到对应一级子树（侵入最小的多画布形态），因此：
 * - sheet 根节点被删除后对应项自动消失（按当前一级子节点过滤）；
 * - 存活 sheet 不足 2 个时不显示切换器（单树模型不受多 sheet 概念打扰）。
 */

import type { MindMapDocument, MindMapSheetMeta } from '../types';
import { getAncestors } from './node/traverse';

/**
 * 返回仍有对应一级子节点存活的 sheet 列表；
 * 不足 2 个（含 meta.sheets 缺失）返回 null = 不显示切换器。
 */
export function getAliveSheetTabs(document: MindMapDocument): MindMapSheetMeta[] | null {
  const sheets = document.meta.sheets;
  if (!sheets || sheets.length < 2) return null;
  const childIds = new Set(document.root.children.map((child) => child.id));
  const alive = sheets.filter((sheet) => childIds.has(sheet.rootNodeId));
  return alive.length >= 2 ? alive : null;
}

/**
 * 当前视图归属的 sheet：viewRootId 是某 sheet 根、或其子孙（继续下钻）时命中。
 * 全图（viewRootId 为空/等于文档根）返回 null = 「全部」。
 */
export function resolveActiveSheet(
  document: MindMapDocument,
  sheetTabs: MindMapSheetMeta[] | null,
  viewRootId: string | null,
): MindMapSheetMeta | null {
  if (!sheetTabs || !viewRootId) return null;
  if (viewRootId === document.root.id) return null;
  const ancestorIds = new Set(
    getAncestors(document.root, viewRootId).map((node) => node.id),
  );
  return sheetTabs.find(
    (sheet) => sheet.rootNodeId === viewRootId || ancestorIds.has(sheet.rootNodeId),
  ) ?? null;
}
