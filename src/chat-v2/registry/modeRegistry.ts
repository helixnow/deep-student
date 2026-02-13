/**
 * Chat V2 - 模式注册表
 *
 * 管理会话模式插件的注册和获取
 */

import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';
import { Registry } from './Registry';
import type { ComponentType } from 'react';

// ============================================================================
// 模式配置
// ============================================================================

/**
 * 模式配置
 */
export interface ModeConfig {
  /** OCR 相关 */
  requiresOcr: boolean;
  ocrTiming?: 'before' | 'parallel';

  /** 初始化行为 */
  autoStartFirstMessage: boolean;

  /** 特殊功能 */
  hasPageNavigation?: boolean;
  injectCurrentPage?: boolean;
  inheritOcrFrom?: 'source';
  bidirectionalLink?: boolean;

  /** 系统提示模板 */
  systemPromptTemplate?: string;

  /** 启用的工具列表 */
  enabledTools?: string[];
}

// ============================================================================
// 模式插件接口
// ============================================================================

/**
 * 系统提示构建上下文
 */
export interface SystemPromptContext {
  /** 会话 ID */
  sessionId: string;
  /** 模式名称 */
  mode: string;
  /** 模式状态 */
  modeState?: Record<string, unknown> | null;
  /** 用户输入内容 */
  userInput?: string;
  /** 额外上下文 */
  extra?: Record<string, unknown>;
}

/**
 * 模式初始化配置
 */
export interface ModeInitConfig {
  /** 初始 images（analysis 模式） */
  images?: string[];
  /** 源会话 ID（bridge 模式） */
  sourceSessionId?: string;
  /** 题目索引（bridge 模式） */
  questionIndex?: number;
  /** 继承的 OCR 元数据（bridge 模式） */
  inheritedOcrMeta?: Record<string, unknown>;
  /** 教材路径（textbook 模式） */
  textbookPath?: string;
  /** 其他扩展字段 */
  [key: string]: unknown;
}

/**
 * 模式插件接口
 */
export interface ModePlugin {
  /** 模式名称 */
  name: string;

  /**
   * 继承的基础模式
   * 
   * 扩展模式可以声明继承自另一个模式，自动获得其所有面板和工具配置。
   * 扩展模式自己定义的字段会覆盖基础模式的同名字段。
   * 
   * @example
   * ```ts
   * // analysis 模式继承 chat 的所有面板，只需定义自己的 Header
   * modeRegistry.register('analysis', {
   *   extends: 'chat',
   *   renderHeader: OcrResultHeader,
   *   // ... analysis 特有的配置
   * });
   * ```
   */
  extends?: string;

  /** 模式配置 */
  config: ModeConfig;

  /**
   * 初始化回调
   * @param store - ChatStore 实例
   * @param initConfig - 可选的初始化配置（如 images, sourceSessionId 等）
   */
  onInit?: (store: ChatStore, initConfig?: ModeInitConfig) => Promise<void>;

  /** 发送消息时的回调（可拦截） */
  onSendMessage?: (store: ChatStore, content: string) => void;

  /**
   * 构建系统提示
   * 根据上下文生成动态系统提示
   */
  buildSystemPrompt?: (context: SystemPromptContext) => string;

  /**
   * 获取启用的工具列表
   * 返回该模式下应启用的工具 ID 列表
   */
  getEnabledTools?: (store: ChatStore) => string[];

  /** 自定义 Header 组件（接收 StoreApi 用于 useStore 响应式订阅） */
  renderHeader?: ComponentType<{ store: StoreApi<ChatStore> }>;

  /** 自定义 Footer 组件（接收 StoreApi 用于 useStore 响应式订阅） */
  renderFooter?: ComponentType<{ store: StoreApi<ChatStore> }>;

  /** 输入栏左侧扩展按钮 */
  renderInputBarLeft?: ComponentType<{ store: StoreApi<ChatStore> }>;

  /** 输入栏右侧扩展按钮 */
  renderInputBarRight?: ComponentType<{ store: StoreApi<ChatStore> }>;

  /** 自定义 RAG 面板（替换默认面板） */
  renderRagPanel?: ComponentType<{ store: StoreApi<ChatStore>; onClose: () => void }>;

  /** 自定义模型选择面板 */
  renderModelPanel?: ComponentType<{ store: StoreApi<ChatStore>; onClose: () => void }>;

  /** 自定义高级设置面板 */
  renderAdvancedPanel?: ComponentType<{ store: StoreApi<ChatStore>; onClose: () => void }>;

  /** 学习模式面板 */
  renderLearnModePanel?: ComponentType<{ store: StoreApi<ChatStore>; onClose: () => void }>;

  /** MCP 工具面板 */
  renderMcpPanel?: ComponentType<{ store: StoreApi<ChatStore>; onClose: () => void }>;
}

// ============================================================================
// 模式注册表实例
// ============================================================================

// ============================================================================
// 模式注册表类（支持继承）
// ============================================================================

/**
 * 支持继承的模式注册表
 * 
 * 扩展自通用 Registry，增加了继承解析能力。
 */
class ModeRegistry extends Registry<ModePlugin> {
  constructor() {
    super('ModeRegistry');
  }

  /**
   * 获取解析后的模式插件（自动合并继承链）
   * 
   * @param key 模式名称
   * @returns 合并了继承链的完整插件，不存在则返回 undefined
   * 
   * @example
   * ```ts
   * // analysis extends chat
   * const resolved = modeRegistry.getResolved('analysis');
   * // resolved 包含 chat 的所有面板 + analysis 的 Header
   * ```
   */
  getResolved(key: string): ModePlugin | undefined {
    const plugin = this.get(key);
    if (!plugin) return undefined;

    // 无继承，直接返回
    if (!plugin.extends) return plugin;

    // 递归获取基础模式（支持多级继承）
    const basePlugin = this.getResolved(plugin.extends);
    if (!basePlugin) {
      console.warn(`[ModeRegistry] Base mode '${plugin.extends}' not found for '${key}'`);
      return plugin;
    }

    // 合并：基础模式 + 当前模式（当前模式覆盖基础模式）
    return {
      ...basePlugin,
      ...plugin,
      // 特殊处理 config：深度合并
      config: {
        ...basePlugin.config,
        ...plugin.config,
        // enabledTools 取当前模式的，若未定义则取基础模式的
        enabledTools: plugin.config.enabledTools ?? basePlugin.config.enabledTools,
      },
      // name 始终使用当前模式的
      name: plugin.name,
    };
  }
}

/**
 * 模式注册表单例
 */
export const modeRegistry = new ModeRegistry();
