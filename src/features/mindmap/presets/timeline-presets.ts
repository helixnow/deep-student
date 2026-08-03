import type { IPreset } from '../registry/types';

/**
 * 时间轴预设列表
 *
 * 集成需求（其他子代理/后续跟进）：
 * - locales/{zh-CN,en-US}/mindmap.json 需补充 i18n key：
 *   presets.timelineRight、layouts.timeline、layouts.timelineDesc
 * - PresetIcons.tsx 可为 timeline 增加专属图标（当前按 category='logic'
 *   回退到 LogicIcon 渲染）
 */
export const timelinePresets: IPreset[] = [
  {
    id: 'timeline-right',
    name: 'presets.timelineRight',
    category: 'logic',
    layoutId: 'timeline',
    layoutDirection: 'right',
    styleId: 'default',
    edgeType: 'orthogonal',
    locked: false,
  },
];
