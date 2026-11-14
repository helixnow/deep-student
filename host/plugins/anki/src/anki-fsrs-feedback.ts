/**
 * FSRS 复习数据回流到制卡生成（Round 3 #5）
 * （`crates/dstu-anki/src/anki_fsrs_feedback.rs:1-774`）。
 *
 * 把本地 FSRS 复习库的统计信号（高 lapse 模板、易混淆标签、平均可提取性、
 * 高遗忘卡片）在制卡开始前回流进生成 prompt，让模型：
 * 1. 避开与库内高遗忘卡语义重复的卡片（同批次语义干扰预警）；
 * 2. 对用户历史薄弱的模板/标签生成更小的原子卡；
 * 3. 对确实相邻易混的知识点生成对比卡。
 *
 * ## 隐私（0824 收口）
 * 统计查询与聚合只读本地 SQLite（`fsrs_card_states` / `anki_cards`），
 * 但**注入的画像文本会进入制卡 prompt 并随生成请求发送到所配置的模型端点**——
 * 配置远端模型时数据会离开本机。因此：
 * 1. 回流必须显式授权：`AnkiGenerationOptions::fsrs_feedback == Some(true)`
 *    才注入，`None` / `Some(false)` 一律跳过（见 `EnhancedAnkiService`）；
 * 2. 默认只注入匿名聚合统计（库规模 / 可提取性 / 模板与标签维度 lapse），
 *    历史卡片正面摘要与同批次干扰预警属卡片原文，仅在
 *    `FsrsFeedbackConfig.includeCardExcerpts` 显式开启时注入；
 * 3. 渲染文案不得声称“数据不上传”。
 *
 * ## 降级
 * 任何查询失败（表缺失、连接失败、空库）都降级为「无反馈」（返回 `null` /
 * 空画像），绝不让制卡流程失败。
 *
 * ## 结构
 * - SQL 只读行由 `repository/anki-fsrs-feedback.ts` 的 `listFeedbackRows` 提供；
 * - 本模块全部为纯函数（输入行 → 画像/文本），便于无 DB 单测；
 * - `buildFeedbackInjection` 是唯一的编排入口（含降级）。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim, rustTrimStart } from '../../../platform/util/index.ts';
import { listFeedbackRows } from '../repository/anki-fsrs-feedback.ts';
import type { AnkiLogger } from './logger.ts';

const MS_PER_DAY = 86_400_000;

/** 回流注入的预算/阈值配置（`FsrsFeedbackConfig`，`rename_all = "camelCase"`）。 */
export interface FsrsFeedbackConfig {
  /** 从 FSRS 库最多扫描的行数（按 lapses 降序取前 N） */
  scanLimit: number;
  /** 进入「高遗忘」名单的最小 lapse 次数 */
  minLapsesForHint: number;
  /** 画像中最多列出的高 lapse 模板数 */
  maxTemplates: number;
  /** 画像中最多列出的易混淆标签数 */
  maxTags: number;
  /** 画像中最多列出的高遗忘卡片示例数 */
  maxHighLapseCards: number;
  /** 干扰预警最多列出的近义高 lapse 卡数 */
  maxInterferenceCards: number;
  /** 每张卡 front 摘要的最大字符数 */
  frontExcerptChars: number;
  /** 画像 section 渲染后的最大字符数（超出截断） */
  maxProfileChars: number;
  /** 干扰 section 渲染后的最大字符数（超出停止追加条目） */
  maxInterferenceChars: number;
  /**
   * 是否在注入内容中包含历史卡片正面摘要（高遗忘卡示例、同批次干扰预警）。
   *
   * 默认 **false**（0824 隐私收口）：注入文本会随生成请求发送到所配置的
   * 模型端点，默认只允许匿名聚合统计外送，不允许历史卡片原文外送。
   */
  includeCardExcerpts: boolean;
}

