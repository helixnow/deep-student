/**
 * React Flow 框选多选：返回可直接 spread 到 `<ReactFlow>` 的 props，
 * 并把 RF selection 同步进 mindmapStore.selection（不改 store）。
 *
 * 两套预设：
 * - aggressive（默认）：左键拖空白 = 框选；平移改中键/右键，空格仍可临时平移
 * - conservative：保持左键平移；Shift+拖 = 框选
 */

import { useCallback, useMemo } from 'react';
import {
  SelectionMode,
  type KeyCode,
  type OnSelectionChangeFunc,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import type { MindMapStoreApi } from '../store';

export type MarqueeSelectionVariant = 'aggressive' | 'conservative';

export type UseMarqueeSelectionOptions = {
  /** 默认 aggressive */
  variant?: MarqueeSelectionVariant;
};

/**
 * 传给 `<ReactFlow>` 的框选相关 props（不含 nodes/edges 等）。
 * 与现有 canvas props 合并时：本对象后 spread，或显式覆盖同名键。
 */
export type MarqueeReactFlowProps = {
  selectionOnDrag: boolean;
  selectionMode: SelectionMode;
  /** RF12：`number[]` 为允许平移的鼠标按键；`true` 表示默认左键等 */
  panOnDrag: boolean | number[];
  selectionKeyCode: KeyCode | null;
  /** 按住可临时平移；aggressive 保留 Space，与 RF 默认一致 */
  panActivationKeyCode: KeyCode | null;
  onSelectionChange: OnSelectionChangeFunc;
};

export type MarqueeSelectionPreset = Omit<MarqueeReactFlowProps, 'onSelectionChange'>;

/** 激进：左键拖空白框选；平移用中键(1)/右键(2)；空格临时平移 */
export const MARQUEE_SELECTION_AGGRESSIVE: MarqueeSelectionPreset = {
  selectionOnDrag: true,
  selectionMode: SelectionMode.Partial,
  panOnDrag: [1, 2],
  selectionKeyCode: null,
  panActivationKeyCode: 'Space',
};

/** 保守：左键仍平移；Shift+拖框选；部分命中即选中 */
export const MARQUEE_SELECTION_CONSERVATIVE: MarqueeSelectionPreset = {
  selectionOnDrag: false,
  selectionMode: SelectionMode.Partial,
  panOnDrag: true,
  selectionKeyCode: 'Shift',
  panActivationKeyCode: 'Space',
};

export function getMarqueeSelectionPreset(
  variant: MarqueeSelectionVariant = 'aggressive',
): MarqueeSelectionPreset {
  return variant === 'conservative'
    ? MARQUEE_SELECTION_CONSERVATIVE
    : MARQUEE_SELECTION_AGGRESSIVE;
}

/** 从 RF onSelectionChange params 提取 node ids（纯函数，便于单测） */
export function mapSelectionNodeIds(
  params: Pick<OnSelectionChangeParams, 'nodes'>,
): string[] {
  return params.nodes.map((n) => n.id);
}

function selectionIdsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  // RF 顺序不稳定时用集合比较
  if (a.length <= 1) return a[0] === b[0];
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

/**
 * @param storeApi `useMindMapStoreApi()` 返回值（或 createMindMapStore()）
 */
export function useMarqueeSelection(
  storeApi: MindMapStoreApi,
  options: UseMarqueeSelectionOptions = {},
): MarqueeReactFlowProps {
  const variant = options.variant ?? 'aggressive';
  const preset = useMemo(() => getMarqueeSelectionPreset(variant), [variant]);

  const onSelectionChange = useCallback<OnSelectionChangeFunc>(
    (params) => {
      const nextIds = mapSelectionNodeIds(params);
      const current = storeApi.getState().selection;
      if (selectionIdsEqual(current, nextIds)) return;
      storeApi.getState().setSelection(nextIds);
    },
    [storeApi],
  );

  return useMemo(
    () => ({
      ...preset,
      onSelectionChange,
    }),
    [preset, onSelectionChange],
  );
}
