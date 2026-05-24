/**
 * 布局模块统一导出和注册
 */

import { LayoutRegistry } from '../registry';
import { TreeLayoutEngine } from './mindmap/TreeLayoutEngine';
import { BalancedLayoutEngine } from './mindmap/BalancedLayoutEngine';
import { LogicTreeLayoutEngine, LogicBalancedLayoutEngine } from './logic';
import { VerticalOrgChartEngine, HorizontalOrgChartEngine } from './orgchart';

// 创建布局引擎实例
export const treeLayout = new TreeLayoutEngine();
export const balancedLayout = new BalancedLayoutEngine();
export const logicTreeLayout = new LogicTreeLayoutEngine();
export const logicBalancedLayout = new LogicBalancedLayoutEngine();

// 组织结构图布局引擎实例
export const verticalOrgChart = new VerticalOrgChartEngine();
export const horizontalOrgChart = new HorizontalOrgChartEngine();

/**
 * 注册内置布局引擎
 * 
 * 在应用启动时调用此函数以注册所有内置布局引擎
 */
export function registerBuiltinLayouts(): void {
  // 思维导图布局
  LayoutRegistry.register(treeLayout);
  LayoutRegistry.register(balancedLayout);
  
  // 逻辑图布局
  LayoutRegistry.register(logicTreeLayout);
  LayoutRegistry.register(logicBalancedLayout);
  
  // 组织结构图布局
  LayoutRegistry.register(verticalOrgChart);
  LayoutRegistry.register(horizontalOrgChart);
}

// 导出基类
export * from './base';

// 导出思维导图布局
export * from './mindmap';

// 导出逻辑图布局
export * from './logic';

// 导出组织结构图布局
export * from './orgchart';
