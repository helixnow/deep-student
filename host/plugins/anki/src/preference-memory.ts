/**
 * 用户制卡偏好记忆（Mem0 风格，ADD-only 简化版）。
 *
 * 移植自 `src-tauri/crates/dstu-anki/src/anki_preference_memory.rs`：从用户在制卡
 * 会话中的真实行为（编辑前后 diff、删卡、extraRequirements 显式要求）确定性抽取
 * 长期偏好，并在下一次制卡时以极短的 prompt 片段注入。
 *
 * 设计取舍同 Rust 版：
 * - 纯逻辑、零 I/O、零 LLM：只做「观察 → 候选偏好 → 合并 → 检索」的纯函数变换；
 *   持久化由调用方（ChatAnki executor）负责。
 * - ADD-only：合并阶段绝不改写既有条目语句、绝不删除条目；重复观察只累计证据数
 *   并小幅提升置信度。矛盾偏好以两条独立条目共存，检索层按分数择一注入。
 *   唯一例外是容量维护：条目超过 {@link MAX_STORE_ENTRIES} 时淘汰最低分条目。
 * - token 预算：{@link retrievePreferencePrompt} 按「每 kind 取最高分一条 →
 *   按分数降序装箱」裁剪，估算规则见 {@link estimateTokens}。
 */

/** 偏好条目上限。超过后淘汰得分最低的条目（容量维护，非抽取语义）。 */
export const MAX_STORE_ENTRIES = 64;

/** 检索注入的默认 token 预算（约 3-4 行短句）。 */
export const DEFAULT_PROMPT_TOKEN_BUDGET = 120;

/** 置信度上限：证据再多也不允许把启发式抽取的偏好当成绝对事实。 */
export const CONFIDENCE_CAP = 0.95;

/** 判定「编辑显著改变语言」的 CJK 占比变化阈值。 */
const LANGUAGE_SHIFT_THRESHOLD = 0.25;

/** 判定「删卡比例高 → 用户嫌卡太密」的删除比例阈值。 */
const DELETION_DENSITY_THRESHOLD = 0.3;

/** 删卡密度信号要求的最小生成卡数（样本太小不足以下结论）。 */
const DELETION_MIN_GENERATED = 5;

/** u32 上界，对应 Rust 的 `saturating_add`。 */
const U32_MAX = 0xffff_ffff;

// ---------------------------------------------------------------------------
// 输入：会话观察
// ---------------------------------------------------------------------------

/** 一次字段编辑观察（用户把某张卡的某个字段从 before 改成 after）。 */
export interface CardEditObservation {
  /** 字段名（"front" / "back" / 模板扩展字段名）。 */
  field: string;
  before: string;
  after: string;
}

/** 一次删卡观察（记录被删卡的正反面，用于后续密度/内容信号）。 */
export interface CardDeleteObservation {
  front: string;
  back: string;
}

/**
 * 一个制卡会话结束后收集到的全部行为观察。
 *
 * 全部字段可为空/零值；抽取器对缺失信号一律保守（不产出候选）。
 */
export interface SessionObservation {
  /** 用户在 run/start 时传入的显式补充要求（最强信号）。 */
  extra_requirements: string | null;
  /** 用户对生成卡片的编辑（before/after diff）。 */
  edits: CardEditObservation[];
  /** 用户删除的生成卡。 */
  deletions: CardDeleteObservation[];
  /** 本会话生成的卡片总数（删除比例的分母）。 */
  generated_count: number;
  /** 用户主动选择/换到的模板名（null 表示未表达模板意愿）。 */
  template_used: string | null;
}

