/**
 * Anki 确定性 lint 的类型、稳定 code 与配置解码（`anki_qa_lint.rs` L1-430）。
 *
 * 运行时规则在 `anki-qa-rules.ts`，指纹/重复检测在 `anki-qa-tracker.ts`，
 * 编排入口在 `anki-qa-lint.ts`。
 */

export const QA_FLAGS_FIELD = '_qa_flags';

/**
 * 全部稳定 lint code 的具名常量导出（跨语言契约的 TS 侧锚点）。
 *
 * 常量名与 eval harness（`scripts/anki-eval/lib/cardLint.mjs`）中
 * `RUST_ALIGNED_CODES` / `RUST_ONLY_CODES` 的键名逐字节一致；常量值与
 * `anki_gold_set::LINT_CONTRACT_CODES` 及规则实现实际产出的字面量三方相等，
 * 由本模块测试 `codes_module_matches_emitted_literals` /
 * `codes_module_matches_contract_list` 锁定。
 *
 * 规则实现内部仍以字符串字面量产出 code（保持源码扫描契约测试不变），
 * 本模块的价值是给下游一个**稳定、可枚举、带名字**的出口。
 *
 * 新增/改名 lint 码的完整步骤：规则实现 → 本模块常量 →
 * `LINT_CONTRACT_CODES` → `cardLint.mjs` 分区表 → eval README 对照表，
 * 漏任何一步都有测试红灯。
 */
export const codes = {
  FRONT_BACK_IDENTICAL: 'front_back_identical',
  EMPTY_FRONT: 'empty_front',
  EMPTY_BACK: 'empty_back',
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
  TAGS_EMPTY: 'tags_empty',
  DUPLICATE_IN_DOCUMENT: 'duplicate_in_document',
  NEAR_DUPLICATE: 'near_duplicate',
  MIXED_LANGUAGE: 'mixed_language',
  /** 裸 LaTeX：公式未被 $...$ / $$...$$ 包裹（issue #462）。 */
  BARE_LATEX: 'bare_latex',
  MCQ_TOO_FEW_OPTIONS: 'mcq_too_few_options',
  MCQ_ANSWER_NOT_IN_OPTIONS: 'mcq_answer_not_in_options',
  MCQ_MISSING_ANSWER: 'mcq_missing_answer',
  FIELD_RULE_MIN_LENGTH: 'field_rule_min_length',
  FIELD_RULE_MAX_LENGTH: 'field_rule_max_length',
  FIELD_RULE_ALLOWED_VALUES: 'field_rule_allowed_values',
  FIELD_RULE_PATTERN: 'field_rule_pattern',
  LEGACY_FLAGS_UNPARSED: 'legacy_flags_unparsed',
} as const;

/** 单个稳定 lint code。 */
export type LintCode = (typeof codes)[keyof typeof codes];

/** 全部 code 常量的集合（顺序无语义），供契约测试与调用方枚举。 */
export const ALL_LINT_CODES: readonly LintCode[] = [
  codes.FRONT_BACK_IDENTICAL,
  codes.EMPTY_FRONT,
  codes.EMPTY_BACK,
  codes.CLOZE_UNCLOSED,
  codes.CLOZE_EMPTY_ANSWER,
  codes.CLOZE_BAD_INDEX,
  codes.CLOZE_MISSING,
  codes.ANSWER_LEAK,
  codes.MULTI_CONCEPT,
  codes.FRONT_TOO_LONG,
  codes.PLACEHOLDER_RESIDUE,
  codes.TODO_RESIDUE,
  codes.XXX_RESIDUE,
  codes.EMPTY_BRACKETS,
  codes.TAGS_EMPTY,
  codes.DUPLICATE_IN_DOCUMENT,
  codes.NEAR_DUPLICATE,
  codes.MIXED_LANGUAGE,
  codes.BARE_LATEX,
  codes.MCQ_TOO_FEW_OPTIONS,
  codes.MCQ_ANSWER_NOT_IN_OPTIONS,
  codes.MCQ_MISSING_ANSWER,
  codes.FIELD_RULE_MIN_LENGTH,
  codes.FIELD_RULE_MAX_LENGTH,
  codes.FIELD_RULE_ALLOWED_VALUES,
  codes.FIELD_RULE_PATTERN,
  codes.LEGACY_FLAGS_UNPARSED,
];

