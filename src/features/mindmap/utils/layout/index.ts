/**
 * 布局工具聚合导出
 *
 * 旧的 calculateTreeLayout/calculateBalancedLayout 函数式实现已删除，
 * 生产布局统一走 layouts/* 下的引擎类（TreeLayoutEngine、BalancedLayoutEngine 等）。
 */

// 辅助函数
export {
  estimateTextWidth,
  calculateNodeWidth,
  calculateNodeHeight,
  calculateSubtreeHeight,
  calculateSubtreeSize,
  calculateBounds,
  resolveSubtreeOverlaps,
  recenterParents,
  resolveSubtreeOverlapsX,
  recenterParentsX,
  normalizeLayoutRoot,
} from './helpers';

export { countAllDescendants, MAX_TREE_DEPTH } from './countDescendants';

// 兄弟子树轮廓紧凑（Tree/Balanced 引擎后处理，可经 config.compactSiblings 关闭）
export {
  compactSiblingSubtrees,
  isCompactionEnabled,
  type CompactionLayoutConfig,
} from './compactTree';

// 间距档位（DEFAULT/COMPACT/SPACIOUS 接入点，上层 UI 从这里取）
export {
  SPACING_TIERS,
  SPACING_TIER_CONFIGS,
  normalizeSpacingTier,
  resolveSpacingConfig,
  type SpacingTier,
} from './spacingPresets';
