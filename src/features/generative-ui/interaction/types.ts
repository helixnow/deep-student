/**
 * Generative UI 交互作答 — 答案载荷 / 回答状态（契约，见方案 1.4）
 *
 * 纯类型 + 少量无依赖辅助；不得 import React / chat store。
 */

/** choice 块答案：选中的 option id（去重、∈ options），可选「其他」文本（≤500） */
export type ChoiceAnswer = { selected: string[]; other?: string };

/** form 块答案：字段 name → 值；可选字段未填为 null */
export type FormAnswer = Record<string, string | number | boolean | null>;

/** 交互块 id → 答案 */
export type GenerativeUIAnswerData = Record<string, ChoiceAnswer | FormAnswer>;

/** 提交给后端 chat_v2_genui_submit_answer 的载荷 */
export interface GenerativeUIAnswerPayload {
  /** 1..500 字符（码点），人类可读摘要 */
  summary: string;
  /** 交互块 id → 答案；JSON 序列化 ≤16000 字符 */
  data: GenerativeUIAnswerData;
}

export type GenerativeUIInteractionState =
  | 'pending'
  | 'answered'
  | 'dismissed'
  | 'cancelled'
  | 'interrupted';

export type GenerativeUIInteractionReason = 'user_message' | 'skipped' | 'stopped' | 'interrupted';

/** 工具输出 / end 事件中的 interaction 对象 */
export interface GenerativeUIInteraction {
  mode: 'await';
  toolCallId: string;
  state: GenerativeUIInteractionState;
  reason?: GenerativeUIInteractionReason;
  answeredAt?: number;
}

/** answered 时 Rust 回传的 resolved 条目（仅展示用） */
export interface GenerativeUIResolvedAnswerEntry {
  blockId: string;
  question?: string;
  selected?: Array<{ id: string; label: string }>;
  other?: string | null;
  [key: string]: unknown;
}

/** end 事件 / toolOutput 中的 answer（Rust 校验后重建） */
export interface GenerativeUIPersistedAnswer {
  summary: string;
  data: GenerativeUIAnswerData;
  resolved?: GenerativeUIResolvedAnswerEntry[];
  trust?: 'untrusted_user_input';
}

/** 后端提交结果：accepted / expired / 校验失败（GENUI_ANSWER_INVALID: …） */
export type GenerativeUISubmitOutcome = 'accepted' | 'expired' | { invalid: string };

/** 交给渲染器（WP-E）的交互绑定；由聊天集成（WP-F）构造 */
export interface GenerativeUIInteractionBinding {
  state: GenerativeUIInteractionState;
  /** true 才允许启用控件与提交按钮 */
  canSubmit: boolean;
  /** 回放：已回答的摘要与数据（只读回显） */
  answered?: { summary: string; data: GenerativeUIAnswerData };
  /** 结束原因（dismissed/cancelled 细分文案用） */
  reason?: GenerativeUIInteractionReason;
  onSubmit?(payload: GenerativeUIAnswerPayload): Promise<GenerativeUISubmitOutcome>;
  onSkip?(): Promise<void>;
}

/** 渲染器交互模式：工具调用（可作答）/ 正文内联（只展示） */
export type GenerativeUIInteractionMode = 'interactive' | 'display-only';
