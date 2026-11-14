/**
 * Anki 卡片确定性质检 lint 引擎（零 LLM 成本）。
 *
 * 移植自 `src-tauri/crates/dstu-anki/src/anki_qa_lint.rs`（非测试部分 L1-1445）。
 * 对 LLM 生成的 Anki 卡片做纯规则质检，不调用任何模型、不产生任何 token 成本。
 *
 * ## 设计原则
 *
 * 1. **默认 flag 入库不丢卡**（`LintLevel::Flag`）：LLM 输出轻微越界很常见，
 *    毙卡会损失内容。lint 结果以结构化 JSON 写入 `extra_fields["_qa_flags"]`
 *    留痕，供前端 QA 面板复查/批量修复。
 * 2. **`LintLevel::Reject` 可选**：调用方可将 `Error` 级违规升级为拒绝入库
 *    （`shouldReject`），Flag/Warn/Info 永不拒绝。
 * 3. **规则可配置**：`LintConfig` 暴露阈值（front 最大长度、答案泄露最小长度等），
 *    每条规则可独立关闭。
 * 4. **与既有 `_qa_flags` 协议兼容**：`mergeFlags` 会解析 `extra_fields` 中
 *    已有的 JSON 数组（字段规则校验写入的 `{field, rule, message}` 条目），
 *    追加 lint 条目并按 `(code, field)` 去重，绝不覆盖丢失既有标记。
 *
 * ## 失败模式覆盖
 *
 * | # | 规则 | code | 默认严重度 |
 * |---|------|------|-----------|
 * | 1 | front == back | `front_back_identical` | Error |
 * | 2 | front/back 空或纯空白 | `empty_front` / `empty_back` | Error |
 * | 3 | cloze 未配对/空挖空/非法序号 | `cloze_*` | Error |
 * | 4 | 答案泄露（front 含 back 关键片段） | `answer_leak` | Warn |
 * | 5 | 双概念（一卡问两件事启发式） | `multi_concept` | Warn |
 * | 6 | 最小信息原则（front 过长） | `front_too_long` | Warn |
 * | 7 | 占位符残留 | `placeholder_residue` | Error |
 * | 8 | tags 空 | `tags_empty` | Info |
 * | 9 | 同文档重复卡（归一化 front 指纹） | `duplicate_in_document` | Warn |
 * | 9b | 同文档近重复卡（字符 bigram Jaccard） | `near_duplicate` | Warn |
 * | 10 | 字段 min/max/allowed/regex | `field_rule_*` | Warn |
 * | 11 | 选择题缺选项/答案不在选项中 | `mcq_*` | Error/Warn |
 * | 12 | 语言混杂（低置信启发式） | `mixed_language` | Info（永不拒绝） |
 * | 13 | 裸 LaTeX（公式未用 $...$ 包裹） | `bare_latex` | Warn（永不拒绝） |
 *
 * ## 文档级重复/近重复检测
 *
 * 规则 9/9b 由 `FingerprintTracker` 提供，有两种持有方式：
 *
 * 1. **显式持有**：调用方在文档/任务生命周期内持有一个 tracker，逐卡调用
 *    `lintCardWithTracker`；
 * 2. **文档级 registry**（生产路径）：`observeDocumentCard(documentId, key)`
 *    从进程级 registry 按 documentId 取共享 tracker——同一文档的所有 segment
 *    task（含统一重试任务、暂停后 resume 的任务）天然共享同一份指纹状态，
 *    不会每个 task 重置。文档完成/取消/删除时由调度层调用
 *    `releaseDocumentTracker` 释放。
 *
 * 重复/近重复只打 flag（Warn）不丢卡；落库层的 DB 唯一索引仍是最终防线，
 * tracker 的价值是在 flag 里显式留下 `duplicate_in_document` / `near_duplicate`
 * 语义。registry 是进程级模块状态：同一 documentId 拿到的是同一个 tracker 实例。
 *
 * > 线程模型差异：Rust 侧 registry 值类型为 `Arc<Mutex<FingerprintTracker>>`，
 * > 本移植在单线程 JS 运行时中直接持有 `FingerprintTracker`；`Arc::ptr_eq`
 * > 的「同一文档共享同一实例」语义由对象引用同一性保证。
 */

/** 与 `streaming_anki_service::QA_FLAGS_FIELD` 保持一致的键名。 */

