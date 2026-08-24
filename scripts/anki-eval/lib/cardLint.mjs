/**
 * 确定性制卡质量 lint（eval 测试侧，复用 Rust 生产 lint 契约）。
 *
 * 状态（Round 4 #10 落地，Round 5 #10 完全对齐）：生产 lint 模块为
 * `src-tauri/src/anki_qa_lint.rs`（Round 3 #3）。本文件不使用自造码，
 * 而是**逐字节复用 Rust 侧的 code 字符串契约**：凡两侧都实现的规则，
 * code 必须与 `anki_qa_lint::codes` 常量一致（契约清单固化在
 * `src-tauri/src/anki_gold_set.rs` 的 LINT_CONTRACT_CODES，
 * 对齐由 tests/vitest/anki/eval/lintContract.test.ts 双向锁定）。
 *
 * Round 5 #10 起，Rust 侧的全部 code 以具名常量导出于
 * `anki_qa_lint::codes`，本文件的三张分区表与之满足硬性等式：
 *
 *   RUST_ALIGNED_CODES ∪ RUST_ONLY_CODES == codes::ALL（无交集、无遗漏，
 *   且每个条目的**键名与 Rust 常量名、值与 Rust 常量值均逐字节一致**）
 *   EVAL_ONLY_CODES ∩ codes::ALL == ∅
 *
 * 三类规则码：
 * 1. Rust-aligned（本文件实现，名与值都与 Rust 相同）：内容级纯文本规则；
 * 2. Rust-only（本文件声明但不实现）：依赖模板/文档/DB 上下文或属
 *    Info 级低置信提示的规则——回放单卡 JSON 拿不到上下文，Info 码
 *    不参与基线断言（见各条目注释）；
 * 3. eval-only（Rust 无对应）：流式回放特有的表层缺陷
 *    （filler_phrase / fence_in_field / placeholder_text），
 *    命名遵循同一 snake_case 约定且不得与契约清单冲突。
 *
 * 设计原则不变：零 LLM、零网络、纯函数、对好卡零误报（good 对照集守护）。
 */

/** 与 Rust anki_qa_lint 对齐的规则码（键 = Rust codes 常量名，值 = 常量值，逐字节一致） */
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

/**
 * Rust 生产侧独有的规则码（本文件声明但不实现；键/值同样与 Rust 常量对齐）。
 *
 * 与 RUST_ALIGNED_CODES 合并后必须恰好等于 `anki_qa_lint::codes::ALL`——
 * Rust 侧任何新增 lint 码都必须先在这两张表之一归类，否则契约测试红。
 * 每条附不复刻原因（与 eval README 对照表同步）：
 */
export const RUST_ONLY_CODES = Object.freeze({
  /** Info 级；回放夹具不约定 tags，复刻会对好卡全量误报 */
  TAGS_EMPTY: 'tags_empty',
  /** 需跨卡 FingerprintTracker 文档级状态，单卡回放无从谈起 */
  DUPLICATE_IN_DOCUMENT: 'duplicate_in_document',
  /** 同上（bigram Jaccard 近重复） */
  NEAR_DUPLICATE: 'near_duplicate',
  /** Info 级低置信提示（合法中英术语混排即触发），不参与基线断言 */
  MIXED_LANGUAGE: 'mixed_language',
  /** 需选择题模板上下文（extra_fields 的 option 槽位约定） */
  MCQ_TOO_FEW_OPTIONS: 'mcq_too_few_options',
  MCQ_ANSWER_NOT_IN_OPTIONS: 'mcq_answer_not_in_options',
  MCQ_MISSING_ANSWER: 'mcq_missing_answer',
  /** 需模板 FieldExtractionRule 上下文 */
  FIELD_RULE_MIN_LENGTH: 'field_rule_min_length',
  FIELD_RULE_MAX_LENGTH: 'field_rule_max_length',
  FIELD_RULE_ALLOWED_VALUES: 'field_rule_allowed_values',
  FIELD_RULE_PATTERN: 'field_rule_pattern',
  /** merge_flags 对非法既有 _qa_flags 值的包装条目，属内部机制 */
  LEGACY_FLAGS_UNPARSED: 'legacy_flags_unparsed',
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

/** 本文件可能产出的全量码表（不含 Rust-only；测试与 manifest 均引用具体字符串） */
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
    // Rust 侧序号是 digits.parse::<u32>()：0、非数字与超出 u32 范围均判非法
    const index = digits.length > 0 ? Number.parseInt(digits, 10) : Number.NaN;
    const indexOk = Number.isInteger(index) && index >= 1 && index <= 0xffffffff;
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
  // 最小长度按 Unicode 码点计（对齐 Rust b.chars().count()，而非 UTF-16 单元数）
  if (
    !identical &&
    normFront.length > 0 &&
    [...normBack].length >= ANSWER_LEAK_MIN_CHARS &&
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
