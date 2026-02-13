import { PresetRegistry } from '../registry';
import { mindmapPresets } from './mindmap-presets';
import { logicPresets } from './logic-presets';
import { orgchartPresets } from './orgchart-presets';

export { mindmapPresets } from './mindmap-presets';
export { logicPresets } from './logic-presets';
export { orgchartPresets } from './orgchart-presets';

/** 所有内置预设 */
export const allPresets = [
  ...mindmapPresets,
  ...logicPresets,
  ...orgchartPresets,
];

/** 注册所有内置预设 */
export function registerBuiltinPresets(): void {
  allPresets.forEach(preset => {
    PresetRegistry.register(preset);
  });
}

/** 根据分类获取预设 */
export function getPresetsByCategory(category: 'mindmap' | 'logic' | 'orgchart') {
  return allPresets.filter(p => p.category === category);
}
