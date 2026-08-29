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

/** Intent 文档版本：v1 基线，v1.1 增加 layout / span */
export type GenerativeUIIntentVersion = '1' | '1.1';

/** 顶层布局模式 */
export type GenerativeLayoutMode = 'stack' | 'grid';

/** 栅格列数 / 块跨列（仅 1|2|3，禁止模型任意 class） */
export type GenerativeLayoutUnit = 1 | 2 | 3;

/** v1.1 顶层布局；缺省等价 stack 单列 */
export interface GenerativeLayout {
  mode: GenerativeLayoutMode;
  columns?: GenerativeLayoutUnit;
}

/** 模型输出的单个块意图 */
export interface GenerativeBlockIntent {
  type: string;
  props?: Record<string, unknown>;
  id?: string;
  /** grid 下占列数；stack 忽略。非法值由 schema 钳制到 1|2|3 */
  span?: GenerativeLayoutUnit;
}

/** 模型输出的完整 UI 意图文档 */
export interface GenerativeUIIntent {
  version?: GenerativeUIIntentVersion;
  layout?: GenerativeLayout;
  blocks: GenerativeBlockIntent[];
  meta?: {
    title?: string;
    description?: string;
    researchSessionId?: string;
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

export type GenerativeActionUndoFn = () => void | Promise<void>;

/** handler 可返回 `{ undo }` 供 HITL 撤销栈消费 */
export type GenerativeActionHandlerResult = void | { undo?: GenerativeActionUndoFn };

export interface GenerativeActionDefinition {
  id: string;
  label: string;
  riskLevel: RiskLevel;
  /** 确定性 handler，不由模型执行；可选返回 undo */
  handler: (
    payload?: Record<string, unknown>,
  ) => GenerativeActionHandlerResult | Promise<GenerativeActionHandlerResult>;
  /** 定义级撤销（handler 未返回 undo 时使用） */
  undo?: GenerativeActionUndoFn;
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
  /** parse / normalize / recover 警告（含 `blocks-truncated`） */
  warnings?: string[];
  /** 被截断未显示的块数；有则显示 overflow 提示 */
  truncatedCount?: number;
  /** 流式字符上限；测试可注入，生产默认 256_000 */
  maxStreamChars?: number;
  className?: string;
}
