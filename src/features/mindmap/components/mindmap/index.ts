/**
 * 思维导图视图组件聚合导出
 */

// 画布
export { MindMapCanvas } from './MindMapCanvas';

// 结构选择器
export { StructureSelector } from './StructureSelector';

// 预设图标
export { PresetIcon, MindMapIcon, LogicIcon, OrgChartIcon } from './PresetIcons';

// 节点
export * from './nodes';

// 边
export * from './edges';

// 视图（保留兼容）
export { MindMapViewNew } from './MindMapViewNew';

// 嵌入式组件（保留兼容）
export { MindMapEmbed } from './MindMapEmbed';
export type { MindMapEmbedProps } from './MindMapEmbed';

