/**
 * 确定性制卡质量 lint（eval 测试侧，复用 Rust 生产 lint 契约）。
 *
 * 状态（Round 4 #10 升级）：生产 lint 模块已落地为
 * `src-tauri/src/anki_qa_lint.rs`（Round 3 #3）。本文件不再使用自造的
 * UPPER_SNAKE 原型码，而是**逐字节复用 Rust 侧的 code 字符串契约**：
 * 凡两侧都实现的规则，code 必须与 `anki_qa_lint::LintIssue.code` 一致
 * （契约清单固化在 `src-tauri/src/anki_gold_set.rs` 的 LINT_CONTRACT_CODES，
 * 对齐由 tests/vitest/anki/eval/lintContract.test.ts 双向锁定）。
 *
 * 三类规则码：
 * 1. Rust-aligned（本文件实现，码与 Rust 相同）：内容级纯文本规则；
 * 2. Rust-only（本文件不实现）：依赖模板/文档/DB 上下文的规则
 *    （tags_empty、duplicate_card、mcq_*、field_rule_*、mixed_language、
 *    legacy_flags_unparsed）——回放单卡 JSON 拿不到这些上下文；
 * 3. eval-only（Rust 无对应）：流式回放特有的表层缺陷
 *    （filler_phrase / fence_in_field / placeholder_text），
 *    命名遵循同一 snake_case 约定且不得与契约清单冲突。
 *
 * 设计原则不变：零 LLM、零网络、纯函数、对好卡零误报（good 对照集守护）。
 */

/** 与 Rust anki_qa_lint 对齐的规则码（值 = Rust code 字符串，逐字节一致） */
export const RUST_ALIGNED_CODES = Object.freeze({
  EMPTY_FRONT: 'empty_front',
  EMPTY_BACK: 'empty_back',
  FRONT_BACK_IDENTICAL: 'front_back_identical',
  CLOZE_UNCLOSED: 'cloze_unclosed',
  CLOZE_EMPTY_ANSWER: 'cloze_empty_answer',
  CLOZE_BAD_INDEX: 'cloze_bad_index',
  CLOZE_MISSING: 'cloze_missing',
  ANSWER_LEAK: 'answer_leak',
  MULTI_CONCEPT: 'multi_concept',
  FRONT_TOO_LONG: 'front_too_long',
  PLACEHOLDER_RESIDUE: 'placeholder_residue',
  TODO_RESIDUE: 'todo_residue',
  XXX_RESIDUE: 'xxx_residue',
  EMPTY_BRACKETS: 'empty_brackets',
});

/** eval harness 特有码（Rust 无对应规则；不得与 LINT_CONTRACT_CODES 冲突） */
export const EVAL_ONLY_CODES = Object.freeze({
  /** 模型客套话/助手口癖泄漏进字段正文 */
  FILLER_PHRASE: 'filler_phrase',
  /** 字段值内混入 markdown 代码围栏（渲染层预期 HTML） */
  FENCE_IN_FIELD: 'fence_in_field',
  /** 字段值整体为占位符（TODO / 待补充 / … 等），内容未完成 */
  PLACEHOLDER_TEXT: 'placeholder_text',
});

/** 全量码表（向后兼容出口；测试与 manifest 均引用具体字符串） */
export const LINT_CODES = Object.freeze({ ...RUST_ALIGNED_CODES, ...EVAL_ONLY_CODES });

// ---------------------------------------------------------------------------
// 阈值（与 Rust LintConfig::default() 数值一致）
// ---------------------------------------------------------------------------

/** ANSWER_LEAK：归一化后 back 的最小字符数（Rust answer_leak_min_chars=4） */
const ANSWER_LEAK_MIN_CHARS = 4;
/** FRONT_TOO_LONG：front 可见字符数上限（Rust max_front_chars=220） */
const MAX_FRONT_CHARS = 220;

// ---------------------------------------------------------------------------
// eval-only 规则的正则（沿用原型，仅改码名）
// ---------------------------------------------------------------------------

