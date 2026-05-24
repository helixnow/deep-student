import type { IPreset } from '../registry/types';

/** 组织结构图预设列表 */
export const orgchartPresets: IPreset[] = [
  {
    id: 'orgchart-vertical-down',
    name: 'presets.orgchartDown',
    category: 'orgchart',
    layoutId: 'orgchart-vertical',
    layoutDirection: 'down',
    styleId: 'default',
    edgeType: 'smoothstep', // 使用 ReactFlow 内置的 smoothstep 边
    locked: false,
  },
  {
    id: 'orgchart-vertical-up',
    name: 'presets.orgchartUp',
    category: 'orgchart',
    layoutId: 'orgchart-vertical',
    layoutDirection: 'up',
    styleId: 'default',
    edgeType: 'smoothstep',
    locked: false,
  },
  {
    id: 'orgchart-horizontal-right',
    name: 'presets.orgchartRight',
    category: 'orgchart',
    layoutId: 'orgchart-horizontal',
    layoutDirection: 'right',
    styleId: 'default',
    edgeType: 'smoothstep',
    locked: false,
  },
  {
    id: 'orgchart-horizontal-left',
    name: 'presets.orgchartLeft',
    category: 'orgchart',
    layoutId: 'orgchart-horizontal',
    layoutDirection: 'left',
    styleId: 'default',
    edgeType: 'smoothstep',
    locked: false,
  },
];
