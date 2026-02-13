/**
 * 节点操作工具聚合导出
 */

// 创建
export {
  generateNodeId,
  createNode,
  createRootNode,
  cloneNode,
} from './create';

// 遍历
export type { TraverseCallback } from './traverse';
export {
  traverseDFS,
  traverseBFS,
  flattenVisibleNodes,
  flattenAllNodes,
  getAncestors,
  countNodes,
  getMaxDepth,
} from './traverse';

// 查找
export {
  findNodeById,
  findNodeWithParent,
  findNodeByPath,
  findParentNode,
  isDescendantOf,
  searchNodes,
  getNextSibling,
  getPrevSibling,
  getFirstChild,
  isAncestor,
} from './find';

// 更新
export {
  updateNode,
  updateNodeText,
  toggleCollapse,
  toggleComplete,
  expandToNode,
  collapseAll,
  expandAll,
  expandToDepth,
} from './update';

// 删除
export {
  deleteNode,
  deleteNodeAndPromoteChildren,
  deleteNodes,
  clearChildren,
} from './delete';

// 挖空（背诵模式）
export type { TextSegment } from './blankRanges';
export {
  mergeRanges,
  validateRanges,
  splitTextByRanges,
  countBlankProgress,
} from './blankRanges';

// 移动
export {
  addNode,
  insertNode,
  moveNode,
  moveNodeByDrop,
  indentNode,
  outdentNode,
  addSiblingAfter,
  addSiblingBefore,
  addChild,
} from './move';

