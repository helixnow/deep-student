/**
 * 布局引擎基类
 */

import type { MindMapNode, LayoutConfig, LayoutResult } from '../../types';
import type { ILayoutEngine, LayoutCategory, LayoutDirection } from '../../registry/types';
import {
  MAX_TREE_DEPTH,
  countAllDescendants as countAllDescendantsCached,
} from '../../utils/layout/countDescendants';

export { MAX_TREE_DEPTH };

/**
 * 布局引擎抽象基类
 *
 * 所有布局引擎都应继承此类并实现 calculate 方法。
 *
 * ## 节点 data 契约（所有引擎必须一致）
 *
 * - `hasChildren`：节点是否拥有子节点（`children.length > 0`），
 *   **与折叠状态无关**——折叠节点仍为 true，折叠按钮/子数徽章依赖它。
 * - `collapsed`：折叠状态单独下发，渲染层自行组合两者语义。
 * - `childCount`：全部后代数量（countAllDescendants），**不按折叠剪枝**
 *   ——折叠徽章需要显示「被折叠隐藏的后代总数」。
 * - 折叠子树不产出布局节点/边（零占位），展开时由上层动画缓冲。
 *
 * ## 入口防御
 *
 * calculate 入口须先经 normalizeLayoutRoot 规范化根节点
 * （children 缺失补 []），深层节点由各递归的 guard 兜底。
 *
 * ## 深度截断信号
 *
 * 深度超过 MAX_TREE_DEPTH 时除 console.warn 外，返回的 bounds 须带
 * `truncated: true`（见 registry/types.ts 的 LayoutBoundsWithMeta），
 * 供上层提示用户部分节点未被布局。
 */
export abstract class BaseLayoutEngine implements ILayoutEngine {
  /** 唯一标识 */
  abstract id: string;
  /** 中文名称 */
  abstract name: string;
  /** 英文名称 */
  abstract nameEn: string;
  /** 描述 */
  abstract description: string;
  /** 布局类别 */
  abstract category: LayoutCategory;
  /** 支持的方向 */
  abstract directions: LayoutDirection[];
  /** 默认方向 */
  abstract defaultDirection: LayoutDirection;
  
  /**
   * 自定义节点组件（可选）
   * 子类可以覆盖此属性来注册自定义节点组件
   */
  customNodeTypes?: Record<string, React.ComponentType<any>>;
  
  /**
   * 自定义边组件（可选）
   * 子类可以覆盖此属性来注册自定义边组件
   */
  customEdgeTypes?: Record<string, React.ComponentType<any>>;

  /**
   * 计算布局（抽象方法，子类必须实现）
   * @param root 根节点
   * @param config 布局配置
   * @param direction 布局方向
   * @returns 布局结果
   */
  abstract calculate(
    root: MindMapNode,
    config: LayoutConfig,
    direction: LayoutDirection
  ): LayoutResult;

  /**
   * 计算所有后代数量（委托共享 WeakMap 缓存实现，O(n)）
   * @param node 节点
   * @param depth 当前深度（用于限制递归）
   * @returns 后代数量
   */
  protected countAllDescendants(node: MindMapNode, depth: number = 0): number {
    return countAllDescendantsCached(node, depth);
  }

  /**
   * 检查深度是否超出限制
   * @param depth 当前深度
   * @returns 是否超出限制
   */
  protected isDepthExceeded(depth: number): boolean {
    if (depth > MAX_TREE_DEPTH) {
      console.warn(`[LayoutEngine] Tree depth exceeds limit (${MAX_TREE_DEPTH})`);
      return true;
    }
    return false;
  }

  /**
   * 验证方向是否支持
   * @param direction 方向
   * @returns 是否支持
   */
  protected isDirectionSupported(direction: LayoutDirection): boolean {
    return this.directions.includes(direction);
  }

  /**
   * 获取有效方向（如果不支持则返回默认方向）
   * @param direction 方向
   * @returns 有效方向
   */
  protected getValidDirection(direction: LayoutDirection): LayoutDirection {
    return this.isDirectionSupported(direction) ? direction : this.defaultDirection;
  }
}