// ============================================================================
// 输出结构
// ============================================================================

/**
 * lint 违规严重度。
 *
 * - `info`：仅提示，永不参与拒绝决策（如 tags 空、语言混杂）。
 * - `warn`：质量问题但内容仍可用（如答案泄露、front 过长）。
 * - `error`：卡片大概率不可用（如 front==back、占位符残留、cloze 破损）。
 */
export type LintSeverity = 'info' | 'warn' | 'error';

/**
 * lint 行为级别。
 *
 * - `flag`（默认）：所有违规仅标记入 `_qa_flags`，卡片照常入库。
 * - `reject`：`error` 级违规触发拒绝（`shouldReject` 返回 true），
 *   `warn`/`info` 仍仅标记。
 */
export type LintLevel = 'flag' | 'reject';

/** `LintLevel` 的默认值（serde 缺省 / Rust `Default` 语义）。 */
export const DEFAULT_LINT_LEVEL: LintLevel = 'flag';

/**
 * 单条 lint 违规，结构化输出 `{code, field, message, severity}`。
 *
 * 序列化后与既有字段规则校验条目（`{field, rule, message}`）共存于
 * `_qa_flags` JSON 数组中；lint 条目以 `code` 键区分来源。
 */
export interface LintIssue {
  /**
   * 机器可读违规码，snake_case，稳定不变（前端按码分类展示/过滤，
   * 并按 `qaFlags.lint.<code>` 查本地化词条渲染用户可见文案）。
   */
  code: string;
  /** 违规字段名；卡片级违规（如 duplicate_in_document）用 `"card"`。 */
  field: string;
  /**
   * 人类可读中文说明。定位是诊断/日志与前端兜底展示（词条缺失时回退），
   * 用户可见文案由前端按 `code` 走 i18n。
   *
   * 软契约：前端会按 message 中数字出现的**顺序**抽取插值参数
   * （计数/阈值/百分比），调整文案时勿改变数字的顺序语义。
   */
  message: string;
  severity: LintSeverity;
}

/** `LintIssue::new`：唯一构造入口（契约测试按该调用形态扫描源码）。 */
export const LintIssue = {
  new(code: string, field: string, message: string, severity: LintSeverity): LintIssue {
    return { code, field, message, severity };
  },
};

// ============================================================================
// 配置
// ============================================================================

/** lint 引擎配置。所有阈值可调，所有规则可独立关闭。 */
export interface LintConfig {
  /** 行为级别：flag（默认，只标记）或 reject（error 级违规拒绝入库）。 */
  level: LintLevel;
  /**
   * 最小信息原则：front 超过该 Unicode 字符数即 flag。
   * 默认 220：中文问题 60~120 字常见，>220 通常是整段粘贴。
   */
  max_front_chars: number;
  /**
   * 答案泄露检测：back 归一化后至少多少字符才参与子串匹配
   * （过短的 back 如 "是"/"3" 子串命中率过高，属噪声）。
   */
  answer_leak_min_chars: number;
  /** 语言混杂检测：参与统计的最少字母字符数（低于该值不判断）。 */
  mixed_language_min_letters: number;
  check_front_back_identical: boolean;
  check_empty_fields: boolean;
  check_cloze: boolean;
  check_answer_leak: boolean;
  check_multi_concept: boolean;
  check_front_length: boolean;
  check_placeholder: boolean;
  check_tags_empty: boolean;
  check_mcq: boolean;
  /** 语言混杂启发式（低置信）：默认开启但仅产出 info，永不拒绝。 */
  check_mixed_language: boolean;
  /** 裸 LaTeX 检测：公式未被 $...$ / $$...$$ 包裹（默认开启，仅 warn）。 */
  check_bare_latex: boolean;
}

