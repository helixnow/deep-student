/**
 * 金标卡集挖掘纯函数（`crates/dstu-anki/src/anki_gold_set.rs` 全量移植）。
 *
 * 「改前 = 劣化样本、改后 = 金标」：从「编辑前原文 + 编辑后现状 + 留存信号」
 * 三元组中提取金标正例、修正对与负例。本模块不读 SQLite、不写文件，
 * 只做确定性标注、编辑距离、lint 契约校验与脱敏导出整形。
 *
 * 所有对 Unicode 空白/字节/正则敏感的位置都按 Rust 语义实现：
 * - `str::trim` 用平台 `rustTrim`（不含 U+FEFF）；
 * - 字节上限按 UTF-8 计；
 * - PII 正则走 F7 `nativeRegex`（Rust `regex` crate 的 wasm 引擎），
 *   避免 JS `RegExp` 的方言差异（例如 `\d` 的 Unicode 范围）。
 */
import type { NativeRegex } from '../../../platform/native/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { QA_FLAGS_FIELD, lintCard, type CardLintInput, type LintConfig, type LintSeverity } from './anki-qa-lint.ts';
import { defaultLintConfig } from './anki-qa-lint.ts';
import { nowRfc3339 } from './time.ts';

/** `extra_fields_json` 中保存"生成时原文快照"的键名。 */
export const ORIGINAL_GENERATION_FIELD = '_original_generation';
/** critic 自动修订写入 `_qa_flags` 的稳定来源码。 */
export const CRITIC_REVISED_QA_CODE = 'llm_critic_revised';
/** `extra_fields_json` 中保存"最后一次内容写入者"溯源的键名。 */
export const CONTENT_PROVENANCE_FIELD = '_content_provenance';
/** provenance `actor` 的 wire 值：用户编辑。 */
export const PROVENANCE_ACTOR_USER = 'user';
/** provenance `actor` 的 wire 值：LLM critic 自动修订。 */
export const PROVENANCE_ACTOR_LLM_CRITIC = 'llm_critic';
/** provenance `actor` 的 wire 值：APKG 等外部导入。 */
export const PROVENANCE_ACTOR_IMPORT = 'import';
/** provenance `actor` 的 wire 值：同步合并写入。 */
export const PROVENANCE_ACTOR_SYNC = 'sync';

/** `_original_generation` 值本身的 UTF-8 字节硬上限。 */
export const ORIGINAL_GENERATION_MAX_BYTES = 16 * 1024;

/** `anki_qa_lint` 全部稳定 lint code 字符串（跨语言契约清单）。 */
export const LINT_CONTRACT_CODES: readonly string[] = [
  'front_back_identical',
  'empty_front',
  'empty_back',
  'cloze_unclosed',
  'cloze_empty_answer',
  'cloze_bad_index',
  'cloze_missing',
  'answer_leak',
  'multi_concept',
  'front_too_long',
  'placeholder_residue',
  'todo_residue',
  'xxx_residue',
  'empty_brackets',
  'tags_empty',
  'duplicate_in_document',
  'near_duplicate',
  'mixed_language',
  'bare_latex',
  'mcq_too_few_options',
  'mcq_answer_not_in_options',
  'mcq_missing_answer',
  'field_rule_min_length',
  'field_rule_max_length',
  'field_rule_allowed_values',
  'field_rule_pattern',
  'legacy_flags_unparsed',
];

// ============================================================================
// 输入/输出结构
// ============================================================================

/** 卡片内容快照（编辑前或编辑后的某一时刻）。`text` 为 null 表示问答卡。 */
export interface CardSnapshot {
  front: string;
  back: string;
  text: string | null;
}

/** 挖掘候选：调用方从 `anki_cards` + FSRS 复习日志组装的单卡切面。 */
export interface GoldCandidate {
  card_id: string;
  /** 当前（编辑后）内容。 */
  current: CardSnapshot;
  /** 生成时原文；null = 埋点缺失，只能走留存信号路径。 */
  original: CardSnapshot | null;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
  review_count: number;
  again_count: number;
  was_error_card: boolean;
  is_error_card: boolean;
  /** 当前内容由 critic 自动修订，而非用户编辑。 */
  critic_revised: boolean;
  /** 最后一次内容写入的 actor；null = 旧数据 / 埋点缺失。 */
  edit_actor: string | null;
}