import type { FieldExtractionRule__De } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { NativeRegexCompileError } from '../../../platform/native/api.ts';
import type { NativeRegex, NativeRegexPattern } from '../../../platform/native/api.ts';
import { LintIssue, QA_FLAGS_FIELD, type CardLintInput, type LintConfig } from './anki-qa-types.ts';
import {
  lintAnswerLeak,
  lintBareLatex,
  lintCloze,
  lintEmptyFields,
  lintFrontBackIdentical,
  lintFrontLength,
  lintMcq,
  lintMixedLanguage,
  lintMultiConcept,
  lintPlaceholder,
  lintTagsEmpty,
} from './anki-qa-rules.ts';
import { FingerprintTracker, issuesFromObservation } from './anki-qa-tracker.ts';
export * from './anki-qa-types.ts';
export * from './anki-qa-rules.ts';
export * from './anki-qa-tracker.ts';

// ============================================================================
// 主入口
// ============================================================================

/**
 * 对单张卡片执行全部启用的确定性规则，返回违规列表（空 = 通过）。
 *
 * 无状态版本：不含文档级重复检测。需要重复检测时用 `lintCardWithTracker`。
 */
export function lintCard(input: CardLintInput, cfg: LintConfig): LintIssue[] {
  const issues: LintIssue[] = [];

  if (cfg.check_empty_fields) {
    lintEmptyFields(input, issues);
  }
  if (cfg.check_front_back_identical) {
    lintFrontBackIdentical(input, issues);
  }
  if (cfg.check_cloze) {
    lintCloze(input, issues);
  }
  if (cfg.check_answer_leak) {
    lintAnswerLeak(input, cfg, issues);
  }
  if (cfg.check_multi_concept) {
    lintMultiConcept(input, issues);
  }
  if (cfg.check_front_length) {
    lintFrontLength(input, cfg, issues);
  }
  if (cfg.check_placeholder) {
    lintPlaceholder(input, issues);
  }
  if (cfg.check_tags_empty) {
    lintTagsEmpty(input, issues);
  }
  if (cfg.check_mcq) {
    lintMcq(input, issues);
  }
  if (cfg.check_mixed_language) {
    lintMixedLanguage(input, cfg, issues);
  }
  if (cfg.check_bare_latex) {
    lintBareLatex(input, issues);
  }

  return issues;
}

/**
 * 带文档级重复/近重复检测的 lint：先跑无状态规则，再查/登记 front 指纹。
 *
 * `tracker` 应与文档/任务同生命周期（每个文档一个实例）。
 */
export function lintCardWithTracker(
  input: CardLintInput,
  cfg: LintConfig,
  tracker: FingerprintTracker,
): LintIssue[] {
  const issues = lintCard(input, cfg);
  const observation = tracker.observe(duplicateKeySource(input));
  issues.push(...issuesFromObservation(observation));
  return issues;
}

/**
 * 指纹 key 的选取规则：cloze 卡优先用 Text 字段（front 可能为空或为渲染视图），
 * 否则用 front。与 `lintCardWithTracker` / 生产路径保持同一语义。
 */
export function duplicateKeySource(input: CardLintInput): string {
  if (input.text !== null && input.text.trim() !== '') return input.text;
  return input.front;
}

/**
 * 拒绝决策：仅当配置为 `reject` 且存在 `error` 级违规时返回 true。
 *
 * `warn`/`info` 永不触发拒绝——这是"低置信只 flag 不拒绝"的硬保证。
 */
export function shouldReject(issues: readonly LintIssue[], cfg: LintConfig): boolean {
  return cfg.level === 'reject' && issues.some((issue) => issue.severity === 'error');
}

/**
 * 将 lint 违规合并进 `extra_fields[_qa_flags]`（JSON 数组字符串）。
 *
 * - 保留既有条目（字段规则校验写入的 `{field, rule, message}`）。
 * - lint 条目序列化为 `{code, field, message, severity}`。
 * - 按 `(code, field)` 去重，重复调用幂等。
 * - `issues` 为空且原本无 flags 时不写入键（不污染干净卡片）。
 * - 既有值不是合法 JSON 数组时不丢弃：包装为 `{code: "legacy_flags_unparsed"}` 条目保留原文。
 */
