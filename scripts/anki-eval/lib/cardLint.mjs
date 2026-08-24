/**
 * 确定性制卡质量 lint 原型（eval 测试侧）。
 *
 * 状态：生产管线目前只有字段规则级 `_qa_flags`（min/max_length、allowed_values、
 * validation_pattern，见 streaming_anki_service.rs `validate_field_against_rule`），
 * 尚无内容级 lint 模块。本文件是路线图"确定性质检 lint"的先行原型：
 * 规则码在此固化为回归基线，未来生产 lint 模块（Rust 或 TS）落地时
 * 必须让全部 fixture 的 lint 预期继续通过（允许新增码，不允许既有码翻转）。
 *
 * 设计原则：零 LLM、零网络、纯函数、对好卡零误报（good 对照集守护）。
 */

export const LINT_CODES = Object.freeze({
  /** front/back 均缺失或为空白（cloze 卡有非空 text 时豁免） */
  EMPTY_FIELD: 'EMPTY_FIELD',
  /** cloze 挖空内容为空：{{c1::}} */
  EMPTY_CLOZE: 'EMPTY_CLOZE',
  /** 背面答案原文完整出现在正面题干中 */
  ANSWER_LEAK: 'ANSWER_LEAK',
  /** 模型客套话/助手口癖泄漏进字段正文 */
  FILLER_PHRASE: 'FILLER_PHRASE',
  /** 字段值内混入 markdown 代码围栏（渲染层预期 HTML） */
  FENCE_IN_FIELD: 'FENCE_IN_FIELD',
  /** 字段值为占位符（TODO / 待补充 / … 等），内容未完成 */
  PLACEHOLDER_TEXT: 'PLACEHOLDER_TEXT',
});

const EMPTY_CLOZE_RE = /\{\{c\d+::\s*\}\}/;

const FILLER_PHRASE_RE =
  /(以下是|以上是|以上就是|希望对你|希望这些|好的[，,]|作为一个\s*AI|Here (is|are) (the |your )?(flashcards?|cards?|answers?)|Sure[,!])/i;

const PLACEHOLDER_RE = /^(todo|tbd|n\/a|\.{3,}|…+|待补充|待填写|略|答案略|同上)$/i;

/** ANSWER_LEAK 归一化后 back 的最小长度阈值（防止短 token 巧合重叠误报） */
const ANSWER_LEAK_MIN_LEN = 4;

function normalizeForLeak(text) {
  return text.toLowerCase().replace(/\s+/g, '');
}

function collectStringFields(card) {
  const fields = {};
  for (const [key, value] of Object.entries(card)) {
    if (typeof value === 'string') fields[key.toLowerCase()] = value;
  }
  const nested = card.fields;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(nested)) {
      const lower = key.toLowerCase();
      if (typeof value === 'string' && !(lower in fields)) fields[lower] = value;
    }
  }
  return fields;
}

/** 元数据字段不参与内容 lint（对齐生产 extract_readable_text 的跳过清单） */
const META_FIELDS = new Set(['template_id', 'templateid', 'tags', 'images']);

/**
 * 对一张解析成功的卡片 JSON 对象执行全部 lint 规则。
 * @param {object} card 解析后的卡片对象
 * @returns {string[]} 命中的 lint 码（去重、按码名排序，保证断言稳定）
 */
export function lintCard(card) {
  const codes = new Set();
  const fields = collectStringFields(card);
  const front = fields.front ?? '';
  const back = fields.back ?? '';
  const text = fields.text ?? '';

  const hasFront = front.trim().length > 0;
  const hasBack = back.trim().length > 0;
  const hasText = text.trim().length > 0;

  // EMPTY_FIELD：问答卡需要 front+back 都非空；cloze 卡（text 非空）豁免
  if (!hasText && (!hasFront || !hasBack)) {
    codes.add(LINT_CODES.EMPTY_FIELD);
  }

  const contentEntries = Object.entries(fields).filter(([key]) => !META_FIELDS.has(key));

  for (const [, value] of contentEntries) {
    if (EMPTY_CLOZE_RE.test(value)) codes.add(LINT_CODES.EMPTY_CLOZE);
    if (FILLER_PHRASE_RE.test(value)) codes.add(LINT_CODES.FILLER_PHRASE);
    if (value.includes('```')) codes.add(LINT_CODES.FENCE_IN_FIELD);
    if (PLACEHOLDER_RE.test(value.trim())) codes.add(LINT_CODES.PLACEHOLDER_TEXT);
  }

  // ANSWER_LEAK：归一化后 back 完整出现在 front 中且长度达阈值
  if (hasFront && hasBack) {
    const normBack = normalizeForLeak(back);
    if (normBack.length >= ANSWER_LEAK_MIN_LEN && normalizeForLeak(front).includes(normBack)) {
      codes.add(LINT_CODES.ANSWER_LEAK);
    }
  }

  return [...codes].sort();
}
