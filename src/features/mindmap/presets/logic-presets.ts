import type { IPreset } from '../registry/types';

/** 逻辑图预设列表 */
export const logicPresets: IPreset[] = [
  {
    id: 'logic-tree-right',
    name: 'presets.logicTreeRight',
    category: 'logic',
    layoutId: 'logic-tree',
    layoutDirection: 'right',
    styleId: 'default',
    edgeType: 'orthogonal',
    locked: false,
  },
  {
    id: 'logic-tree-left',
    name: 'presets.logicTreeLeft',
    category: 'logic',
    layoutId: 'logic-tree',
    layoutDirection: 'left',
    styleId: 'default',
    edgeType: 'orthogonal',
    locked: false,
  },
  {
    id: 'logic-balanced',
    name: 'presets.logicBalanced',
    category: 'logic',
    layoutId: 'logic-balanced',
    layoutDirection: 'both',
    styleId: 'default',
    edgeType: 'orthogonal',
    locked: false,
  },
];
