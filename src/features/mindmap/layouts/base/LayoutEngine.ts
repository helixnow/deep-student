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
    return node.children.reduce(
      (sum, child) => sum + 1 + this.countAllDescendants(child, depth + 1),
      0
    );
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
