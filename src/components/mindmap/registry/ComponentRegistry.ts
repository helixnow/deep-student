/**
 * 组件注册表
 * 
 * 管理所有节点组件和边组件的注册和获取
 */

import type { INodeComponentConfig, IEdgeComponentConfig, EdgeType } from './types';

class ComponentRegistryClass {
  private nodes = new Map<string, INodeComponentConfig>();
  private edges = new Map<string, IEdgeComponentConfig>();

  // ============================================================================
  // 节点组件管理
  // ============================================================================

  /**
   * 注册节点组件
   */
  registerNode(config: INodeComponentConfig): void {
    this.nodes.set(config.id, config);
  }

  /**
   * 获取节点组件配置
   */
  getNode(id: string): INodeComponentConfig | undefined {
    return this.nodes.get(id);
  }

  /**
   * 获取所有节点组件配置
   */
  getAllNodes(): INodeComponentConfig[] {
    return Array.from(this.nodes.values());
  }

  /**
   * 获取节点类型映射（用于 ReactFlow）
   */
  getNodeTypes(): Record<string, React.ComponentType<any>> {
    const types: Record<string, React.ComponentType<any>> = {};
    this.nodes.forEach((config, id) => {
      types[id] = config.component;
    });
    return types;
  }

  /**
   * 检查节点组件是否存在
   */
  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * 移除节点组件
   */
  unregisterNode(id: string): boolean {
    return this.nodes.delete(id);
  }

  // ============================================================================
  // 边组件管理
  // ============================================================================

  /**
   * 注册边组件
   */
  registerEdge(config: IEdgeComponentConfig): void {
    this.edges.set(config.id, config);
  }

  /**
   * 获取边组件配置
   */
  getEdge(id: string): IEdgeComponentConfig | undefined {
    return this.edges.get(id);
  }

  /**
   * 按类型获取边组件配置
   */
  getEdgeByType(type: EdgeType): IEdgeComponentConfig | undefined {
    return Array.from(this.edges.values()).find(e => e.type === type);
  }

  /**
   * 获取所有边组件配置
   */
  getAllEdges(): IEdgeComponentConfig[] {
    return Array.from(this.edges.values());
  }

  /**
   * 获取边类型映射（用于 ReactFlow）
   */
  getEdgeTypes(): Record<string, React.ComponentType<any>> {
    const types: Record<string, React.ComponentType<any>> = {};
    this.edges.forEach((config, id) => {
      types[id] = config.component;
    });
    return types;
  }

  /**
   * 检查边组件是否存在
   */
  hasEdge(id: string): boolean {
    return this.edges.has(id);
  }

  /**
   * 移除边组件
   */
  unregisterEdge(id: string): boolean {
    return this.edges.delete(id);
  }

  // ============================================================================
  // 通用方法
  // ============================================================================

  /**
   * 清空所有节点组件注册
   */
  clearNodes(): void {
    this.nodes.clear();
  }

  /**
   * 清空所有边组件注册
   */
  clearEdges(): void {
    this.edges.clear();
  }

  /**
   * 清空所有注册
   */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }

  /**
   * 获取节点组件注册数量
   */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * 获取边组件注册数量
   */
  get edgeCount(): number {
    return this.edges.size;
  }
}

export const ComponentRegistry = new ComponentRegistryClass();