/** `impl Default for FsrsFeedbackConfig`（`anki_fsrs_feedback.rs:71-86`）。 */
export function defaultFsrsFeedbackConfig(): FsrsFeedbackConfig {
  return {
    scanLimit: 500,
    minLapsesForHint: 2,
    maxTemplates: 5,
    maxTags: 8,
    maxHighLapseCards: 6,
    maxInterferenceCards: 8,
    frontExcerptChars: 60,
    maxProfileChars: 1400,
    maxInterferenceChars: 1600,
    includeCardExcerpts: false,
  };
}

/** 模板维度的 lapse 统计（"due/lapse 高的模板"）。 */
export interface TemplateLapseStat {
  /** 模板 ID；无模板的基础卡归入 `"basic"` */
  templateId: string;
  cards: number;
  dueCards: number;
  totalLapses: number;
  avgLapses: number;
}

/** 标签维度的 lapse 统计（"易混淆标签"）。 */
export interface TagLapseStat {
  tag: string;
  cards: number;
  totalLapses: number;
  avgLapses: number;
}

/** 高遗忘卡片摘要（只含 front 摘要，不含答案，控制注入体积）。 */
export interface HighLapseCard {
  ankiCardId: string;
  frontExcerpt: string;
  lapses: number;
  templateId: string | null;
  tags: string[];
}

/** 用户复习画像：制卡生成前从 FSRS 库聚合出的本地统计。 */
export interface UserReviewProfile {
  generatedAtMs: number;
  /** 已入队 FSRS 的卡片总数 */
  totalCards: number;
  /** 至少复习过一次的卡数 */
  reviewedCards: number;
  /** 当前已到期（due_ms <= now）的卡数 */
  dueCards: number;
  /** 已复习卡的平均可提取性（FSRS 遗忘曲线），空库/无复习为 null */
  avgRetrievability: number | null;
  highLapseTemplates: TemplateLapseStat[];
  confusableTags: TagLapseStat[];
  highLapseCards: HighLapseCard[];
}

/** FSRS 复习数据回流用的只读联表行（`FsrsFeedbackRow`，`rename_all = "camelCase"`）。 */
export interface FsrsFeedbackRow {
  ankiCardId: string;
  front: string;
  templateId: string | null;
  tags: string[];
  state: number;
  stability: number | null;
  lapses: number;
  reps: number;
  dueMs: number;
  lastReviewMs: number | null;
}

/** 同批次语义干扰候选：库内与本次材料主题相近的高 lapse 卡。 */
export interface InterferenceHint {
  ankiCardId: string;
  frontExcerpt: string;
  lapses: number;
  /** 与本次材料的关键词重叠个数（越大越相关） */
  overlapScore: number;
}

/** 高 lapse 卡拆分建议（`suggestSplits` 的输出）。 */
export interface SplitSuggestion {
  front: string;
  back: string;
  /** 启发式依据（人可读，用于 UI/日志展示） */
  rationale: string;
}

/** `UserReviewProfile::is_empty`：画像是否没有任何值得注入的信号。 */
export function isUserReviewProfileEmpty(profile: UserReviewProfile): boolean {
  return profile.totalCards === 0;
}

/** `UserReviewProfile { generated_at_ms, ..Default::default() }`。 */
function emptyUserReviewProfile(generatedAtMs: number): UserReviewProfile {
  return {
    generatedAtMs,
    totalCards: 0,
    reviewedCards: 0,
    dueCards: 0,
    avgRetrievability: null,
    highLapseTemplates: [],
    confusableTags: [],
    highLapseCards: [],
  };
}

// ============================================================
// Rust 字符串语义（`str::trim` / `char` 序列 / `String` 序）
// ============================================================

/** `trim_start_matches(chars)`：反复剥掉行首属于 `chars` 的字符。 */
function trimStartChars(value: string, chars: readonly string[]): string {
  const set = new Set(chars);
  let index = 0;
  while (index < value.length && set.has(value[index]!)) index += 1;
  return value.slice(index);
}

/** `trim_end_matches(chars)`：反复剥掉行尾属于 `chars` 的字符。 */
function trimEndChars(value: string, chars: readonly string[]): string {
  const set = new Set(chars);
  let end = value.length;
  while (end > 0 && set.has(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

/** `str::chars().count()`：Unicode 标量个数（代理对算 1 个）。 */
export function charCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) index += 1;
    count += 1;
  }
  return count;
}