/** 标注结果（serde `rename_all = "snake_case"`）。 */
export type GoldLabel =
  | 'kept_unedited'
  | 'edited_minor'
  | 'edited_major'
  | 'deleted_early'
  | 'error_card_repaired'
  | 'unlabeled';

/** 修正对：original 应劣化、edited 应为金标。 */
export interface RepairPair {
  original: CardSnapshot;
  edited: CardSnapshot;
  /** 字符级编辑距离 / 原文长度（0.0 = 未变）。 */
  distance_ratio: number;
}

/** 单卡挖掘结果。 */
export interface GoldSample {
  card_id: string;
  label: GoldLabel;
  reason: string;
  repair_pair: RepairPair | null;
}

/** 挖掘阈值（默认值即 plan §3 伪代码中的数字）。 */
export interface GoldMiningConfig {
  edit_grace_ms: number;
  min_review_count: number;
  max_lapse_rate: number;
  minor_edit_max_ratio: number;
  early_delete_window_ms: number;
}

/** `GoldMiningConfig::default()`。 */
export function defaultGoldMiningConfig(): GoldMiningConfig {
  return {
    edit_grace_ms: 5 * 60 * 1000,
    min_review_count: 3,
    max_lapse_rate: 0.4,
    minor_edit_max_ratio: 0.25,
    early_delete_window_ms: 24 * 60 * 60 * 1000,
  };
}

/** 首次写入 `_original_generation` 时可能发生的非致命错误。 */
export type OriginalGenerationSnapshotError =
  | { type: 'Serialization'; message: string }
  | { type: 'TooLarge'; actual_bytes: number; max_bytes: number };

/** `OriginalGenerationSnapshotError` 的 `Display`。 */
export function originalGenerationSnapshotErrorMessage(
  error: OriginalGenerationSnapshotError,
): string {
  if (error.type === 'Serialization') return `快照序列化失败: ${error.message}`;
  return `快照大小 ${error.actual_bytes} 字节超过上限 ${error.max_bytes} 字节`;
}

/** 各标签计数。 */
export interface GoldSetStats {
  kept_unedited: number;
  edited_minor: number;
  edited_major: number;
  deleted_early: number;
  error_card_repaired: number;
  unlabeled: number;
}

/** `_content_provenance` 的结构化值（camelCase，未知字段忽略）。 */
export interface ContentProvenance {
  actor: string;
  code?: string | null;
  at?: string | null;
}

/** 修正对的 lint 契约校验结果。 */
export interface RepairPairLintReport {
  original_codes: string[];
  edited_codes: string[];
  original_flagged: boolean;
  edited_clean: boolean;
  lint_blind_spot: boolean;
}

// ============================================================================
// 内部编解码
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** serde `CardSnapshot` 反序列化：未知字段忽略，front/back 缺省空串。 */
function decodeCardSnapshot(value: unknown): CardSnapshot | null {
  if (!isPlainObject(value)) return null;
  const front = Object.hasOwn(value, 'front') ? value.front : '';
  const back = Object.hasOwn(value, 'back') ? value.back : '';
  if (typeof front !== 'string' || typeof back !== 'string') return null;
  let text: string | null = null;
  if (Object.hasOwn(value, 'text')) {
    const raw = value.text;
    if (raw !== null) {
      if (typeof raw !== 'string') return null;
      text = raw;
    }
  }
  return { front, back, text };
}

/** serde `CardSnapshot` 序列化：`text: null` 省略。 */
export function cardSnapshotToJson(snapshot: CardSnapshot): Record<string, unknown> {
  const obj: Record<string, unknown> = { front: snapshot.front, back: snapshot.back };
  if (snapshot.text !== null) obj.text = snapshot.text;
  return obj;
}