/** `SessionObservation::default()`。 */
export function createSessionObservation(
  overrides: Partial<SessionObservation> = {},
): SessionObservation {
  return {
    extra_requirements: null,
    edits: [],
    deletions: [],
    generated_count: 0,
    template_used: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 偏好模型
// ---------------------------------------------------------------------------

/**
 * 偏好类别（serde `rename_all = "snake_case"` 的线上取值）。检索时每类最多注入
 * 一条，保证 prompt 极短且无内部矛盾。
 */
export type PreferenceKind =
  /** 卡片正文/答案语言（subject: "zh" / "en"）。 */
  | 'language'
  /** 卡片密度（subject: 数字上限或 null 表示定性「少而精」）。 */
  | 'card_density'
  /** 禁止翻译 / 保留术语原文。 */
  | 'no_translation'
  /** 模板偏好（subject: 模板名）。 */
  | 'template_preference';

/** 抽取阶段产出的候选偏好（尚未进入存储）。 */
export interface PreferenceCandidate {
  kind: PreferenceKind;
  /** 可直接注入 prompt 的一句话偏好描述（中文短句）。 */
  statement: string;
  /** 结构化主体：语言代码 / 数量 / 模板名，供检索匹配用。 */
  subject: string | null;
  /** 抽取置信度 [0,1]：显式要求 > 重复编辑行为 > 单次统计信号。 */
  confidence: number;
  /** 人可读的证据说明，用于审计与调试。 */
  evidence: string;
}

/**
 * Rust i64 毫秒：完整范围用 bigint；旧 number 调用保留其已表示的整数值。
 * 不以 MAX_SAFE_INTEGER 收窄 Rust 的取值域，不把 bigint 转为 Number。
 */
export type PreferenceTimestamp = number | bigint;

/** 存储中的偏好条目（候选 + 证据计数 + 时间戳）。 */
export interface PreferenceEntry {
  kind: PreferenceKind;
  statement: string;
  subject: string | null;
  confidence: number;
  /** 该偏好被独立观察到的次数（重复观察 → 强化）。 */
  evidence_count: number;
  /** 最近一次证据说明（ADD-only：语句不改写，证据允许刷新）。 */
  last_evidence: string;
  first_seen_ms: PreferenceTimestamp;
  last_seen_ms: PreferenceTimestamp;
}

/** 偏好存储。调用方以 JSON 数字词法无损持久化 bigint，不直接 JSON.stringify 或转 Number。 */
export interface PreferenceStore {
  entries: PreferenceEntry[];
}

/** `PreferenceStore::default()`。 */
export function createPreferenceStore(): PreferenceStore {
  return { entries: [] };
}

/** {@link consolidate} 的结果摘要。 */
export interface ConsolidateOutcome {
  /** 新增条目的语句。 */
  added: string[];
  /** 被强化（证据 +1）条目的语句。 */
  reinforced: string[];
  /** 因容量维护被淘汰条目的语句。 */
  evicted: string[];
}

/** `ConsolidateOutcome::default()`。 */
export function createConsolidateOutcome(): ConsolidateOutcome {
  return { added: [], reinforced: [], evicted: [] };
}

/** `PreferenceKind` 的 `Debug` 形式（`normalized_key` 的键前缀）。 */
const KIND_DEBUG_NAME: Record<PreferenceKind, string> = {
  language: 'Language',
  card_density: 'CardDensity',
  no_translation: 'NoTranslation',
  template_preference: 'TemplatePreference',
};

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 单精度取整：Rust 侧这些量都是 `f32`。 */
function f32(value: number): number {
  return Math.fround(value);
}

const WHITE_SPACE = /\p{White_Space}/u;

/** Rust `char::is_whitespace`（Unicode `White_Space` 属性）。 */
function isWhitespace(ch: string): boolean {
  return WHITE_SPACE.test(ch);
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) as number;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0x3040 && code <= 0x30ff) // 日文假名（同属「非拉丁」信号）
  );
}

/** 非空白字符中 CJK 的占比；空串返回 0。 */
function cjkRatio(text: string): number {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    if (isWhitespace(ch)) continue;
    total += 1;
    if (isCjk(ch)) cjk += 1;
  }
  if (total === 0) return 0;
  return f32(f32(cjk) / f32(total));
}

