/**
 * 边「强调」通道（父节点选中 → 出边高亮）。
 *
 * 树边 selectable: false（避免抢节点交互），因此不走 edge.selected，
 * 而是由 Canvas（W03 所有）在 styledEdges 中为选中节点的出边设置
 * `data.emphasized = true`；各边组件消费该字段做 stroke 加粗/主色（禁 filter）。
 *
 * 契约：edge.data.emphasized?: boolean —— Canvas 侧未接线前本通道静默不生效。
 */

import type React from 'react';

export function getEdgeEmphasis(data: unknown): boolean {
  return (data as { emphasized?: boolean } | undefined)?.emphasized === true;
}

/** 强调态内联样式：置于 ...style 之后，覆盖 Canvas 传入的主题描边 */
export function emphasizedEdgeStyle(emphasized: boolean): React.CSSProperties {
  if (!emphasized) return {};
  return {
    stroke: 'var(--mm-primary)',
    strokeWidth: 2.25,
  };
}

export function withEmphasisClass(base: string, emphasized: boolean): string {
  return emphasized ? `${base} mm-edge-emphasized` : base;
}
