import type { IPreset } from '../registry/types';

/** 思维导图预设列表 */
export const mindmapPresets: IPreset[] = [
  // 树形布局 - 向右
  {
    id: 'mindmap-tree-right',
    name: 'presets.mindmapTreeRight',
    category: 'mindmap',
    layoutId: 'tree',
    layoutDirection: 'right',
    styleId: 'default',
    edgeType: 'bezier',
    locked: false,
  },
  // 树形布局 - 向左
  {
    id: 'mindmap-tree-left',
    name: 'presets.mindmapTreeLeft',
    category: 'mindmap',
    layoutId: 'tree',
    layoutDirection: 'left',
    styleId: 'default',
    edgeType: 'bezier',
    locked: false,
  },
  // 平衡布局
  {
    id: 'mindmap-balanced',
    name: 'presets.mindmapBalanced',
    category: 'mindmap',
    layoutId: 'balanced',
    layoutDirection: 'both',
    styleId: 'default',
    edgeType: 'bezier',
    locked: false,
  },
];
