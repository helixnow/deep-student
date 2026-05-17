/**
 * OverlayLayer — 嵌套 overlay 的 z-index 管理
 *
 * 解决的问题：
 *   当一个 popover/dialog 内部又打开下拉菜单时，子菜单需要比父级 popover 的
 *   z-index 更高才能正确显示。如果每个调用点都手动算 z-index，工程上很脆弱。
 *
 * 工作机制（与 Floating UI 的 FloatingTree 同源思路）：
 *   - 任何"打开新视觉层"的组件外面包一层 `<OverlayLayerProvider>`
 *   - 该 Provider 自动把 z-index 在父级基础上抬高 `STEP`
 *   - 该 layer 内部的 portal 化组件（菜单、tooltip 等）通过 `useOverlayLayer()`
 *     拿到 baseZ，无需调用方传 z-index
 *
 * 与 OverlayCoordinator 的关系：
 *   - OverlayCoordinator：管 "有 overlay 时关掉所有 tooltip" 之类的副作用
 *   - OverlayLayer：管 "嵌套 overlay 应该如何堆叠"
 *   - 两者正交，任意组合
 *
 * 使用范例：
 *   ```tsx
 *   <OverlayLayerProvider baseZ={Z_INDEX.popover}>
 *     <MyPopover>
 *       <SomeMenu />          // 子菜单自动比 popover 高
 *       <SomeTooltip />       // tooltip 同样自动正确
 *     </MyPopover>
 *   </OverlayLayerProvider>
 *   ```
 */

import React from 'react';
import { Z_INDEX } from '@/config/zIndex';

/** 嵌套层之间的 z-index 间距（足够避免与同层其它元素冲突） */
const LAYER_STEP = 50;

export interface OverlayLayerValue {
  /** 当前层的基准 z-index：内嵌的 portal 元素应使用 ≥ 此值 */
  baseZ: number;
  /** 嵌套深度（最外层为 0） */
  depth: number;
}

const DEFAULT_BASE_Z = Z_INDEX.popover;

const OverlayLayerContext = React.createContext<OverlayLayerValue>({
  baseZ: 0,
  depth: 0,
});

export interface OverlayLayerProviderProps {
  /**
   * 显式指定该层的基准 z-index。
   *
   * - 不传：在父级 baseZ 基础上 + LAYER_STEP（自动抬升一层）
   * - 传值：直接使用，适用于"我知道我的 popover 是哪一档"的场景
   */
  baseZ?: number;
  children: React.ReactNode;
}

export function OverlayLayerProvider({ baseZ, children }: OverlayLayerProviderProps) {
  const parent = React.useContext(OverlayLayerContext);
  // 顶层（depth 0、baseZ 0）时如果没传，从 popover 默认档起步
  const resolvedBase =
    baseZ ?? (parent.baseZ > 0 ? parent.baseZ + LAYER_STEP : DEFAULT_BASE_Z);

  const value = React.useMemo<OverlayLayerValue>(
    () => ({ baseZ: resolvedBase, depth: parent.depth + 1 }),
    [resolvedBase, parent.depth]
  );

  return <OverlayLayerContext.Provider value={value}>{children}</OverlayLayerContext.Provider>;
}

/**
 * 从最近的 OverlayLayerProvider 读取层信息。
 *
 * 没有 Provider 时返回 baseZ=0、depth=0；调用方自行决定是否退化为默认行为。
 */
export function useOverlayLayer(): OverlayLayerValue {
  return React.useContext(OverlayLayerContext);
}

/**
 * 在当前层基础上再抬升一档（例如：从 popover 层进入它内部的 menu 层）。
 *
 * 给 AppMenuContent 这种"我天然比父级 overlay 高一级"的场景使用。
 *
 * - 在 `<OverlayLayerProvider>` 内：返回 baseZ + LAYER_STEP（自动抬升）
 * - 不在 Provider 内：返回 `null`，调用方应保持原有默认（如 CSS 类设定的 z-index）
 *
 * 这样不会污染未使用 Provider 的现有调用点。
 */
export function useNestedOverlayZ(): number | null {
  const { baseZ } = useOverlayLayer();
  return baseZ > 0 ? baseZ + LAYER_STEP : null;
}