export function mergeFlags(extra_fields: Record<string, string>, issues: readonly LintIssue[]): void {
  if (issues.length === 0 && !Object.hasOwn(extra_fields, QA_FLAGS_FIELD)) {
    return;
  }

  const merged: unknown[] = [];
  const existingRaw = extra_fields[QA_FLAGS_FIELD];
  if (existingRaw !== undefined) {
    const parsed = parseJson(existingRaw);
    if (parsed.ok && Array.isArray(parsed.value)) {
      merged.push(...parsed.value);
    } else if (parsed.ok) {
      // serde_json 对非数组值：保留其紧凑 JSON 文本（preserve_order 保序）
      merged.push({
        "code": "legacy_flags_unparsed",
        "field": "card",
        "message": JSON.stringify(parsed.value) ?? 'null',
        "severity": "info",
      });
    } else {
      merged.push({
        "code": "legacy_flags_unparsed",
        "field": "card",
        "message": existingRaw,
        "severity": "info",
      });
    }
  }

  const seen = new Set<string>();
  for (const entry of merged) {
    const key = dedupeKeyOf(entry);
    if (key !== null) seen.add(key);
  }

  for (const issue of issues) {
    const key = dedupeKey(issue.code, issue.field);
    if (!seen.has(key)) {
      seen.add(key);
      // LintIssue 的序列化形状固定为 {code, field, message, severity}
      merged.push({ code: issue.code, field: issue.field, message: issue.message, severity: issue.severity });
    }
  }

  if (merged.length === 0) {
    return;
  }
  extra_fields[QA_FLAGS_FIELD] = JSON.stringify(merged);
}

/** 去重键：`(code, field)` 的拼接形式（用 NUL 分隔，避免 code/field 含分隔符时串键）。 */
function dedupeKey(code: string, field: string): string {
  return `${code}\u0000${field}`;
}

/** 既有条目的去重键；`code` / `field` 任一不是字符串时返回 null（该条目不参与去重）。 */
function dedupeKeyOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const code = record.code;
  const field = record.field;
  if (typeof code !== 'string' || typeof field !== 'string') return null;
  return dedupeKey(code, field);
}

/** `JSON.parse` 的结果包装：失败（语法错误）时 ok=false。 */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false };
    throw error;
  }
}

// ============================================================================
// 规则 10：字段 min/max/allowed_values/regex（包装 FieldExtractionRule）
// ============================================================================

/**
 * 用模板字段规则 lint 单个字段值，输出结构化 `LintIssue`
 * （与 `streaming_anki_service::validate_field_against_rule` 语义一致，
 * 但输出统一的 lint 结构，供 lint 管线外的调用方复用）。
 *
 * 长度按 Unicode 字符数计；`validation_pattern` 编译失败视为模板配置
 * 问题，跳过该项不惩罚卡片。
 */
export async function lintFieldAgainstRule(
  fieldName: string,
  value: string,
  rule: FieldExtractionRule__De,
  regex: Pick<NativeRegex, 'compile' | 'isMatch'>,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const charCount = [...value].length;

  const min = rule.min_length ?? null;
  if (min !== null && charCount < min) {
    issues.push(
      LintIssue.new(
        'field_rule_min_length',
        fieldName,
        `长度 ${charCount} 小于最小长度 ${min}`,
        'warn',
      ),
    );
  }
  const max = rule.max_length ?? null;
  if (max !== null && charCount > max) {
    issues.push(
      LintIssue.new(
        'field_rule_max_length',
        fieldName,
        `长度 ${charCount} 超过最大长度 ${max}`,
        'warn',
      ),
    );
  }
  const allowed = rule.allowed_values ?? null;
  if (allowed !== null && allowed.length > 0) {
    const matched = allowed.some((candidate) =>
      typeof candidate === 'string' ? candidate === value : JSON.stringify(candidate) === value,
    );
    if (!matched) {
      const preview = [...value].slice(0, 40).join('');
      issues.push(
        LintIssue.new(
          'field_rule_allowed_values',
          fieldName,
          `值 "${preview}" 不在允许值列表中`,
          'warn',
        ),
      );
    }
  }
  const pattern = rule.validation_pattern?.trim() ?? '';
  if (pattern !== '') {
    // Rust `regex::Regex::new(pattern)`：编译失败只视为模板配置问题并跳过，
    // 其它错误（引擎故障）按 Rust 的 `?` 语义向上传播。
    let compiled: NativeRegexPattern | null;
    try {
      compiled = await regex.compile(pattern);
    } catch (error) {
      if (!(error instanceof NativeRegexCompileError)) throw error;
      compiled = null;
    }
    if (compiled !== null && !(await regex.isMatch(compiled, value))) {
      issues.push(
        LintIssue.new(
          'field_rule_pattern',
          fieldName,
          `值不匹配校验模式 ${pattern}`,
          'warn',
        ),
      );
    }
  }

  return issues;
}