const FILLER_PHRASE_RE =
  /(以下是|以上是|以上就是|希望对你|希望这些|好的[，,]|作为一个\s*AI|Here (is|are) (the |your )?(flashcards?|cards?|answers?)|Sure[,!])/i;

const PLACEHOLDER_RE = /^(todo|tbd|n\/a|\.{3,}|…+|待补充|待填写|略|答案略|同上)$/i;

// ---------------------------------------------------------------------------
// Rust 文本工具的逐条移植（strip_html / normalize_for_compare / scan_cloze）
// ---------------------------------------------------------------------------

/** Rust strip_html：简单状态机剥标签，不解析实体 */
function stripHtml(s) {
  let out = '';
  let inTag = false;
  for (const ch of s) {
    if (ch === '<') inTag = true;
    else if (ch === '>' && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** Rust normalize_for_compare：去 HTML → 仅保留字母/数字（含 CJK）→ 小写 */
function normalizeForCompare(s) {
  return [...stripHtml(s)]
    .filter((ch) => /[\p{L}\p{N}]/u.test(ch))
    .join('')
    .toLowerCase();
}

/** Rust scan_cloze：逐个定位 {{c，解析 数字::内容}}，统计四类形态 */
function scanCloze(s) {
  const scan = { valid: 0, empty: 0, badIndex: 0, unclosed: 0 };
  let i = 0;
  for (;;) {
    const rel = s.indexOf('{{c', i);
    if (rel === -1) break;
    const bodyStart = rel + 3;
    let digitsEnd = bodyStart;
    while (digitsEnd < s.length && s[digitsEnd] >= '0' && s[digitsEnd] <= '9') digitsEnd++;
    const digits = s.slice(bodyStart, digitsEnd);
    if (!s.startsWith('::', digitsEnd)) {
      // 不是 cloze 语法（如 {{correct}} 模板变量），跳过这个 "{{c"
      i = bodyStart;
      continue;
    }
    const contentStart = digitsEnd + 2;
    const close = s.indexOf('}}', contentStart);
    if (close === -1) {
      scan.unclosed++;
      i = contentStart;
      continue;
    }
    const content = s.slice(contentStart, close);
    const indexOk = digits.length > 0 && Number.parseInt(digits, 10) >= 1;
    if (!indexOk) scan.badIndex++;
    else if (content.trim().length === 0) scan.empty++;
    else scan.valid++;
    i = close + 2;
  }
  return scan;
}

// ---------------------------------------------------------------------------
// 字段收集（沿用原型：顶层字符串字段 + 嵌套 fields，元数据字段跳过）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 全量 lint：返回结构化 issue 数组（形状对齐 Rust LintIssue：{code, field}）。
 * @param {object} card 解析后的卡片对象
 * @returns {Array<{code: string, field: string}>}
 */
export function lintCardIssues(card) {
  const issues = [];
  const push = (code, field) => issues.push({ code, field });

  const fields = collectStringFields(card);
  const front = fields.front ?? '';
  const back = fields.back ?? '';
  const text = fields.text ?? '';

  const hasFront = front.trim().length > 0;
  const hasBack = back.trim().length > 0;
  const hasText = text.trim().length > 0;
  // Rust check_empty_fields：cloze 卡（Text 含 {{c 且非空）豁免空字段
  const hasClozeText = hasText && text.includes('{{c');

  // ---- empty_front / empty_back（Rust 规则 2）----
  if (!hasFront && !hasClozeText) push(RUST_ALIGNED_CODES.EMPTY_FRONT, 'front');
  if (!hasBack && !hasClozeText && !front.includes('{{c')) {
    push(RUST_ALIGNED_CODES.EMPTY_BACK, 'back');
  }

  // ---- front_back_identical（Rust 规则 1）----
  const normFront = normalizeForCompare(front);
  const normBack = normalizeForCompare(back);
  const identical = normFront.length > 0 && normFront === normBack;
  if (identical) push(RUST_ALIGNED_CODES.FRONT_BACK_IDENTICAL, 'card');

  // ---- cloze_*（Rust 规则 3：text 优先 + front 兜底）----
  for (const [fieldName, content] of [
    ['text', text],
    ['front', front],
  ]) {
    if (!content.includes('{{c')) continue;
    const scan = scanCloze(content);
    if (scan.unclosed > 0) push(RUST_ALIGNED_CODES.CLOZE_UNCLOSED, fieldName);
    if (scan.empty > 0) push(RUST_ALIGNED_CODES.CLOZE_EMPTY_ANSWER, fieldName);
    if (scan.badIndex > 0) push(RUST_ALIGNED_CODES.CLOZE_BAD_INDEX, fieldName);
  }
  if (hasText && !text.includes('{{c')) push(RUST_ALIGNED_CODES.CLOZE_MISSING, 'text');

  // ---- answer_leak（Rust 规则 4：归一化含入 + 最小长度 + f==b 时让位规则 1）----
  if (
    !identical &&
    normFront.length > 0 &&
    normBack.length >= ANSWER_LEAK_MIN_CHARS &&
    normFront.includes(normBack)
  ) {
    push(RUST_ALIGNED_CODES.ANSWER_LEAK, 'front');
  }

  // ---- multi_concept（Rust 规则 5）----
  const visibleFront = stripHtml(front);
  const questionMarks = [...visibleFront].filter((c) => c === '?' || c === '？').length;
  const hasFenbie =
    visibleFront.includes('分别') && ['和', '及', '与', '、'].some((c) => visibleFront.includes(c));
  const lowerFront = visibleFront.toLowerCase();
  const interrogatives = ['what', 'why', 'how', 'when', 'where', 'which', 'who'];
  const englishDouble =
    lowerFront.includes(' and ') &&
    interrogatives.reduce((n, w) => n + lowerFront.split(w).length - 1, 0) >= 2;
  if (questionMarks >= 2 || hasFenbie || englishDouble) {
    push(RUST_ALIGNED_CODES.MULTI_CONCEPT, 'front');
  }

  // ---- front_too_long（Rust 规则 6：可见字符数）----
  if ([...visibleFront].length > MAX_FRONT_CHARS) {
    push(RUST_ALIGNED_CODES.FRONT_TOO_LONG, 'front');
  }

  // ---- 逐内容字段规则（Rust 规则 7 + eval-only）----
  const contentEntries = Object.entries(fields).filter(([key]) => !META_FIELDS.has(key));
  const templatePlaceholderRe = /\{\{[A-Z][A-Z0-9_]+\}\}/;
  const xxxTokenRe = /(^|[^a-z0-9])x{3,}([^a-z0-9]|$)/i;

  for (const [fieldName, value] of contentEntries) {
    if (value.length === 0) continue;
    if (templatePlaceholderRe.test(value)) {
      push(RUST_ALIGNED_CODES.PLACEHOLDER_RESIDUE, fieldName);
    }
    if (value.includes('TODO') || value.includes('FIXME')) {
      push(RUST_ALIGNED_CODES.TODO_RESIDUE, fieldName);
    }
    if (xxxTokenRe.test(value)) push(RUST_ALIGNED_CODES.XXX_RESIDUE, fieldName);
    if (['【】', '（）', '()'].some((pair) => value.includes(pair))) {
      push(RUST_ALIGNED_CODES.EMPTY_BRACKETS, fieldName);
    }
    // eval-only 规则
    if (FILLER_PHRASE_RE.test(value)) push(EVAL_ONLY_CODES.FILLER_PHRASE, fieldName);
    if (value.includes('```')) push(EVAL_ONLY_CODES.FENCE_IN_FIELD, fieldName);
    if (PLACEHOLDER_RE.test(value.trim())) push(EVAL_ONLY_CODES.PLACEHOLDER_TEXT, fieldName);
  }

  return issues;
}

/**
 * 对一张解析成功的卡片 JSON 对象执行全部 lint 规则（manifest 断言口径）。
 * @param {object} card 解析后的卡片对象
 * @returns {string[]} 命中的 lint 码（去重、按码名排序，保证断言稳定）
 */
export function lintCard(card) {
  return [...new Set(lintCardIssues(card).map((i) => i.code))].sort();
}
