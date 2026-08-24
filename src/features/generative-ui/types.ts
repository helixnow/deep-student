/**
 * Generative UI — 结构化意图类型
 *
 * 模型只输出 JSON 意图，应用侧映射到受控组件库。
 */

import type { ComponentType } from 'react';
import type { z } from 'zod';

/** 单个 UI 块的 props 基类 */
export interface GenerativeBlockProps {
  /** 块在布局中的唯一 id（可选，用于 action 回调） */
  id?: string;
}

/** 注册表中的组件配置 */
export interface GenerativeComponentConfig<TProps extends GenerativeBlockProps = GenerativeBlockProps> {
  /** 块 type，与模型输出 JSON 中的 type 对应 */
  type: string;
  /** 受控 React 组件 */
  component: ComponentType<TProps>;
  /** Zod schema，校验 props */
  propsSchema: z.ZodType<TProps>;
  /** 人类可读描述，注入 prompt */
  description?: string;
  /** 是否允许在流式阶段部分渲染 */
  allowPartialRender?: boolean;
}

/** 模型输出的单个块意图 */
export interface GenerativeBlockIntent {
  type: string;
  props?: Record<string, unknown>;
  id?: string;
}

/** 模型输出的完整 UI 意图文档 */
export interface GenerativeUIIntent {
  version?: '1';
  blocks: GenerativeBlockIntent[];
  meta?: {
    title?: string;
    description?: string;
  };
}

/** 解析结果 */
export type ParseResult =
  | { ok: true; intent: GenerativeUIIntent }
  | { ok: false; errors: string[]; fallback?: GenerativeUIIntent };

/** 用户可对 AI 生成块执行的操作 */
export type GenerativeUIAction =
  | { type: 'accept' }
  | { type: 'dismiss' }
  | { type: 'regenerate' }
  | { type: 'edit'; blockId: string; props: Record<string, unknown> }
  | { type: 'execute'; actionId: string; payload?: Record<string, unknown> };

/** 高风险 action，需二次确认 */
export type RiskLevel = 'low' | 'medium' | 'high';

export interface GenerativeActionDefinition {
  id: string;
  label: string;
  riskLevel: RiskLevel;
  /** 确定性 handler，不由模型执行 */
  handler: (payload?: Record<string, unknown>) => void | Promise<void>;
}

export interface GenerativeUIRendererProps {
  /** 原始 JSON 字符串或已解析意图 */
  intent: string | GenerativeUIIntent;
  /** 是否流式生成中 */
  isStreaming?: boolean;
  /** 是否显示 AI 生成标记与操作栏 */
  showChrome?: boolean;
  /** 用户操作回调 */
  onAction?: (action: GenerativeUIAction) => void;
  /** 注册的 action handlers（提交/删除等副作用） */
  actionHandlers?: Record<string, GenerativeActionDefinition>;
  className?: string;
}