/** serde `GoldCandidate` 反序列化：`critic_revised` / `edit_actor` 缺省。 */
export function goldCandidateFromJson(value: unknown): GoldCandidate | null {
  if (!isPlainObject(value)) return null;
  const cardId = value.card_id;
  const current = decodeCardSnapshot(value.current);
  if (typeof cardId !== 'string' || current === null) return null;
  let original: CardSnapshot | null = null;
  if (value.original !== undefined && value.original !== null) {
    original = decodeCardSnapshot(value.original);
    if (original === null) return null;
  }
  const numbers = ['created_at_ms', 'updated_at_ms', 'review_count', 'again_count'] as const;
  for (const key of numbers) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return null;
  }
  const bools = ['was_error_card', 'is_error_card'] as const;
  for (const key of bools) {
    if (typeof value[key] !== 'boolean') return null;
  }
  let deletedAt: number | null = null;
  if (value.deleted_at_ms !== undefined && value.deleted_at_ms !== null) {
    if (typeof value.deleted_at_ms !== 'number' || !Number.isFinite(value.deleted_at_ms)) return null;
    deletedAt = value.deleted_at_ms;
  }
  const criticRevised = value.critic_revised === undefined ? false : value.critic_revised;
  if (typeof criticRevised !== 'boolean') return null;
  let editActor: string | null = null;
  if (value.edit_actor !== undefined && value.edit_actor !== null) {
    if (typeof value.edit_actor !== 'string') return null;
    editActor = value.edit_actor;
  }
  return {
    card_id: cardId,
    current,
    original,
    created_at_ms: value.created_at_ms as number,
    updated_at_ms: value.updated_at_ms as number,
    deleted_at_ms: deletedAt,
    review_count: value.review_count as number,
    again_count: value.again_count as number,
    was_error_card: value.was_error_card as boolean,
    is_error_card: value.is_error_card as boolean,
    critic_revised: criticRevised,
    edit_actor: editActor,
  };
}

/** 可选字符串字段：缺失/null → null；类型不符 → undefined。 */
function optionalStringField(
  object: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!Object.hasOwn(object, key)) return null;
  const raw = object[key];
  if (raw === null) return null;
  return typeof raw === 'string' ? raw : undefined;
}

// ============================================================================
// 编辑前原文提取
// ============================================================================

/**
 * 把生成完成、清理后的卡片正文写入 `extra_fields`，供后续用户编辑后挖掘修正对。
 * 键已存在时返回 false 并逐字节保留既有值（幂等）；序列化/体积失败返回错误，
 * 不修改 `extras`。
 */
export function insertOriginalGenerationOnce(
  extras: Record<string, string>,
  front: string,
  back: string,
  text: string | null,
): { ok: true; inserted: boolean } | { ok: false; error: OriginalGenerationSnapshotError } {
  if (Object.hasOwn(extras, ORIGINAL_GENERATION_FIELD)) {
    return { ok: true, inserted: false };
  }

  const snapshot: CardSnapshot = { front, back, text };
  let serialized: string;
  try {
    serialized = JSON.stringify(cardSnapshotToJson(snapshot));
  } catch (error) {
    return {
      ok: false,
      error: { type: 'Serialization', message: error instanceof Error ? error.message : String(error) },
    };
  }
  const actualBytes = utf8Bytes(serialized);
  if (actualBytes > ORIGINAL_GENERATION_MAX_BYTES) {
    return {
      ok: false,
      error: {
        type: 'TooLarge',
        actual_bytes: actualBytes,
        max_bytes: ORIGINAL_GENERATION_MAX_BYTES,
      },
    };
  }

  extras[ORIGINAL_GENERATION_FIELD] = serialized;
  return { ok: true, inserted: true };
}

/** 从 `extra_fields_json` 原文中解出 `_original_generation`（兼容对象/二次编码字符串）。 */
export function extractOriginalGeneration(
  extraFieldsJson: string,
): CardSnapshot | null {
  let root: unknown;
  try {
    root = JSON.parse(extraFieldsJson) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isPlainObject(root)) return null;
  const raw = root[ORIGINAL_GENERATION_FIELD];
  if (raw === undefined) return null;
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  if (!isPlainObject(candidate)) return null;
  return decodeCardSnapshot(candidate);
}

/** 内存态变体：直接查已反序列化的 `extra_fields`（值必为 JSON 字符串）。 */
export function extractOriginalFromExtras(
  extras: Record<string, string>,
): CardSnapshot | null {
  const raw = extras[ORIGINAL_GENERATION_FIELD];
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isPlainObject(value)) return null;
  return decodeCardSnapshot(value);
}

