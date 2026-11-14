/**
 * Chat V2 - 块渲染注册表
 *
 * 管理块渲染组件的注册和获取
 */

import type { Block } from '../core/types';
import { Registry } from './Registry';
import type { ComponentType } from 'react';

// ============================================================================
// 块渲染插件接口
// ============================================================================

/**
 * 块渲染组件 Props
 */
export interface BlockComponentProps {
  /** 块数据 */
  block: Block;
  /** 是否正在流式生成 */
  isStreaming?: boolean;
  /** 🔧 P1-24: Store 实例，用于块级操作（如重试） */
  store?: import('zustand').StoreApi<import('../core/types').ChatStore>;
  /** 🆕 继续执行回调（tool_limit 块使用） */
  onContinue?: () => Promise<void>;
}

/**
 * 中断时的行为
 */
export type OnAbortBehavior = 'keep-content' | 'mark-error';

/**
 * 块渲染插件接口
 */
export interface BlockRendererPlugin {
  /** 块类型 */
  type: string;

  /** 渲染组件 */
  component: ComponentType<BlockComponentProps>;

  /** 中断时的行为 */
  onAbort?: OnAbortBehavior;
}

// ============================================================================
// 块渲染注册表实例
// ============================================================================

/**
 * 块渲染注册表单例
 */
export const blockRegistry = new Registry<BlockRendererPlugin>('BlockRegistry', {
  warnOnOverwrite: true,
});

// UI 内核装配（ui-kernel/bootstrap.ts）只导入本模块，事件与模式注册表经此一并交给内核。
export { eventRegistry } from './eventRegistry';
export { modeRegistry } from './modeRegistry';
