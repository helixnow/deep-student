/**
 * 布局引擎基类
 */

import type { MindMapNode, LayoutConfig, LayoutResult } from '../../types';
import type { ILayoutEngine, LayoutCategory, LayoutDirection } from '../../registry/types';

/**
 * 最大树深度限制，防止栈溢出
 * ★ P0 修复：添加递归深度限制
 */
export const MAX_TREE_DEPTH = 500;

/**
 * ★ 2026-07-08（审计 27-P1-1）：子树后代数缓存。
 *
 * 布局递归到每个节点时都会调用 countAllDescendants 重新递归整棵子树，
 * 整体复杂度 O(n²)；千级节点导图每次键入触发的全量布局可达数百万次节点访问。
 *
 * 文档树由 immer 管理（结构共享 + freeze）：任何编辑只会替换被改路径上的节点对象，
 * 未变化的子树保持对象身份。以节点对象为键的 WeakMap 缓存因此天然正确失效——
 * 子树变化 → 新对象 → 缓存未命中；子树未变 → 命中，单次布局降为 O(n)，
 * 跨布局运行（键入、测高 flush）还能复用未变子树的计数。
 *
 * 注意：缓存使 MAX_TREE_DEPTH 截断变为"相对各子树根"的深度上限
 * （命中缓存的子树按其自身为根计的深度截断）。该上限仅为栈溢出保护，
 * 对深度 ≤ 500 的正常导图结果完全一致。
 */
const descendantCountCache = new WeakMap<MindMapNode, number>();

/**
 * 布局引擎抽象基类
 * 
 * 所有布局引擎都应继承此类并实现 calculate 方法
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
   * 计算所有后代数量
   * ★ P0 修复：添加深度限制，防止栈溢出
   * @param node 节点
   * @param depth 当前深度（用于限制递归）
   * @returns 后代数量
   */
  protected countAllDescendants(node: MindMapNode, depth: number = 0): number {
    if (!node.children || depth > MAX_TREE_DEPTH) return 0;
    const cached = descendantCountCache.get(node);
    if (cached !== undefined) return cached;
    let sum = 0;
    for (const child of node.children) {
      sum += 1 + this.countAllDescendants(child, depth + 1);
    }
    descendantCountCache.set(node, sum);
    return sum;
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