/**
 * 粗略 token 估算：CJK 每字 1 token，其余字符按 4 字符 ≈ 1 token。
 *
 * 刻意偏保守（高估）：预算裁剪宁可少注入一行，也不要挤占正文预算。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isWhitespace(ch)) continue;
    if (isCjk(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.floor((other + 3) / 4);
}

const NORMALIZE_STRIP = new Set(Array.from('，。、；;：:！!？?「」“”"\'（）()'));

/** 归一化：小写 + 去空白/常见标点（逐字符小写，对齐 `char::to_lowercase`）。 */
function normalizeForKey(text: string): string {
  let out = '';
  for (const ch of text) {
    if (isWhitespace(ch) || NORMALIZE_STRIP.has(ch)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

/** 归一化去重键：避免同义句因标点差异重复入库。 */
function normalizedKey(kind: PreferenceKind, statement: string, subject: string | null): string {
  const normalizedSubject = subject === null ? '' : normalizeForKey(subject);
  return `${KIND_DEBUG_NAME[kind]}|${normalizeForKey(statement)}|${normalizedSubject}`;
}

const ASCII_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'were',
  'have',
  'has',
  'not',
  'you',
  'can',
  'will',
  'from',
  'into',
  'when',
  'what',
  'which',
]);

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** 提取 ASCII 术语（≥3 个字母的单词），转小写；过滤常见英文虚词。 */
function asciiTerms(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (isAsciiAlpha(code)) {
      current += String.fromCodePoint(code).toLowerCase();
    } else {
      if (current.length >= 3 && !ASCII_STOPWORDS.has(current)) out.push(current);
      current = '';
    }
  }
  if (current.length >= 3 && !ASCII_STOPWORDS.has(current)) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// 抽取：extraRequirements 显式信号
// ---------------------------------------------------------------------------

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

const NUMERIC_LIMIT_ZH = /(?:最多|不超过)\s*(\d{1,3})\s*张/;
const NUMERIC_LIMIT_EN = /(?:at most|no more than|max(?:imum)?(?: of)?)\s*(\d{1,3})\s*cards?/;
const TEMPLATE_ZH = /(?:请用|使用|用)\s*[「“"']?([^「」“”"'\s，。,；;.!？?]{1,24}?)[」”"']?\s*模板/;
const TEMPLATE_EN = /use\s+(?:the\s+)?"?([a-z0-9 _-]{1,32}?)"?\s+template/iu;

function extractFromExtraRequirements(raw: string, out: PreferenceCandidate[]): void {
  const text = raw.trim();
  if (text === '') return;
  const lower = text.toLowerCase();

  // 语言偏好：中英信号同时出现视为歧义，保守放弃。
  const wantsZh = containsAny(lower, [
    '用中文',
    '中文回答',
    '中文作答',
    '答案用中文',
    '中文解释',
    'in chinese',
  ]);
  const wantsEn = containsAny(lower, ['用英文', '英文回答', '英文作答', '全英文', 'in english']);
  if (wantsZh !== wantsEn) {
    const [subject, statement] = wantsZh
      ? ['zh', '卡片正文与答案使用中文书写']
      : ['en', '卡片正文与答案使用英文书写'];
    out.push({
      kind: 'language',
      statement,
      subject,
      confidence: 0.9,
      evidence: 'extraRequirements 显式指定语言',
    });
  }

  // 禁止翻译 / 保留原文。
  if (
    containsAny(lower, [
      '不要翻译',
      '不翻译',
      '禁止翻译',
      '保留英文',
      '保留原文',
      '保留术语',
      '术语不译',
      'do not translate',
      "don't translate",
      'keep the original',
      'keep original',
    ])
  ) {
    out.push({
      kind: 'no_translation',
      statement: '专业术语保留原文，不要翻译',
      subject: null,
      confidence: 0.9,
      evidence: 'extraRequirements 显式要求不翻译/保留原文',
    });
  }

  // 卡密度：数字上限优先，其次定性「少而精」。
  const numericLimit = NUMERIC_LIMIT_ZH.exec(lower)?.[1] ?? NUMERIC_LIMIT_EN.exec(lower)?.[1];
  if (numericLimit !== undefined) {
    out.push({
      kind: 'card_density',
      statement: `控制卡片数量：每份材料不超过 ${numericLimit} 张`,
      subject: numericLimit,
      confidence: 0.9,
      evidence: 'extraRequirements 显式限制卡片数量',
    });
  } else if (
    containsAny(lower, ['少而精', '宁缺毋滥', '不要太多卡', '卡片少一点', 'fewer cards'])
  ) {
    out.push({
      kind: 'card_density',
      statement: '控制卡片密度：少而精，避免把同一知识点拆成大量浅层卡片',
      subject: null,
      confidence: 0.85,
      evidence: 'extraRequirements 表达了少而精的密度倾向',
    });
  }

  // 模板偏好：匹配「用/使用 X 模板」，带否定前缀（不/别/勿/免）时跳过。
  const zhMatch = TEMPLATE_ZH.exec(text);
  if (zhMatch !== null) {
    const prefix = Array.from(text.slice(0, zhMatch.index)).slice(-2);
    const negated = prefix.some((ch) => ch === '不' || ch === '别' || ch === '勿' || ch === '免');
    if (!negated) {
      const name = zhMatch[1]?.trim() ?? '';
      if (name !== '') {
        out.push({
          kind: 'template_preference',
          statement: `优先使用「${name}」模板`,
          subject: name,
          confidence: 0.9,
          evidence: 'extraRequirements 显式指定模板',
        });
      }
    }
  }
  const enMatch = TEMPLATE_EN.exec(text);
  if (enMatch !== null) {
    const name = enMatch[1]?.trim() ?? '';
    if (name !== '' && !out.some((c) => c.kind === 'template_preference')) {
      out.push({
        kind: 'template_preference',
        statement: `优先使用「${name}」模板`,
        subject: name,
        confidence: 0.9,
        evidence: 'extraRequirements 显式指定模板',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 抽取：编辑 diff 信号
// ---------------------------------------------------------------------------

function extractFromEdits(edits: readonly CardEditObservation[], out: PreferenceCandidate[]): void {
  let toZh = 0;
  let toEn = 0;
  const reinstatedTerms: string[] = [];
  let reinstatingEdits = 0;

  for (const edit of edits) {
    const before = edit.before.trim();
    const after = edit.after.trim();
    if (before === '' || after === '' || before === after) continue;

    // 语言迁移：CJK 占比显著变化。
    const delta = f32(cjkRatio(after) - cjkRatio(before));
    if (delta >= LANGUAGE_SHIFT_THRESHOLD) {
      toZh += 1;
    } else if (delta <= -LANGUAGE_SHIFT_THRESHOLD) {
      toEn += 1;
    }

    // 术语回写：混排文本（CJK ≥ 20%）里，after 新增了 before 没有的 ASCII 术语，
    // 说明用户把被翻译掉的原文术语改了回来。
    if (cjkRatio(after) >= 0.2) {
      const beforeTerms = asciiTerms(before);
      let editAdded = false;
      for (const term of asciiTerms(after)) {
        if (!beforeTerms.includes(term) && !reinstatedTerms.includes(term)) {
          reinstatedTerms.push(term);
          editAdded = true;
        }
      }
      if (editAdded) reinstatingEdits += 1;
    }
  }

  // 语言偏好：至少 2 次同向改写，且方向占优。
  if (toZh >= 2 && toZh > toEn) {
    out.push({
      kind: 'language',
      statement: '卡片正文与答案使用中文书写',
      subject: 'zh',
      confidence: f32(Math.min(f32(0.55 + 0.05 * f32(toZh - 2)), 0.75)),
      evidence: `用户 ${toZh} 次将卡片内容改写为中文`,
    });
  } else if (toEn >= 2 && toEn > toZh) {
    out.push({
      kind: 'language',
      statement: '卡片正文与答案使用英文书写',
      subject: 'en',
      confidence: f32(Math.min(f32(0.55 + 0.05 * f32(toEn - 2)), 0.75)),
      evidence: `用户 ${toEn} 次将卡片内容改写为英文`,
    });
  }

  // 禁止翻译：跨编辑累计回写 ≥ 2 个不同术语。
  if (reinstatedTerms.length >= 2) {
    const examples = reinstatedTerms.slice(0, 3);
    out.push({
      kind: 'no_translation',
      statement: `专业术语保留原文，不要翻译（如 ${examples.join('、')}）`,
      subject: null,
      confidence: f32(Math.min(f32(0.55 + 0.05 * f32(reinstatedTerms.length - 2)), 0.75)),
      evidence: `用户在 ${reinstatingEdits} 处编辑中写回术语原文：${examples.join('、')}`,
    });
  }
}

// ---------------------------------------------------------------------------
// 抽取：删卡密度信号 + 模板选择信号
// ---------------------------------------------------------------------------

function extractFromDeletions(
  deletions: readonly CardDeleteObservation[],
  generatedCount: number,
  out: PreferenceCandidate[],
): void {
  if (generatedCount < DELETION_MIN_GENERATED || deletions.length === 0) return;
  const ratio = f32(f32(deletions.length) / f32(generatedCount));
  if (ratio < DELETION_DENSITY_THRESHOLD) return;
  out.push({
    kind: 'card_density',
    statement: '控制卡片密度：少而精，避免把同一知识点拆成大量浅层卡片',
    subject: null,
    confidence: f32(Math.min(f32(0.5 + ratio * 0.3), 0.85)),
    evidence: `用户删除了 ${deletions.length}/${generatedCount} 张生成卡（${formatPercent0(f32(ratio * 100))}%）`,
  });
}

/** Rust `format!("{:.0}", value)`：定点 0 位小数。 */
function formatPercent0(value: number): string {
  const text = value.toFixed(0);
  return text === '-0' ? '0' : text;
}

function extractTemplateChoice(
  templateUsed: string | null,
  out: PreferenceCandidate[],
): void {
  const name = templateUsed === null ? '' : templateUsed.trim();
  if (name === '') return;
  // 显式 extraRequirements 模板信号优先；行为信号仅在没有显式信号时补充。
  if (out.some((c) => c.kind === 'template_preference')) return;
  out.push({
    kind: 'template_preference',
    statement: `优先使用「${name}」模板`,
    subject: name,
    confidence: 0.6,
    evidence: '用户在本会话主动选用了该模板',
  });
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 从一个会话的行为观察中抽取候选偏好（纯函数，确定性）。
 *
 * 信号强度排序：extraRequirements 显式要求（0.9）> 重复编辑行为（0.55-0.75）
 * > 单次统计信号（删卡密度，0.5-0.85 随比例）。缺失信号一律不产出候选。
 */
export function extractPreferences(observation: SessionObservation): PreferenceCandidate[] {
  const out: PreferenceCandidate[] = [];
  if (observation.extra_requirements !== null) {
    extractFromExtraRequirements(observation.extra_requirements, out);
  }
  extractFromEdits(observation.edits, out);
  extractFromDeletions(observation.deletions, observation.generated_count, out);
  extractTemplateChoice(observation.template_used, out);
  return out;
}

/**
 * 对一次观察执行完整的「extract → consolidate」写入变换。
 *
 * 即使观察没有达到保守抽取阈值，也会执行 {@link consolidate} 并返回空摘要；
 * 调用方仍可把 store 持久化，以保持生产写入闭环单一且可审计。
 */
export function consolidateObservation(
  store: PreferenceStore,
  observation: SessionObservation,
  nowMs: PreferenceTimestamp,
): ConsolidateOutcome {
  const candidates = extractPreferences(observation);
  return consolidate(store, candidates, nowMs);
}

/**
 * 把候选偏好合并进存储（ADD-only）。
 *
 * - 同 kind + 归一化语句 + 主体完全相同 → 强化：`evidence_count + 1`，
 *   置信度取 `max(旧, 新) + 0.05`（上限 {@link CONFIDENCE_CAP}），刷新时间与证据。
 * - 其余一律新增，绝不改写/删除既有条目（矛盾条目共存，检索时择优）。
 * - 超出 {@link MAX_STORE_ENTRIES} 时按 `置信度 × ln(1+证据数)`（同分比
 *   `last_seen_ms`）淘汰最低分条目——容量维护，不属于抽取语义。
 */
export function consolidate(
  store: PreferenceStore,
  candidates: readonly PreferenceCandidate[],
  nowMs: PreferenceTimestamp,
): ConsolidateOutcome {
  const outcome = createConsolidateOutcome();

  for (const candidate of candidates) {
    const key = normalizedKey(candidate.kind, candidate.statement, candidate.subject);
    const entry = store.entries.find(
      (e) => normalizedKey(e.kind, e.statement, e.subject) === key,
    );
    if (entry !== undefined) {
      entry.evidence_count = Math.min(entry.evidence_count + 1, U32_MAX);
      entry.confidence = f32(
        Math.min(
          f32(f32(Math.max(entry.confidence, candidate.confidence)) + 0.05),
          CONFIDENCE_CAP,
        ),
      );
      entry.last_evidence = candidate.evidence;
      entry.last_seen_ms = nowMs;
      outcome.reinforced.push(entry.statement);
    } else {
      store.entries.push({
        kind: candidate.kind,
        statement: candidate.statement,
        subject: candidate.subject,
        confidence: f32(Math.min(candidate.confidence, CONFIDENCE_CAP)),
        evidence_count: 1,
        last_evidence: candidate.evidence,
        first_seen_ms: nowMs,
        last_seen_ms: nowMs,
      });
      outcome.added.push(candidate.statement);
    }
  }

  while (store.entries.length > MAX_STORE_ENTRIES) {
    let index = 0;
    for (let i = 1; i < store.entries.length; i++) {
      const candidate = store.entries[i] as PreferenceEntry;
      const lowest = store.entries[index] as PreferenceEntry;
      const score = entryScore(candidate);
      const lowestScore = entryScore(lowest);
      if (score < lowestScore || (score === lowestScore && candidate.last_seen_ms < lowest.last_seen_ms)) {
        index = i;
      }
    }
    const [removed] = store.entries.splice(index, 1);
    outcome.evicted.push((removed as PreferenceEntry).statement);
  }

  return outcome;
}

function entryScore(entry: PreferenceEntry): number {
  return f32(entry.confidence * f32(1 + f32(Math.log1p(entry.evidence_count))));
}

/** 模板名匹配：忽略大小写的双向包含（"填空" 可命中 "学术填空题"）。 */
function templateAvailable(subject: string, availableTemplates: readonly string[]): boolean {
  const s = subject.toLowerCase();
  return availableTemplates.some((template) => {
    const t = template.toLowerCase();
    return t.includes(s) || s.includes(t);
  });
}

/**
 * 按 goal + 可用模板检索偏好，装配为可直接注入的短 prompt（有 token 预算）。
 *
 * 规则：
 * - 每个 {@link PreferenceKind} 只取得分最高的一条，避免注入互相矛盾的偏好；
 * - `template_preference` 的模板必须出现在 `availableTemplates` 中，否则跳过
 *   （模板可能已被删除/改名，注入无效指令只会浪费预算）；
 * - 主体命中 `goal` 关键词的条目获得加权；
 * - 按 {@link estimateTokens} 估算，超预算的行整行丢弃；一行都放不下时返回空串。
 *
 * 空存储或全部被过滤时返回空串，调用方据此决定是否注入。
 */
export function retrievePreferencePrompt(
  store: PreferenceStore,
  goal: string,
  availableTemplates: readonly string[],
  maxTokens: number,
): string {
  if (store.entries.length === 0 || maxTokens === 0) return '';
  const goalLower = goal.toLowerCase();

  // 打分 + 过滤不可用模板。
  const scored: Array<{ score: number; entry: PreferenceEntry }> = [];
  for (const entry of store.entries) {
    if (entry.kind === 'template_preference') {
      if (entry.subject === null || !templateAvailable(entry.subject, availableTemplates)) continue;
    }
    let score = entryScore(entry);
    const subject = entry.subject;
    if (subject !== null && subject !== '' && goalLower.includes(subject.toLowerCase())) {
      score = f32(score + 0.5);
    }
    scored.push({ score, entry });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || (b.entry.last_seen_ms < a.entry.last_seen_ms
        ? -1
        : b.entry.last_seen_ms > a.entry.last_seen_ms ? 1 : 0),
  );

  // 每 kind 择一。
  const picked: PreferenceEntry[] = [];
  for (const { entry } of scored) {
    if (picked.some((p) => p.kind === entry.kind)) continue;
    picked.push(entry);
  }

  // 预算装箱：header + 按分数降序尽量多装行。
  const header = '【用户制卡偏好】来自历史制卡行为，若与本次要求冲突，以本次要求为准：';
  let used = estimateTokens(header);
  const lines: string[] = [];
  for (const entry of picked) {
    const line = `- ${entry.statement}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) continue;
    used += cost;
    lines.push(line);
  }
  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
}