/** 判断内存态卡片是否带 critic 自动修订来源标记（只看结构化 code）。 */
export function hasCriticRevisionMarker(extras: Record<string, string>): boolean {
  const raw = extras[QA_FLAGS_FIELD];
  if (raw === undefined) return false;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (!Array.isArray(value)) return false;
  return value.some(
    (flag) => isPlainObject(flag) && flag.code === CRITIC_REVISED_QA_CODE,
  );
}

// ============================================================================
// 内容溯源（_content_provenance）
// ============================================================================

/** 用户编辑戳；`code` 为空串时省略。 */
export function userContentProvenance(code: string): ContentProvenance {
  return {
    actor: PROVENANCE_ACTOR_USER,
    code: code === '' ? null : code,
    at: nowRfc3339(),
  };
}

/** critic 自动修订戳（actor=llm_critic, code=llm_critic_revised）。 */
export function llmCriticContentProvenance(): ContentProvenance {
  return {
    actor: PROVENANCE_ACTOR_LLM_CRITIC,
    code: CRITIC_REVISED_QA_CODE,
    at: nowRfc3339(),
  };
}

/** serde 序列化：字段序 actor → code → at，None 省略。 */
export function serializeContentProvenance(provenance: ContentProvenance): string {
  const wire: Record<string, string> = { actor: provenance.actor };
  if (provenance.code !== null && provenance.code !== undefined) wire.code = provenance.code;
  if (provenance.at !== null && provenance.at !== undefined) wire.at = provenance.at;
  return JSON.stringify(wire);
}

/** 写入（覆盖）`_content_provenance`；last-writer-wins。 */
export function insertContentProvenance(
  extras: Record<string, string>,
  provenance: ContentProvenance,
): void {
  extras[CONTENT_PROVENANCE_FIELD] = serializeContentProvenance(provenance);
}

/** 从内存态 `extra_fields` 解出 `_content_provenance`（缺失/非法/形状不符 → null）。 */
export function parseContentProvenance(
  extras: Record<string, string>,
): ContentProvenance | null {
  const raw = extras[CONTENT_PROVENANCE_FIELD];
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isPlainObject(value)) return null;
  const actor = value.actor;
  if (typeof actor !== 'string') return null;
  const code = optionalStringField(value, 'code');
  const at = optionalStringField(value, 'at');
  if (code === undefined || at === undefined) return null;
  return { actor, code, at };
}

/** 卡片是否带可证明的用户编辑戳（actor=user）。 */
export function isUserProvenEdit(extras: Record<string, string>): boolean {
  return parseContentProvenance(extras)?.actor === PROVENANCE_ACTOR_USER;
}

/** 卡片最后一次写入是否为 LLM critic（actor=llm_critic）。 */
export function isLlmCriticActor(extras: Record<string, string>): boolean {
  return parseContentProvenance(extras)?.actor === PROVENANCE_ACTOR_LLM_CRITIC;
}

// ============================================================================
// 编辑距离
// ============================================================================