/** `str::chars().take(n).collect()`。 */
function takeChars(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  let taken = 0;
  let index = 0;
  while (index < value.length && taken < maxChars) {
    const code = value.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    taken += 1;
  }
  return value.slice(0, index);
}

/** Rust `String` 序（`str::cmp`）：按 UTF-8 字节逐位比较 = 码位序。 */
function compareRustStrings(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const codeA = a[index]!.codePointAt(0)!;
    const codeB = b[index]!.codePointAt(0)!;
    if (codeA !== codeB) return codeA < codeB ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function firstCodePoint(value: string): { ch: string; text: string } | null {
  if (value.length === 0) return null;
  const code = value.codePointAt(0)!;
  const text = String.fromCodePoint(code);
  return { ch: text, text };
}

// ============================================================
// 纯函数：画像构建
// ============================================================

/** `fsrs::DEFAULT_PARAMETERS[20]`（FSRS-6 decay 参数，f32）。 */
const FSRS6_DEFAULT_DECAY_PARAM = 0.1542;
/** `DECAY_RANGE`（`crates/dstu-learning/src/fsrs_scheduler.rs:28`）。 */
const DECAY_RANGE: readonly [number, number] = [0.1, 0.8];

/**
 * 遗忘曲线常数 `(decay, factor)`：`R(t, S) = (1 + factor · t / S)^decay`
 * （`crates/dstu-learning/src/fsrs_scheduler.rs:412-419`，空参数回退 FSRS-6 默认值）。
 */
function forgettingCurveConstants(): { decay: number; factor: number } {
  const param = Math.fround(FSRS6_DEFAULT_DECAY_PARAM);
  const decay = -Math.min(Math.max(param, DECAY_RANGE[0]), DECAY_RANGE[1]);
  return { decay, factor: Math.pow(0.9, 1 / decay) - 1 };
}

const FORGETTING_CURVE = forgettingCurveConstants();

/** `retrievability`（`crates/dstu-learning/src/fsrs_scheduler.rs:421-426`）。 */
function retrievability(elapsedDays: number, stability: number, decay: number, factor: number): number {
  if (stability <= 0 || !Number.isFinite(stability)) return 0;
  return Math.pow(1 + (factor * Math.max(elapsedDays, 0)) / stability, decay);
}

/** 按 FSRS-6 默认遗忘曲线计算单卡当前可提取性；无复习记录返回 null。 */
function cardRetrievability(row: FsrsFeedbackRow, nowMs: number): number | null {
  const stability = row.stability !== null && row.stability > 0 ? row.stability : null;
  if (stability === null) return null;
  const lastReviewMs = row.lastReviewMs;
  if (lastReviewMs === null) return null;
  const elapsedDays = Math.max((nowMs - lastReviewMs) / MS_PER_DAY, 0);
  return retrievability(elapsedDays, stability, FORGETTING_CURVE.decay, FORGETTING_CURVE.factor);
}

/** 多字节安全的 front 摘要（超长追加省略号）。 */
export function excerpt(text: string, maxChars: number): string {
  const trimmed = rustTrim(text).replace(/[\n\r]/g, ' ');
  if (charCount(trimmed) <= maxChars) return trimmed;
  return `${takeChars(trimmed, maxChars)}…`;
}

interface TemplateAccumulator {
  cards: number;
  dueCards: number;
  totalLapses: number;
}

interface TagAccumulator {
  cards: number;
  totalLapses: number;
}

/** 从只读行聚合用户复习画像（纯函数，空输入产出空画像）。 */
export function buildProfile(
  rows: readonly FsrsFeedbackRow[],
  nowMs: number,
  cfg: FsrsFeedbackConfig,
): UserReviewProfile {
  const profile = emptyUserReviewProfile(nowMs);
  profile.totalCards = rows.length;
  if (rows.length === 0) return profile;

  let retrievabilitySum = 0;
  let retrievabilityCount = 0;
  const byTemplate = new Map<string, TemplateAccumulator>();
  const byTag = new Map<string, TagAccumulator>();

  for (const row of rows) {
    if (row.reps > 0) profile.reviewedCards += 1;
    const isDue = row.dueMs <= nowMs;
    if (isDue) profile.dueCards += 1;
    const rowRetrievability = cardRetrievability(row, nowMs);
    if (rowRetrievability !== null) {
      retrievabilitySum += rowRetrievability;
      retrievabilityCount += 1;
    }

    const trimmedTemplate = row.templateId === null ? '' : rustTrim(row.templateId);
    const templateKey = trimmedTemplate === '' ? 'basic' : trimmedTemplate;
    const templateEntry = byTemplate.get(templateKey) ?? { cards: 0, dueCards: 0, totalLapses: 0 };
    templateEntry.cards += 1;
    if (isDue) templateEntry.dueCards += 1;
    templateEntry.totalLapses += Math.max(row.lapses, 0);
    byTemplate.set(templateKey, templateEntry);

    for (const rawTag of row.tags) {
      const tag = rustTrim(rawTag);
      if (tag === '') continue;
      const tagEntry = byTag.get(tag) ?? { cards: 0, totalLapses: 0 };
      tagEntry.cards += 1;
      tagEntry.totalLapses += Math.max(row.lapses, 0);
      byTag.set(tag, tagEntry);
    }
  }

  if (retrievabilityCount > 0) {
    profile.avgRetrievability = retrievabilitySum / retrievabilityCount;
  }

  // 高 lapse / 高 due 模板：只保留有遗忘信号的，按 total_lapses 降序、due 次序打破平局
  const templates: TemplateLapseStat[] = [];
  for (const [templateId, entry] of byTemplate) {
    if (entry.totalLapses <= 0) continue;
    templates.push({
      templateId,
      cards: entry.cards,
      dueCards: entry.dueCards,
      totalLapses: entry.totalLapses,
      avgLapses: entry.totalLapses / Math.max(entry.cards, 1),
    });
  }
  templates.sort(
    (a, b) =>
      b.totalLapses - a.totalLapses ||
      b.dueCards - a.dueCards ||
      compareRustStrings(a.templateId, b.templateId),
  );
  profile.highLapseTemplates = templates.slice(0, cfg.maxTemplates);

  // 易混淆标签：≥2 张卡且平均 lapse ≥ 1 才视为混淆信号
  const tags: TagLapseStat[] = [];
  for (const [tag, entry] of byTag) {
    if (!(entry.cards >= 2 && entry.totalLapses / entry.cards >= 1)) continue;
    tags.push({
      tag,
      cards: entry.cards,
      totalLapses: entry.totalLapses,
      avgLapses: entry.totalLapses / Math.max(entry.cards, 1),
    });
  }
  tags.sort(
    (a, b) => b.totalLapses - a.totalLapses || compareRustStrings(a.tag, b.tag),
  );
  profile.confusableTags = tags.slice(0, cfg.maxTags);

  // 高遗忘卡片示例（rows 已按 lapses 降序，这里再排序一次以不依赖调用方顺序）
  const highLapse = rows
    .filter((row) => row.lapses >= cfg.minLapsesForHint)
    .sort((a, b) => b.lapses - a.lapses || compareRustStrings(a.ankiCardId, b.ankiCardId));
  profile.highLapseCards = highLapse.slice(0, cfg.maxHighLapseCards).map((row) => ({
    ankiCardId: row.ankiCardId,
    frontExcerpt: excerpt(row.front, cfg.frontExcerptChars),
    lapses: row.lapses,
    templateId: row.templateId,
    tags: [...row.tags],
  }));

  return profile;
}

// ============================================================
// 纯函数：section 渲染（含字符预算截断）
// ============================================================

/**
 * Rust `format!("{:.1}")` / `format!("{:.2}")` 的等价实现：十进制定点、恰好 .5 时
 * 舍入到偶数（Rust 浮点格式化规则），而非 JS `toFixed` 的远离零舍入。
 */
function fixed(value: number, digits: number): string {
  const scale = 10 ** digits;
  const negative = value < 0;
  const scaled = Math.abs(value) * scale;
  const floor = Math.floor(scaled);
  const rounded = scaled - floor === 0.5 ? floor + (floor % 2) : Math.round(scaled);
  const text = String(rounded).padStart(digits + 1, '0');
  const body =
    digits === 0
      ? text
      : `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`;
  return negative ? `-${body}` : body;
}

/**
 * 渲染「用户复习画像」section；空画像返回 null。
 *
 * 隐私（0824 收口）：渲染结果会随生成请求发送到所配置的模型端点，
 * 因此不得声称“数据不上传”；高遗忘卡片正面摘要属历史卡片原文，
 * 仅在 `cfg.includeCardExcerpts` 显式开启时渲染。
 */
export function renderProfileSection(
  profile: UserReviewProfile,
  cfg: FsrsFeedbackConfig,
): string | null {
  if (isUserReviewProfileEmpty(profile)) return null;
  let out = '';
  out += '【用户复习画像 · FSRS 统计】\n';
  out +=
    `- 复习库规模：${profile.totalCards} 张已入队，其中 ${profile.reviewedCards} 张已复习，` +
    `${profile.dueCards} 张当前到期\n`;
  if (profile.avgRetrievability !== null) {
    out += `- 平均可提取性（retrievability）：${fixed(profile.avgRetrievability, 2)}\n`;
  }
  if (profile.highLapseTemplates.length > 0) {
    const items = profile.highLapseTemplates.map(
      (t) =>
        `${t.templateId}（${t.cards} 卡 / ${t.totalLapses} 次遗忘 / ${t.dueCards} 张到期，` +
        `平均 ${fixed(t.avgLapses, 1)}）`,
    );
    out += `- 高遗忘模板：${items.join('；')}\n`;
  }
  if (profile.confusableTags.length > 0) {
    const items = profile.confusableTags.map(
      (t) => `${t.tag}（${t.cards} 卡 / ${t.totalLapses} 次遗忘）`,
    );
    out += `- 易混淆标签：${items.join('；')}\n`;
  }
  if (cfg.includeCardExcerpts && profile.highLapseCards.length > 0) {
    out += '- 高遗忘卡片示例：\n';
    for (const card of profile.highLapseCards) {
      out += `  · 「${card.frontExcerpt}」（lapses=${card.lapses}）\n`;
    }
  }
  out +=
    '制卡建议（基于以上画像）：\n' +
    '- 涉及上述易混淆标签/高遗忘模板的知识点，请拆成更小的原子卡（一卡一问）。\n' +
    '- 对高遗忘卡对应的概念，优先生成角度不同的强化卡（举例、反例、应用场景），而非重复原表述。\n';

  // 字符预算截断（多字节安全）
  if (charCount(out) > cfg.maxProfileChars) {
    out = `${takeChars(out, Math.max(cfg.maxProfileChars - 1, 0))}…`;
  }
  return out;
}

// ============================================================
// 纯函数：同批次语义干扰
// ============================================================

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function isAsciiAlphanumeric(ch: string): boolean {
  return /^[A-Za-z0-9]$/.test(ch);
}

/**
 * 从文本提取关键词集合：拉丁词（≥3 字符，小写）+ CJK 连续段的 bigram。
 * 纯词法启发式，不依赖分词器/embedding，保证零外部依赖与确定性。
 */
export function extractKeywords(text: string, max: number): string[] {
  const freq = new Map<string, number>();
  let latin = '';
  let cjkRun: string[] = [];
  const bump = (key: string): void => {
    freq.set(key, (freq.get(key) ?? 0) + 1);
  };
  const flushLatin = (): void => {
    if (latin.length >= 3) bump(latin.toLowerCase());
    latin = '';
  };
  const flushCjk = (): void => {
    if (cjkRun.length >= 2) {
      for (let index = 0; index + 1 < cjkRun.length; index += 1) {
        bump(`${cjkRun[index]!}${cjkRun[index + 1]!}`);
      }
    }
    cjkRun = [];
  };

  for (const ch of text) {
    if (isAsciiAlphanumeric(ch)) {
      flushCjk();
      latin += ch;
    } else if (isCjk(ch)) {
      flushLatin();
      cjkRun.push(ch);
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();

  const keywords = [...freq.entries()];
  keywords.sort((a, b) => b[1] - a[1] || compareRustStrings(a[0], b[0]));
  return keywords.slice(0, max).map(([keyword]) => keyword);
}

/**
 * 对即将生成的材料，从库内高 lapse 卡中挑出语义相近（关键词重叠）的候选。
 * 结果按（重叠分降序，lapses 降序）排序并截断至 `maxInterferenceCards`。
 */
export function buildInterferenceHints(
  rows: readonly FsrsFeedbackRow[],
  documentContent: string,
  cfg: FsrsFeedbackConfig,
): InterferenceHint[] {
  if (rows.length === 0 || rustTrim(documentContent) === '') return [];
  const keywords = new Set(extractKeywords(documentContent, 128));
  if (keywords.size === 0) return [];

  const hints: InterferenceHint[] = [];
  for (const row of rows) {
    if (row.lapses < cfg.minLapsesForHint) continue;
    const frontKeywords = new Set(extractKeywords(row.front, 64));
    let overlap = 0;
    for (const keyword of frontKeywords) {
      if (keywords.has(keyword)) overlap += 1;
    }
    if (overlap === 0) continue;
    hints.push({
      ankiCardId: row.ankiCardId,
      frontExcerpt: excerpt(row.front, cfg.frontExcerptChars),
      lapses: row.lapses,
      overlapScore: overlap,
    });
  }
  hints.sort(
    (a, b) =>
      b.overlapScore - a.overlapScore ||
      b.lapses - a.lapses ||
      compareRustStrings(a.ankiCardId, b.ankiCardId),
  );
  return hints.slice(0, cfg.maxInterferenceCards);
}

/**
 * 渲染「同批次语义干扰预警」section；无候选返回 null。
 * 逐条追加并遵守 `maxInterferenceChars`：超预算即停止追加后续条目。
 *
 * 隐私（0824 收口）：每条条目都是历史卡片正面摘要（卡片原文），
 * 编排入口只在 `cfg.includeCardExcerpts` 显式开启时调用本函数。
 */
export function renderInterferenceSection(
  hints: readonly InterferenceHint[],
  cfg: FsrsFeedbackConfig,
): string | null {
  if (hints.length === 0) return null;
  const header =
    '【同批次语义干扰预警 · 库内已有的高遗忘近义卡】\n' +
    '以下卡片与本次材料主题相近且历史遗忘率高：\n' +
    '- 不要生成与其重复或仅换措辞的卡片；\n' +
    '- 若新内容与其确实相邻易混，请生成「对比卡」：正面同时呈现两个易混概念并要求区分。\n';
  let out = header;
  for (const [index, hint] of hints.entries()) {
    const line = `${index + 1}. 「${hint.frontExcerpt}」（lapses=${hint.lapses}）\n`;
    if (charCount(out) + charCount(line) > cfg.maxInterferenceChars) break;
    out += line;
  }
  return out;
}

// ============================================================
// 纯函数：高 lapse 卡拆分建议
// ============================================================

/**
 * 把一张高 lapse 卡启发式拆成更小的原子卡建议。
 *
 * 启发式（按优先级）：
 * 1. 答案含枚举列表（`1.`/`1、`/`(1)`/`①`/`-`/`·` 等行首标记，或 ≥3 个分号段）
 *    → 每个要点一张卡；
 * 2. 正面是「A 与/和 B 的区别/异同/对比」→ 建议 A、B 各出一张单点卡（对比卡保留原卡）；
 * 3. 答案是 ≥3 句的长段落（>120 字符）→ 拆成「核心结论」+「补充细节」两张卡。
 *
 * 无法拆分（已是原子卡）时返回空数组。结果截断至 `maxSuggestions`。
 */
export function suggestSplits(
  front: string,
  back: string,
  maxSuggestions: number,
): SplitSuggestion[] {
  const trimmedFront = rustTrim(front);
  const trimmedBack = rustTrim(back);
  if (trimmedFront === '' || trimmedBack === '' || maxSuggestions === 0) return [];

  // --- 启发式 1：枚举列表 ---
  const items = splitEnumeratedItems(trimmedBack);
  if (items.length >= 2) {
    const total = items.length;
    return items
      .map((item, index) => ({
        front: `${trimmedFront}（要点 ${index + 1}/${total}）`,
        back: item,
        rationale: `答案含 ${total} 个并列要点，逐点拆分可降低单卡记忆负担`,
      }))
      .slice(0, maxSuggestions);
  }

  // --- 启发式 2：对比型正面 ---
  const comparison = parseComparisonFront(trimmedFront);
  if (comparison !== null) {
    return [
      {
        front: `${comparison.a} 的关键特征是什么？`,
        back: trimmedBack,
        rationale: '对比问句先拆成单概念卡，掌握后再复习原对比卡',
      },
      {
        front: `${comparison.b} 的关键特征是什么？`,
        back: trimmedBack,
        rationale: '对比问句先拆成单概念卡，掌握后再复习原对比卡',
      },
    ].slice(0, maxSuggestions);
  }

  // --- 启发式 3：长多句答案 ---
  const sentences = splitSentences(trimmedBack);
  if (sentences.length >= 3 && charCount(trimmedBack) > 120) {
    const core = sentences[0]!;
    const rest = sentences.slice(1).join('');
    return [
      {
        front: `${trimmedFront}（核心结论）`,
        back: core,
        rationale: '长答案先记核心结论',
      },
      {
        front: `${trimmedFront}（补充细节）`,
        back: rest,
        rationale: '细节独立成卡，避免一次回忆整段',
      },
    ].slice(0, maxSuggestions);
  }

  return [];
}

/** `str::lines()`：按 `\n` 切分、去掉末尾换行后的空段、每行剥掉行尾 `\r`。 */
function rustLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** 拆出答案中的枚举要点；识别行首编号/项目符号与「≥3 段分号列表」。 */
function splitEnumeratedItems(back: string): string[] {
  const bulletItems: string[] = [];
  for (const line of rustLines(back)) {
    const trimmed = rustTrim(line);
    const item = stripEnumerationMarker(trimmed);
    if (item !== null && item !== '') bulletItems.push(item);
  }
  if (bulletItems.length >= 2) return bulletItems;

  // 分号列表（；或 ;），要求 ≥3 段避免误伤普通复句
  const semiItems = back
    .split(/[；;]/)
    .map((item) => rustTrim(item))
    .filter((item) => item !== '');
  if (semiItems.length >= 3) return semiItems;
  return [];
}

const CIRCLED_MARKERS: readonly string[] = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const CIRCLED_SEPARATORS: readonly string[] = ['.', '、', '．', ' '];
const BULLET_MARKERS: readonly string[] = ['-', '*', '•', '·'];
const NUMBER_SEPARATORS: readonly string[] = ['.', '、', '．', ')', '）', '：', ':'];

/** 去除行首枚举标记；不是枚举行返回 null。 */
export function stripEnumerationMarker(line: string): string | null {
  const started = rustTrimStart(line);
  const first = firstCodePoint(started);
  if (first !== null) {
    if (CIRCLED_MARKERS.includes(first.ch)) {
      return trimStartChars(started.slice(first.text.length), CIRCLED_SEPARATORS);
    }
    if (BULLET_MARKERS.includes(first.ch)) {
      const rest = rustTrimStart(started.slice(first.text.length));
      return rest === '' ? null : rest;
    }
  }
  // "1." / "1、" / "1）" / "(1)" 形式
  const unwrapped = started.startsWith('(')
    ? started.slice(1)
    : started.startsWith('（')
      ? started.slice(1)
      : started;
  const digits = /^[0-9]*/.exec(unwrapped)![0];
  if (digits === '') return null;
  const after = unwrapped.slice(digits.length);
  const separator = firstCodePoint(after);
  if (separator === null) return null;
  if (!NUMBER_SEPARATORS.includes(separator.ch)) return null;
  const rest = rustTrimStart(after.slice(separator.text.length));
  return rest === '' ? null : rest;
}

const COMPARISON_MARKERS: readonly string[] = ['的区别', '的异同', '的对比', '有什么区别', '有何区别'];
const COMPARISON_CONJUNCTIONS: readonly string[] = ['与', '和', '跟', ' vs ', ' VS '];

/** 识别「A 与/和 B 的区别/异同/对比」型正面，返回 (A, B)。 */
function parseComparisonFront(front: string): { a: string; b: string } | null {
  const positions = COMPARISON_MARKERS.map((marker) => front.indexOf(marker)).filter(
    (position) => position >= 0,
  );
  if (positions.length === 0) return null;
  const markerPos = Math.min(...positions);
  const head = front.slice(0, markerPos);
  for (const conjunction of COMPARISON_CONJUNCTIONS) {
    const pos = head.indexOf(conjunction);
    if (pos < 0) continue;
    const a = trimStartChars(rustTrim(head.slice(0, pos)), ['「', '"']);
    const b = trimEndChars(rustTrim(head.slice(pos + conjunction.length)), ['」', '"']);
    if (a !== '' && b !== '') return { a, b };
  }
  return null;
}

/** 按中英文句末标点切句（保留标点）。 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (ch === '。' || ch === '！' || ch === '？' || ch === '.' || ch === '!' || ch === '?') {
      if (rustTrim(current) !== '') sentences.push(current);
      current = '';
    }
  }
  if (rustTrim(current) !== '') sentences.push(current);
  return sentences;
}

// ============================================================
// 编排入口（含降级）
// ============================================================

/** 从 FSRS 库构建用户复习画像；任何查询失败降级为空画像（绝不报错）。 */
/** 插件入口注入的日志端口（Rust `tracing::warn`）。 */
let configuredLogger: AnkiLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 插件入口在加载时调用：把反馈降级告警接到宿主日志。 */
export function configureFsrsFeedbackLogger(logger: AnkiLogger): void {
  configuredLogger = logger;
}

export function buildUserReviewProfile(db: SqlExecutor, cfg: FsrsFeedbackConfig): UserReviewProfile {
  const nowMs = Date.now();
  try {
    return buildProfile(listFeedbackRows(db, cfg.scanLimit), nowMs, cfg);
  } catch (error) {
    configuredLogger.warn(`FSRS 反馈回流查询失败，降级为空画像: ${(error as Error).message}`);
    return emptyUserReviewProfile(nowMs);
  }
}

/**
 * 制卡生成前的唯一编排入口：查询 → 画像 + 干扰预警 → 渲染合并。
 *
 * 返回 `null` 表示无可注入内容（空库 / 查询失败 / 无信号），调用方直接跳过注入。
 */
export function buildFeedbackInjection(
  db: SqlExecutor,
  documentContent: string,
  cfg: FsrsFeedbackConfig,
): string | null {
  let rows: FsrsFeedbackRow[];
  try {
    rows = listFeedbackRows(db, cfg.scanLimit);
  } catch (error) {
    configuredLogger.warn(`FSRS 反馈回流查询失败，本次制卡不注入复习画像: ${(error as Error).message}`);
    return null;
  }
  if (rows.length === 0) return null;
  const nowMs = Date.now();
  const profile = buildProfile(rows, nowMs, cfg);

  const sections: string[] = [];
  const profileSection = renderProfileSection(profile, cfg);
  if (profileSection !== null) sections.push(profileSection);
  // 干扰预警条目全部是历史卡片正面摘要（卡片原文），默认不外送；
  // 仅在调用方显式开启 includeCardExcerpts 时构建并注入。
  if (cfg.includeCardExcerpts) {
    const hints = buildInterferenceHints(rows, documentContent, cfg);
    const interferenceSection = renderInterferenceSection(hints, cfg);
    if (interferenceSection !== null) sections.push(interferenceSection);
  }
  return sections.length === 0 ? null : sections.join('\n');
}