/** `LintConfig::default()`（serde `#[serde(default)]` 的缺省值来源）。 */
export function defaultLintConfig(): LintConfig {
  return {
    level: DEFAULT_LINT_LEVEL,
    max_front_chars: 220,
    answer_leak_min_chars: 4,
    mixed_language_min_letters: 24,
    check_front_back_identical: true,
    check_empty_fields: true,
    check_cloze: true,
    check_answer_leak: true,
    check_multi_concept: true,
    check_front_length: true,
    check_placeholder: true,
    check_tags_empty: true,
    check_mcq: true,
    check_mixed_language: true,
    check_bare_latex: true,
  };
}

/**
 * `LintConfig` 的 serde 反序列化：前端只传部分字段时其余用默认值
 * （`#[serde(default)]`），未知字段忽略（serde 默认行为）。
 */
export function decodeLintConfig(value: unknown): LintConfig {
  const config = defaultLintConfig();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('invalid type: expected struct LintConfig');
  }
  const record = value as Record<string, unknown>;
  const level = record.level;
  if (level !== undefined) {
    if (level !== 'flag' && level !== 'reject') {
      throw new TypeError(`unknown variant \`${String(level)}\`, expected \`flag\` or \`reject\``);
    }
    config.level = level;
  }
  config.max_front_chars = readCount(record, 'max_front_chars', config.max_front_chars);
  config.answer_leak_min_chars = readCount(record, 'answer_leak_min_chars', config.answer_leak_min_chars);
  config.mixed_language_min_letters = readCount(
    record,
    'mixed_language_min_letters',
    config.mixed_language_min_letters,
  );
  config.check_front_back_identical = readFlag(record, 'check_front_back_identical', config.check_front_back_identical);
  config.check_empty_fields = readFlag(record, 'check_empty_fields', config.check_empty_fields);
  config.check_cloze = readFlag(record, 'check_cloze', config.check_cloze);
  config.check_answer_leak = readFlag(record, 'check_answer_leak', config.check_answer_leak);
  config.check_multi_concept = readFlag(record, 'check_multi_concept', config.check_multi_concept);
  config.check_front_length = readFlag(record, 'check_front_length', config.check_front_length);
  config.check_placeholder = readFlag(record, 'check_placeholder', config.check_placeholder);
  config.check_tags_empty = readFlag(record, 'check_tags_empty', config.check_tags_empty);
  config.check_mcq = readFlag(record, 'check_mcq', config.check_mcq);
  config.check_mixed_language = readFlag(record, 'check_mixed_language', config.check_mixed_language);
  config.check_bare_latex = readFlag(record, 'check_bare_latex', config.check_bare_latex);
  return config;
}

/** `usize` 字段：缺省用默认值，类型不符时按 serde 语义抛错。 */
function readCount(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`invalid type: ${JSON.stringify(value)}, expected usize (\`${key}\`)`);
  }
  return value;
}

/** `bool` 字段：缺省用默认值，类型不符时按 serde 语义抛错。 */
function readFlag(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new TypeError(`invalid type: ${JSON.stringify(value)}, expected a boolean (\`${key}\`)`);
  }
  return value;
}

// ============================================================================
// 输入
// ============================================================================

/** 待 lint 的卡片切面（对应 Rust `CardLintInput`）。 */
export interface CardLintInput {
  front: string;
  back: string;
  /** Cloze 模板的 Text 字段（若存在，cloze 规则优先检查它）。 */
  text: string | null;
  tags: string[];
  /** 扩展字段（选择题 optionA-D / correct 等从这里读取）。 */
  extra_fields: Record<string, string>;
}
