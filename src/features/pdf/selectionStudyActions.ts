/**
 * PDF 划词学习闭环 — 送聊天 / 生成题目 / 制卡入口。
 *
 * 出题接线说明（2026-08 调研结论）：
 * - questionBank 的 `import_question_bank_stream(format='txt')` 是「解析已有题目」
 *   的抽取流（prompt 为"请将以下文本内容解析为题目列表"），对教材散文材料
 *   会得到空结果，不能直接复用；
 * - 真正能"根据材料出题"的既有链路是聊天 Agent 的 qbank-tools 技能
 *   （builtin-qbank_create_question / batch_import，见
 *   src/features/chat/skills/builtin-tools/qbank-tools.ts）。
 * 因此「生成题目」走 PREFILL_CHAT_INPUT：切到聊天并预填结构化出题指令 + 材料
 * （autoSend=false，用户可先调整题量/题型再发送），由 Agent 完成建题并回贴
 * [题目集:id] 引用。
 *
 * 制卡直接复用聊天划词制卡服务（CardForge 引擎，后台任务 + 任务台通知），
 * 为避免把 cardforge 打进 PDF chunk，调用方应通过本模块的懒加载包装进入。
 */

import type { TFunction } from 'i18next';
import { APP_EVENTS, dispatchAppEvent, type PrefillChatInputDetail } from '@/events';
import { showGlobalNotification } from '@/components/UnifiedNotification';

/** 划词出题最小选中长度（与聊天划词制卡阈值一致） */
export const MIN_SELECTION_LENGTH_FOR_QUESTIONS = 10;

export interface SelectionSourceInfo {
  /** 选中文本（原文） */
  text: string;
  /** 来源文件名（如 "高等数学.pdf"） */
  sourceName?: string;
  /** 来源页码（1-based） */
  page?: number;
}

export type SelectionQuestionResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: 'empty' | 'too_short' };

/**
 * 划词「添加到聊天」的缺省通道：PREFILL_CHAT_INPUT 包装。
 *
 * 不派发裸 CHAT_V2_SET_INPUT——那条通道假定聊天视图已在前台；PREFILL 由
 * App 壳层先切到聊天视图、再转发为 CHAT_V2_SET_INPUT（App.tsx 的
 * handlePrefillChatInput），从阅读器出发不会把文本丢进一个看不见的输入框。
 * detail 在 PrefillChatInputDetail 基础上额外携带 page/sourceName——与链路 A
 * 「引用到对话」的 locator 语义对齐，供消费方后续升级为资源引用而不必改发起方。
 *
 * 有 locator 回调（onQuoteToChat）的宿主应优先走回调（资源引用 + page locator，
 * Agent 可回读原文）；本函数只是无回调时的兜底文本注入（autoSend=false）。
 */
export function sendSelectionToChatInput(input: SelectionSourceInfo): boolean {
  const text = input.text.trim();
  if (!text) return false;
  const detail: PrefillChatInputDetail & Pick<SelectionSourceInfo, 'page' | 'sourceName'> = {
    content: text,
    autoSend: false,
  };
  if (typeof input.page === 'number') detail.page = input.page;
  if (input.sourceName) detail.sourceName = input.sourceName;
  dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, detail);
  return true;
}

/**
 * 组装送入聊天的出题指令。材料整体包在指令末尾，来源行帮助 Agent
 * 在题目集命名/标签中带上出处。
 */
export function buildQuestionGenerationPrompt(
  input: SelectionSourceInfo,
  t: TFunction,
): string {
  const source = input.sourceName
    ? typeof input.page === 'number'
      ? t('pdf:selection.questionPromptSourcePage', {
          name: input.sourceName,
          page: input.page,
          defaultValue: '《{{name}}》第 {{page}} 页',
        })
      : t('pdf:selection.questionPromptSource', {
          name: input.sourceName,
          defaultValue: '《{{name}}》',
        })
    : t('pdf:selection.questionPromptSourceUnknown', { defaultValue: '阅读器划词摘录' });

  return [
    t('pdf:selection.questionPromptIntro', {
      source,
      defaultValue:
        '请根据下面的学习材料出题，并用题目集工具创建一个新的题目集（来源：{{source}}）。要求：题型以单选、填空、简答为主，共 5-10 题，每题附答案与解析，完成后给出题目集引用。',
    }),
    '',
    t('pdf:selection.questionPromptMaterial', { defaultValue: '【学习材料】' }),
    input.text.trim(),
  ].join('\n');
}

/**
 * 划词「生成题目」：校验选区后切到聊天并预填出题指令。
 * 不自动发送（autoSend=false）——题量/题型偏好留给用户最后把关。
 */
export function sendSelectionToQuestionGeneration(
  input: SelectionSourceInfo,
  t: TFunction,
): SelectionQuestionResult {
  const text = input.text.trim();
  if (!text) {
    showGlobalNotification(
      'warning',
      t('pdf:selection.selectionEmpty', { defaultValue: '请先选中要出题的文本' }),
    );
    return { ok: false, reason: 'empty' };
  }
  if (text.length < MIN_SELECTION_LENGTH_FOR_QUESTIONS) {
    showGlobalNotification(
      'warning',
      t('pdf:selection.selectionTooShort', {
        count: MIN_SELECTION_LENGTH_FOR_QUESTIONS,
        defaultValue: '选中文本太短，请至少选择 {{count}} 个字符',
      }),
    );
    return { ok: false, reason: 'too_short' };
  }

  const prompt = buildQuestionGenerationPrompt({ ...input, text }, t);
  dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content: prompt, autoSend: false });
  return { ok: true, prompt };
}

export interface SelectionCardInput extends SelectionSourceInfo {
  /** 选区前文（消歧用，可空） */
  contextBefore?: string;
  /** 选区后文（消歧用，可空） */
  contextAfter?: string;
}

/**
 * 划词「制卡」：懒加载聊天划词制卡服务并复用其完整链路
 * （校验 → CardForge generateCards → 任务台通知）。
 * 文案通过 getFixedT 固定到 chatV2 namespace——服务内部用裸 key 取词。
 */
export async function makeCardsFromSelection(input: SelectionCardInput): Promise<void> {
  const [{ generateCardsFromSelection }, { default: i18n }] = await Promise.all([
    import('@/features/chat/services/selectionCardGeneration'),
    import('@/i18n'),
  ]);
  await generateCardsFromSelection({
    selectedText: input.text,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
    t: i18n.getFixedT(null, 'chatV2'),
  });
}