/** 字符级 Levenshtein 距离，按 Unicode 标量值计。 */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const [long, short] = left.length >= right.length ? [left, right] : [right, left];
  let prev: number[] = Array.from({ length: short.length + 1 }, (_, i) => i);
  let cur: number[] = new Array<number>(short.length + 1).fill(0);
  for (let i = 0; i < long.length; i += 1) {
    cur[0] = i + 1;
    for (let j = 0; j < short.length; j += 1) {
      const cost = long[i] === short[j] ? 0 : 1;
      cur[j + 1] = Math.min(prev[j]! + cost, prev[j + 1]! + 1, cur[j]! + 1);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[short.length]!;
}

function combined(snapshot: CardSnapshot): string {
  let text = `${snapshot.front}\n${snapshot.back}`;
  if (snapshot.text !== null) text += `\n${snapshot.text}`;
  return text;
}

function snapshotIsBlank(snapshot: CardSnapshot): boolean {
  return (
    rustTrim(snapshot.front) === '' &&
    rustTrim(snapshot.back) === '' &&
    (snapshot.text === null ? '' : rustTrim(snapshot.text)) === ''
  );
}

/** 编辑距离比：`edit_distance(original, edited) / len(original)`。原文空白时 1.0。 */
export function editRatio(original: CardSnapshot, edited: CardSnapshot): number {
  if (snapshotIsBlank(original)) {
    return snapshotIsBlank(edited) ? 0 : 1;
  }
  const originalText = combined(original);
  const editedText = combined(edited);
  return editDistance(originalText, editedText) / [...originalText].length;
}

function snapshotEquals(a: CardSnapshot, b: CardSnapshot): boolean {
  return a.front === b.front && a.back === b.back && a.text === b.text;
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

// ============================================================================
// 标注
// ============================================================================

/** 对单个候选做确定性标注（决策树与 Rust 完全一致）。 */
export function classifyCandidate(
  candidate: GoldCandidate,
  config: GoldMiningConfig,
): GoldSample {
  const sample = (
    label: GoldLabel,
    reason: string,
    pair: RepairPair | null,
  ): GoldSample => ({ card_id: candidate.card_id, label, reason, repair_pair: pair });

  // 1. 来源通道：critic 自改不能伪装成用户编辑或用户认可的未编辑正例。
  if (
    candidate.critic_revised ||
    candidate.edit_actor === PROVENANCE_ACTOR_LLM_CRITIC
  ) {
    return sample(
      'unlabeled',
      '带 llm_critic_revised 来源标记，模型自动修订不得进入用户金标',
      null,
    );
  }

  // 2. 删除通道
  if (candidate.deleted_at_ms !== null) {
    const age = candidate.deleted_at_ms - candidate.created_at_ms;
    if (candidate.review_count === 0 && age <= config.early_delete_window_ms) {
      return sample(
        'deleted_early',
        `创建后 ${Math.trunc(age / 60_000)} 分钟内删除且从未复习`,
        null,
      );
    }
    return sample(
      'unlabeled',
      '已删除但曾被复习或超出早删窗口，删除动机不明（可能是内容重复）',
      null,
    );
  }

  // 3. 当前仍是错误卡
  if (candidate.is_error_card) {
    return sample('unlabeled', '当前仍是错误卡，无可用的修复后内容', null);
  }

  // 4. 错误卡修复通道
  if (candidate.was_error_card) {
    if (snapshotIsBlank(candidate.current)) {
      return sample('unlabeled', '错误卡标记已清除但内容为空，疑似清空而非修复', null);
    }
    if (candidate.original === null) {
      return sample(
        'unlabeled',
        '错误卡已修复但缺 _original_generation 原文，无法构成修正对',
        null,
      );
    }
    const ratio = editRatio(candidate.original, candidate.current);
    return sample(
      'error_card_repaired',
      '解析失败样本被用户手工修好（原始坏输出 + 人工正确答案）',
      {
        original: candidate.original,
        edited: candidate.current,
        distance_ratio: ratio,
      },
    );
  }

  // 5. 编辑通道
  if (candidate.original !== null) {
    if (!snapshotEquals(candidate.original, candidate.current)) {
      if (candidate.edit_actor !== PROVENANCE_ACTOR_USER) {
        return sample(
          'unlabeled',
          '内容相对生成快照有变但缺编辑者证明（_content_provenance 非 actor=user），保守不进金标修正对',
          null,
        );
      }
      const ratio = editRatio(candidate.original, candidate.current);
      const pair: RepairPair = {
        original: candidate.original,
        edited: candidate.current,
        distance_ratio: ratio,
      };
      if (ratio < config.minor_edit_max_ratio) {
        return sample(
          'edited_minor',
          `小幅编辑（距离比 ${fixed(ratio, 3)} < ${fixed(config.minor_edit_max_ratio, 2)}）`,
          pair,
        );
      }
      return sample(
        'edited_major',
        `大幅重写（距离比 ${fixed(ratio, 3)} ≥ ${fixed(config.minor_edit_max_ratio, 2)}）`,
        pair,
      );
    }
  } else if (
    candidate.updated_at_ms - candidate.created_at_ms >=
    config.edit_grace_ms
  ) {
    return sample(
      'unlabeled',
      '时间戳显示有编辑但缺 _original_generation 原文，无法构建修正对',
      null,
    );
  }

  // 6. 未编辑：留存信号定夺
  const lapseRate =
    candidate.review_count === 0
      ? 0
      : candidate.again_count / candidate.review_count;
  if (
    candidate.review_count >= config.min_review_count &&
    lapseRate < config.max_lapse_rate
  ) {
    return sample(
      'kept_unedited',
      `未编辑且留存达标（复习 ${candidate.review_count} 次，again 率 ${fixed(lapseRate * 100, 0)}%）`,
      null,
    );
  }
  return sample(
    'unlabeled',
    `未编辑但留存信号不足（复习 ${candidate.review_count} 次 < ${config.min_review_count}，或 again 率 ${fixed(lapseRate * 100, 0)}% ≥ ${fixed(config.max_lapse_rate * 100, 0)}%）`,
    null,
  );
}

/** 批量挖掘：逐候选标注，返回全部样本（含 Unlabeled）。 */
export function mineGoldSet(
  candidates: readonly GoldCandidate[],
  config: GoldMiningConfig,
): GoldSample[] {
  return candidates.map((candidate) => classifyCandidate(candidate, config));
}

/** 各标签计数。 */
export function goldSetStats(samples: readonly GoldSample[]): GoldSetStats {
  const stats: GoldSetStats = {
    kept_unedited: 0,
    edited_minor: 0,
    edited_major: 0,
    deleted_early: 0,
    error_card_repaired: 0,
    unlabeled: 0,
  };
  for (const sample of samples) stats[sample.label] += 1;
  return stats;
}

/** 标签 → fixture 子目录（Unlabeled 不导出）。 */
export function fixtureExportBucket(label: GoldLabel): string | null {
  switch (label) {
    case 'kept_unedited':
      return 'gold/positive';
    case 'edited_minor':
    case 'edited_major':
    case 'error_card_repaired':
      return 'gold/repair-pairs';
    case 'deleted_early':
      return 'gold/negative';
    case 'unlabeled':
      return null;
  }
}

// ============================================================================
// lint 契约校验
// ============================================================================

/** 金标校验用 lint 配置：关闭 Info 级噪声规则。 */
export function goldLintConfig(): LintConfig {
  return {
    ...defaultLintConfig(),
    check_tags_empty: false,
    check_mixed_language: false,
  };
}

function severityAtLeastWarn(severity: LintSeverity): boolean {
  return severity !== 'info';
}

function lintSnapshotCodes(snapshot: CardSnapshot, config: LintConfig): string[] {
  const input: CardLintInput = {
    front: snapshot.front,
    back: snapshot.back,
    text: snapshot.text,
    tags: [],
    extra_fields: {},
  };
  const codes = lintCard(input, config)
    .filter((issue) => severityAtLeastWarn(issue.severity))
    .map((issue) => issue.code);
  return [...new Set(codes)].sort();
}

/** 用生产 lint 引擎校验修正对是否满足「改前劣化、改后金标」契约。 */
export function lintRepairPair(
  pair: RepairPair,
  config: LintConfig,
): RepairPairLintReport {
  const originalCodes = lintSnapshotCodes(pair.original, config);
  const editedCodes = lintSnapshotCodes(pair.edited, config);
  const originalFlagged = originalCodes.length > 0;
  const editedClean = editedCodes.length === 0;
  return {
    original_codes: originalCodes,
    edited_codes: editedCodes,
    original_flagged: originalFlagged,
    edited_clean: editedClean,
    lint_blind_spot:
      !originalFlagged && editedClean && !snapshotEquals(pair.original, pair.edited),
  };
}

// ============================================================================
// Grounded critic 参照对选取
// ============================================================================

/**
 * 从挖掘结果中选出可注入 `anki_critic` grounded prompt 的同源修正对。
 * 金标端必须过生产 lint（Warn+ 零命中）且非空；不要求 original 被 lint 命中；
 * 按 `edited.front`（trim 后）去重；保持输入顺序，最多 `max` 对。
 */
export function selectGroundedReferencePairs(
  samples: readonly GoldSample[],
  lintConfig: LintConfig,
  max: number,
): RepairPair[] {
  const out: RepairPair[] = [];
  const seenFronts = new Set<string>();
  for (const sample of samples) {
    if (out.length >= max) break;
    if (
      sample.label !== 'edited_minor' &&
      sample.label !== 'edited_major' &&
      sample.label !== 'error_card_repaired'
    ) {
      continue;
    }
    const pair = sample.repair_pair;
    if (pair === null) continue;
    if (snapshotIsBlank(pair.edited)) continue;
    if (!lintRepairPair(pair, lintConfig).edited_clean) continue;
    const key = rustTrim(pair.edited.front);
    if (seenFronts.has(key)) continue;
    seenFronts.add(key);
    out.push(pair);
  }
  return out;
}

// ============================================================================
// 脱敏与导出整形
// ============================================================================

const EMAIL_PATTERN = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const PHONE_PATTERN = '(?:^|[^0-9])((?:\\+?86[- ]?)?1[3-9]\\d{9})(?:[^0-9]|$)';
const ID_PATTERN = '\\d{17}[0-9Xx]';
const EMAIL_REPLACEMENT = '[已脱敏邮箱]';
const PHONE_REPLACEMENT = '[已脱敏手机号]';
const ID_REPLACEMENT = '[已脱敏证件号]';

/**
 * 剥离邮箱 / 中国大陆手机号 / 18 位身份证号样式片段，返回（脱敏文本, 替换次数）。
 * 手机号模式带边界捕获组：只替换组 1，保留边界字符。
 */
export async function scrubPii(
  text: string,
  regex: NativeRegex,
): Promise<[string, number]> {
  let out = text;
  let count = 0;

  const email = await regex.compile(EMAIL_PATTERN);
  const emailMatches = await regex.findIter(email, out);
  out = await regex.replaceAll(email, out, EMAIL_REPLACEMENT);
  count += emailMatches.length;

  const phone = await regex.compile(PHONE_PATTERN);
  for (;;) {
    const captures = await regex.captures(phone, out);
    if (captures === null) break;
    const group = captures.groups[1] ?? null;
    if (group === null) break;
    out = out.slice(0, group.start) + PHONE_REPLACEMENT + out.slice(group.end);
    count += 1;
  }

  const id = await regex.compile(ID_PATTERN);
  const idMatches = await regex.findIter(id, out);
  out = await regex.replaceAll(id, out, ID_REPLACEMENT);
  count += idMatches.length;

  return [out, count];
}

async function scrubSnapshot(
  snapshot: CardSnapshot,
  regex: NativeRegex,
): Promise<[CardSnapshot, number]> {
  const [front, c1] = await scrubPii(snapshot.front, regex);
  const [back, c2] = await scrubPii(snapshot.back, regex);
  let text: string | null = null;
  let c3 = 0;
  if (snapshot.text !== null) {
    const [scrubbed, count] = await scrubPii(snapshot.text, regex);
    text = scrubbed;
    c3 = count;
  }
  return [{ front, back, text }, c1 + c2 + c3];
}

/**
 * 样本 → 仓库 fixture JSON（`tests/fixtures/anki-eval/gold` 下 JSON 的形状）。
 * 默认执行 PII 脱敏；Unlabeled 样本不可导出，返回 null。
 */
export async function toFixtureJson(
  sample: GoldSample,
  regex: NativeRegex,
): Promise<Record<string, unknown> | null> {
  if (fixtureExportBucket(sample.label) === null) return null;
  const obj: Record<string, unknown> = {
    id: sample.card_id,
    label: sample.label,
    reason: sample.reason,
  };
  if (sample.repair_pair !== null) {
    const [original] = await scrubSnapshot(sample.repair_pair.original, regex);
    const [edited] = await scrubSnapshot(sample.repair_pair.edited, regex);
    obj.original = cardSnapshotToJson(original);
    obj.edited = cardSnapshotToJson(edited);
    obj.distanceRatio =
      Math.round(sample.repair_pair.distance_ratio * 1000) / 1000;
  }
  return obj;
}

/** 供 critic 注入的金标挖掘默认实现（真实移植，不是测试替身）。 */
export function defaultGoldSetMining(): {
  goldMiningConfigDefault(): GoldMiningConfig;
  mineGoldSet(candidates: readonly GoldCandidate[], config: GoldMiningConfig): GoldSample[];
  goldLintConfig(): LintConfig;
  selectGroundedReferencePairs(
    samples: readonly GoldSample[],
    lintConfig: LintConfig,
    max: number,
  ): RepairPair[];
} {
  return {
    goldMiningConfigDefault: defaultGoldMiningConfig,
    mineGoldSet,
    goldLintConfig,
    selectGroundedReferencePairs,
  };
}
