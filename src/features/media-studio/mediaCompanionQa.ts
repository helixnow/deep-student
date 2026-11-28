/**
 * 音视频学习页伴读问答核心链路：
 * 1) 结合当前播放时间点、章节大纲与全课字幕关键词检索，组装带 [mm:ss] 锚点的上下文；
 * 2) 调用后端真实对话模型（handout_llm_complete → L02 model2 + failover + usage）生成针对性回答；
 * 3) 解析回答中的时间戳引用为可点击的 ▶ mm:ss 跳转令牌；
 * 4) 仅在未配置 AI 模型 / API Key 时展示明确的未配置提示与相关字幕定位（附设置直达入口），
 *    绝不将原始字幕复读伪装成 AI 回答，也不催促已配置用户「迁入主会话」。
 */
import { invoke } from '@tauri-apps/api/core';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { getErrorMessage } from '@/utils/errorUtils';

export interface CompanionTranscriptSegment {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  status: string;
}

export interface CompanionChapter {
  seconds: number;
  title: string;
}

export interface CompanionQaTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompanionQaCitation {
  seconds: number;
  label: string;
  excerpt?: string;
}

export interface CompanionQaContextInput {
  resourceId: string;
  courseName: string;
  hasTranscript: boolean;
  segments: readonly CompanionTranscriptSegment[];
  chapters: readonly CompanionChapter[];
  currentTimeSeconds?: number;
}

export type CompanionQaResult =
  | {
      kind: 'answer';
      content: string;
      citations: CompanionQaCitation[];
      hasInlineCitations: boolean;
    }
  | {
      kind: 'unconfigured';
      notice: string;
      citations: CompanionQaCitation[];
      reason?: string;
    }
  | {
      kind: 'error';
      message: string;
      retryable: boolean;
      suggestSettings: boolean;
    }
  | {
      kind: 'cancelled';
    };

export type CompanionQaTextToken =
  | { kind: 'text'; value: string }
  | { kind: 'citation'; seconds: number; label: string; raw: string };

/** 播放位置附近默认回看与前瞻半径（秒） */
export const COMPANION_QA_PLAYHEAD_LOOKBACK_SECONDS = 60;
export const COMPANION_QA_PLAYHEAD_LOOKAHEAD_SECONDS = 45;
/** 短课全量字幕直接注入字符上限（覆盖大多数 10-20 分钟课程，避免遗漏上下文） */
const FULL_TRANSCRIPT_CHAR_BUDGET = 8_000;
/** 长课组合上下文字符上限（远低于 handout_llm_complete 的 120,000 上限） */
const MAX_GROUNDED_TRANSCRIPT_CHARS = 10_000;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_TURN_CHARS = 500;

const CJK_STOP_WORDS = new Set([
  '什么', '怎么', '如何', '为什么', '为何', '请问', '一下', '这个', '那个', '这里',
  '那里', '这段', '刚才', '当前', '现在', '课程', '视频', '音频', '老师', '讲解',
  '讲了', '讲的', '主要', '内容', '问题', '可以', '能够', '需要', '应该', '是否',
  '有没有', '解释', '说明', '总结', '概括', '梳理', '帮我', '请帮', '结合', '上下文',
  '段落', '位置', '核心', '概念', '逻辑', '脉络', '一步', '一下', '什么意思',
]);

const LATIN_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'why', 'how', 'when',
  'where', 'which', 'who', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had',
  'does', 'did', 'can', 'could', 'would', 'should', 'will', 'about', 'into', 'explain',
  'please', 'current', 'video', 'audio', 'lecture', 'section', 'paragraph',
]);

/** 秒 → `mm:ss`（≥ 1 小时为 `h:mm:ss`），向下取整到秒 */
export function formatCompanionTimestamp(totalSeconds: number): string {
  const sec = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `mm:ss` / `h:mm:ss` → 秒；不合法时返回 null */
export function parseCompanionTimestamp(raw: string): number | null {
  const trimmed = raw.trim().replace(/^[【(（▶\s[]+|[\]】)）\s]+$/g, '').trim();
  if (!/^\d{1,3}(?::\d{1,3}){1,2}$/.test(trimmed)) return null;
  const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const secs = parts[parts.length - 1];
  if (secs >= 60) return null;
  if (parts.length === 3) {
    if (parts[1] >= 60) return null;
    return parts[0] * 3600 + parts[1] * 60 + secs;
  }
  return parts[0] * 60 + secs;
}

function findActiveChapter(
  chapters: readonly CompanionChapter[],
  seconds: number,
): CompanionChapter | null {
  let active: CompanionChapter | null = null;
  for (const ch of chapters) {
    if (ch.seconds <= seconds) active = ch;
    else break;
  }
  return active;
}

function extractQueryTerms(question: string): string[] {
  const cleaned = question
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[媒体@[^\]]+\]/g, ' ')
    .trim();
  if (!cleaned) return [];

  const terms = new Set<string>();

  // 英文 / 数字词元
  const latinMatches = cleaned.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  for (const word of latinMatches) {
    if (!LATIN_STOP_WORDS.has(word)) terms.add(word);
  }

  // 中文连续片段：保留 2-4 字词组 + 滑动二元组，兼顾专有名词与短问句
  const cjkRuns = cleaned.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length <= 6 && !CJK_STOP_WORDS.has(run)) {
      terms.add(run);
    }
    for (let i = 0; i <= run.length - 2; i += 1) {
      const bi = run.slice(i, i + 2);
      if (!CJK_STOP_WORDS.has(bi)) terms.add(bi);
    }
    for (let i = 0; i <= run.length - 3; i += 1) {
      const tri = run.slice(i, i + 3);
      if (!CJK_STOP_WORDS.has(tri)) terms.add(tri);
    }
  }

  return Array.from(terms).slice(0, 40);
}

function resolvePlayheadSeconds(currentTimeSeconds: number | undefined): number | null {
  return typeof currentTimeSeconds === 'number' && Number.isFinite(currentTimeSeconds)
    ? Math.max(0, Math.floor(currentTimeSeconds))
    : null;
}

function scoreSegmentRelevance(
  seg: CompanionTranscriptSegment,
  terms: readonly string[],
  playheadMs: number | null,
): number {
  const textLower = seg.text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (textLower.includes(term)) {
      score += term.length >= 3 ? 3 : 1.5;
    }
  }
  // 距离播放位置越近给予轻微加权，同分时优先当前上下文
  if (playheadMs !== null) {
    const distSec = Math.min(Math.abs(seg.startMs - playheadMs), Math.abs(seg.endMs - playheadMs)) / 1000;
    if (distSec <= 60) score += 0.6;
    else if (distSec <= 180) score += 0.25;
  }
  return score;
}

function formatSegmentLine(seg: CompanionTranscriptSegment): string {
  return `[${formatCompanionTimestamp(Math.floor(seg.startMs / 1000))}] ${seg.text.trim()}`;
}

export interface SelectedTranscriptContext {
  /** 是否包含全课完整转写 */
  isFullTranscript: boolean;
  /** 注入给 LLM 的带时间戳字幕段（按时间排序去重） */
  groundedSegments: CompanionTranscriptSegment[];
  /** 离播放位置最近的窗口字幕 */
  nearbySegments: CompanionTranscriptSegment[];
  /** 用于未配置 AI 模型降级或兜底引用的最相关 3-5 条片段 */
  fallbackCitations: CompanionQaCitation[];
  /** 当前播放时刻对应章节 */
  activeChapter: CompanionChapter | null;
}

/**
 * 结合播放时间窗 + 全课关键词匹配挑选最相关的字幕片段，保证：
 * - 短课（≤ 8000 字）完整提供全课字幕，防止跨时间点提问漏信息；
 * - 长课优先保留当前播放位置附近字幕，并补充全课关键词命中的相关片段。
 */
export function selectRelevantTranscriptContext(
  ctx: CompanionQaContextInput,
  question: string,
): SelectedTranscriptContext {
  const nowSeconds = resolvePlayheadSeconds(ctx.currentTimeSeconds);
  const playheadMs = nowSeconds !== null ? nowSeconds * 1000 : null;
  const activeChapter = nowSeconds !== null ? findActiveChapter(ctx.chapters, nowSeconds) : null;
  const doneSegments = ctx.segments
    .filter((seg) => seg.status === 'done' && seg.text.trim().length > 0)
    .sort((a, b) => a.startMs - b.startMs);

  if (!ctx.hasTranscript || doneSegments.length === 0) {
    return {
      isFullTranscript: false,
      groundedSegments: [],
      nearbySegments: [],
      fallbackCitations: [],
      activeChapter,
    };
  }

  const fromMs = nowSeconds !== null ? Math.max(0, nowSeconds - COMPANION_QA_PLAYHEAD_LOOKBACK_SECONDS) * 1000 : 0;
  const toMs = nowSeconds !== null ? (nowSeconds + COMPANION_QA_PLAYHEAD_LOOKAHEAD_SECONDS) * 1000 + 1 : 0;
  const nearbySegments =
    nowSeconds !== null
      ? doneSegments.filter((seg) => seg.endMs > fromMs && seg.startMs < toMs)
      : [];

  const terms = extractQueryTerms(question);
  const scored = doneSegments
    .map((seg, index) => ({
      seg,
      index,
      score: scoreSegmentRelevance(seg, terms, playheadMs),
    }))
    .sort((a, b) => b.score - a.score || a.seg.startMs - b.seg.startMs);

  const lexicalMatches = scored.filter((item) => item.score >= 1.5);

  // 未配置模型时的高相关字幕定位（优先关键词命中，其次当前播放窗口，最后全课最近片段）
  const fallbackPool: CompanionTranscriptSegment[] = [];
  const seenFallback = new Set<number>();
  const pushFallback = (seg: CompanionTranscriptSegment) => {
    if (seenFallback.has(seg.idx)) return;
    seenFallback.add(seg.idx);
    fallbackPool.push(seg);
  };
  for (const hit of lexicalMatches.slice(0, 4)) pushFallback(hit.seg);
  for (const seg of nearbySegments.slice(0, 4)) {
    if (fallbackPool.length >= 4) break;
    pushFallback(seg);
  }
  if (fallbackPool.length === 0) {
    const nearest =
      playheadMs !== null
        ? [...doneSegments]
            .sort((a, b) => {
              const distA = Math.min(Math.abs(a.startMs - playheadMs), Math.abs(a.endMs - playheadMs));
              const distB = Math.min(Math.abs(b.startMs - playheadMs), Math.abs(b.endMs - playheadMs));
              return distA - distB;
            })
            .slice(0, 3)
        : doneSegments.slice(0, 3);
    for (const seg of nearest) pushFallback(seg);
  }
  fallbackPool.sort((a, b) => a.startMs - b.startMs);
  const fallbackCitations: CompanionQaCitation[] = fallbackPool.map((seg) => {
    const seconds = Math.floor(seg.startMs / 1000);
    return {
      seconds,
      label: formatCompanionTimestamp(seconds),
      excerpt: seg.text.trim(),
    };
  });

  // 判断全课字幕是否能直接完整放入预算
  const totalChars = doneSegments.reduce((sum, seg) => sum + seg.text.trim().length + 12, 0);
  if (totalChars <= FULL_TRANSCRIPT_CHAR_BUDGET) {
    return {
      isFullTranscript: true,
      groundedSegments: doneSegments,
      nearbySegments,
      fallbackCitations,
      activeChapter,
    };
  }

  // 长课：组合播放窗口 + 关键词命中（含前后邻接段）+ 预算裁剪
  const chosenIndices = new Set<number>();
  let charBudget = MAX_GROUNDED_TRANSCRIPT_CHARS;
  const tryAddIndex = (index: number): boolean => {
    if (index < 0 || index >= doneSegments.length || chosenIndices.has(index)) return false;
    const cost = doneSegments[index].text.trim().length + 12;
    if (charBudget - cost < 0 && chosenIndices.size > 0) return false;
    chosenIndices.add(index);
    charBudget -= cost;
    return true;
  };

  // 1) 当前播放窗口内片段（按离 playhead 近到远优先纳入）
  if (playheadMs !== null) {
    const nearbyWithIndex = doneSegments
      .map((seg, index) => ({ seg, index }))
      .filter(({ seg }) => seg.endMs > fromMs && seg.startMs < toMs)
      .sort((a, b) => Math.abs(a.seg.startMs - playheadMs) - Math.abs(b.seg.startMs - playheadMs));
    for (const { index } of nearbyWithIndex) {
      tryAddIndex(index);
    }
  }

  // 2) 全课高相关命中片段及其前后各 1 段上下文
  for (const hit of lexicalMatches.slice(0, 12)) {
    tryAddIndex(hit.index);
    tryAddIndex(hit.index - 1);
    tryAddIndex(hit.index + 1);
  }

  // 3) 若窗口与关键词都为空，从最近位置向两侧扩展
  if (chosenIndices.size === 0) {
    if (playheadMs !== null) {
      const byDist = doneSegments
        .map((seg, index) => ({
          index,
          dist: Math.min(Math.abs(seg.startMs - playheadMs), Math.abs(seg.endMs - playheadMs)),
        }))
        .sort((a, b) => a.dist - b.dist);
      for (const { index } of byDist.slice(0, 12)) {
        tryAddIndex(index);
      }
    } else {
      for (let index = 0; index < Math.min(12, doneSegments.length); index += 1) {
        tryAddIndex(index);
      }
    }
  }

  const groundedSegments = Array.from(chosenIndices)
    .sort((a, b) => a - b)
    .map((index) => doneSegments[index]);

  return {
    isFullTranscript: false,
    groundedSegments,
    nearbySegments,
    fallbackCitations,
    activeChapter,
  };
}

/** 构造发送给后端对话模型的完整伴读问答 Prompt */
export function buildCompanionQaPrompt(params: {
  ctx: CompanionQaContextInput;
  question: string;
  selection: SelectedTranscriptContext;
  history?: readonly CompanionQaTurn[];
  presetId?: string;
}): string {
  const { ctx, question, selection, history = [], presetId } = params;
  const nowSeconds = resolvePlayheadSeconds(ctx.currentTimeSeconds);

  const lines: string[] = [
    '你是正在音视频学习页陪伴学生听课的 AI 学习助教。请根据课程信息与带时间戳的字幕片段，直接、准确、有条理地回答学生的问题。',
    '',
    '回答要求：',
    '1. 直接回答用户的具体问题，用清晰易懂的讲解、要点或推导帮助理解；不要只是简单复读或照抄字幕原文，也不要催促用户切换或迁入主会话。',
    '2. 凡是引用课程中的定义、结论、公式、案例或原话依据，请在相应句子后用 [mm:ss]（或 [h:mm:ss]）标注准确的时间戳（例如 [01:35]），方便学生一键跳回对应视频位置。不得编造未出现在字幕中的时间戳。',
    '3. 若字幕片段仅覆盖部分内容，先基于课程原话说明已讲部分（附 [mm:ss]），再自然补充必要的学科原理解释或举例。',
    '4. 表达简洁凝练、层次清楚，适合在伴读侧边小窗快速阅读。',
    '',
    '【课程上下文】',
    `- 课程名称：《${ctx.courseName}》`,
  ];

  if (nowSeconds !== null) {
    lines.push(`- 当前播放位置：[${formatCompanionTimestamp(nowSeconds)}]`);
  }

  if (selection.activeChapter) {
    lines.push(
      `- 当前章节：[${formatCompanionTimestamp(selection.activeChapter.seconds)}] ${selection.activeChapter.title}`,
    );
  }

  if (ctx.chapters.length > 0) {
    lines.push('- 课程章节目录：');
    for (const ch of ctx.chapters.slice(0, 20)) {
      lines.push(`  - [${formatCompanionTimestamp(ch.seconds)}] ${ch.title}`);
    }
  }

  if (selection.groundedSegments.length > 0) {
    lines.push(
      '',
      selection.isFullTranscript
        ? '【课程字幕全文（带时间戳）】'
        : '【与当前位置及提问最相关的课程字幕片段（带时间戳）】',
    );
    for (const seg of selection.groundedSegments) {
      lines.push(formatSegmentLine(seg));
    }
  } else {
    lines.push(
      '',
      '【字幕状态】',
      '当前课程暂未完成字幕转写。请先结合课程名称、当前章节与学科知识直接回答用户问题，并在末尾简短提示：在「字幕」分区完成转写或导入字幕后，可获得基于课程原话的精准时间戳定位。',
    );
  }

  const recentTurns = history
    .filter((turn) => turn.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS);
  if (recentTurns.length > 0) {
    lines.push('', '【最近伴读对话记录】');
    for (const turn of recentTurns) {
      const roleLabel = turn.role === 'user' ? '学生' : '助教';
      const clipped =
        turn.content.trim().length > MAX_HISTORY_TURN_CHARS
          ? `${turn.content.trim().slice(0, MAX_HISTORY_TURN_CHARS)}…`
          : turn.content.trim();
      lines.push(`${roleLabel}：${clipped}`);
    }
  }

  if (presetId === 'explain_paragraph') {
    lines.push('', '【回答侧重】学生希望通俗直观地理解当前时间点正在讲解的核心概念与逻辑关系。');
  } else if (presetId === 'derive_formula') {
    lines.push('', '【回答侧重】学生希望看到当前讲解内容的分步推导脉络、前提假设与关键变形依据。');
  } else if (presetId === 'generate_variant') {
    lines.push('', '【回答侧重】学生希望围绕当前知识点获得一道高质量的变式自测题及简明解析。');
  }

  lines.push('', '【学生当前提问】', question.trim());

  return lines.join('\n');
}

// 匹配文本中的时间引用：
// 1) [媒体@file_xxx:01:35]
// 2) [01:35] / 【01:35】 / [01:35-01:50] / [01:35–01:50]
// 3) ▶ 01:35 / ▶01:35
// 4) (01:35) / （01:35）
const TIMESTAMP_TOKEN_RE =
  /\[媒体@[^\s:\]]+:(\d{1,3}:\d{2}(?::\d{2})?)\]|[【[](\d{1,3}:\d{2}(?::\d{2})?)(?:\s*[-–—~]\s*(\d{1,3}:\d{2}(?::\d{2})?))?[\]】]|▶\s*(\d{1,3}:\d{2}(?::\d{2})?)|[(（](\d{1,3}:\d{2}(?::\d{2})?)[)）]/g;

/** 将 AI 回答文本拆分为普通文本与可点击的时间戳引用令牌 */
export function tokenizeTimestampText(text: string): CompanionQaTextToken[] {
  const tokens: CompanionQaTextToken[] = [];
  if (!text) return tokens;

  const re = new RegExp(TIMESTAMP_TOKEN_RE.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const startTimeStr = match[1] ?? match[2] ?? match[4] ?? match[5];
    const endTimeStr = match[3];
    const startSeconds = startTimeStr ? parseCompanionTimestamp(startTimeStr) : null;
    if (startSeconds === null) continue;

    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }

    tokens.push({
      kind: 'citation',
      seconds: startSeconds,
      label: formatCompanionTimestamp(startSeconds),
      raw,
    });

    if (endTimeStr) {
      const endSeconds = parseCompanionTimestamp(endTimeStr);
      if (endSeconds !== null && endSeconds !== startSeconds) {
        tokens.push({ kind: 'text', value: '–' });
        tokens.push({
          kind: 'citation',
          seconds: endSeconds,
          label: formatCompanionTimestamp(endSeconds),
          raw: endTimeStr,
        });
      }
    }

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', value: text.slice(lastIndex) });
  }

  return tokens;
}

/** 从回答文本中提取去重后的时间引用列表 */
export function extractCitationsFromText(text: string): CompanionQaCitation[] {
  const tokens = tokenizeTimestampText(text);
  const seen = new Set<number>();
  const citations: CompanionQaCitation[] = [];
  for (const token of tokens) {
    if (token.kind !== 'citation' || seen.has(token.seconds)) continue;
    seen.add(token.seconds);
    citations.push({ seconds: token.seconds, label: token.label });
  }
  return citations;
}

function getStructuredErrorType(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const obj = error as Record<string, unknown>;
  if (typeof obj.error_type === 'string') return obj.error_type;
  if (typeof obj.errorType === 'string') return obj.errorType;
  if (obj.cause && typeof obj.cause === 'object') {
    return getStructuredErrorType(obj.cause);
  }
  return null;
}

export function isCompanionQaCancelledError(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return msg === 'cancelled' || msg.includes('cancelled') || msg.includes('canceled') || msg.includes('已取消');
}

export function isLlmAuthError(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('api认证失败') ||
    msg.includes('认证失败') ||
    msg.includes('密钥无效')
  );
}

/**
 * 识别「未配置 AI 模型 / 未填写 API Key」配置错误，
 * 与网络超时 / 5xx / 限流等运行期错误严格区分。
 */
export function isLlmUnconfiguredError(error: unknown): boolean {
  if (isLlmAuthError(error)) return false;
  const errorType = getStructuredErrorType(error);
  const msg = getErrorMessage(error);
  const lower = msg.toLowerCase();

  if (errorType === 'Configuration') {
    return true;
  }

  return (
    msg.includes('对话模型未配置') ||
    msg.includes('找不到已启用的有效对话模型配置') ||
    msg.includes('没有可用的模型候选') ||
    msg.includes('API 密钥未配置') ||
    msg.includes('未配置 API') ||
    msg.includes('未配置模型') ||
    msg.includes('尚未配置 API') ||
    msg.includes('讲义模型调用服务未提供') ||
    /模型配置\s+\S+\s+已禁用/.test(msg) ||
    lower.includes('no api key') ||
    lower.includes('api key not configured') ||
    lower.includes('api key is missing') ||
    lower.includes('missing api key') ||
    lower.includes('model not configured') ||
    lower.includes('no model configured') ||
    lower.includes('unconfigured')
  );
}

/** 直达「设置 → API / 模型配置」页签 */
export function openMediaAiModelSettings(tab: 'apis' | 'models' = 'apis'): void {
  setPendingSettingsRoute({ tab });
  useSettingsShellStore.getState().applySettingsRoute({ tab });
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });
  dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab });
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'settings' });
}

export async function cancelCompanionQaRequest(requestId: string): Promise<void> {
  if (!requestId) return;
  await invoke('handout_cancel', { requestId }).catch(() => undefined);
}

/**
 * 执行一次真实的伴读 AI 问答：
 * - 组装带课程字幕时间戳锚点的 Prompt；
 * - 调用后端 `handout_llm_complete`（走用户配置的对话模型与 failover）；
 * - 返回结构化回答或显式的未配置 / 错误状态。
 */
export async function askMediaCompanionQa(params: {
  ctx: CompanionQaContextInput;
  question: string;
  history?: readonly CompanionQaTurn[];
  presetId?: string;
  requestId?: string;
}): Promise<CompanionQaResult> {
  const trimmedQuestion = params.question.trim();
  const selection = selectRelevantTranscriptContext(params.ctx, trimmedQuestion);
  const prompt = buildCompanionQaPrompt({
    ctx: params.ctx,
    question: trimmedQuestion,
    selection,
    history: params.history,
    presetId: params.presetId,
  });

  const requestId =
    params.requestId ??
    `media-qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  try {
    const rawReply = await invoke<string>('handout_llm_complete', {
      prompt,
      jsonMode: false,
      requestId,
    });
    const content = typeof rawReply === 'string' ? rawReply.trim() : '';
    if (!content) {
      return {
        kind: 'error',
        message: 'AI 模型返回了空响应，请点击重试。',
        retryable: true,
        suggestSettings: false,
      };
    }

    const inlineCitations = extractCitationsFromText(content);
    return {
      kind: 'answer',
      content,
      hasInlineCitations: inlineCitations.length > 0,
      citations:
        inlineCitations.length > 0
          ? inlineCitations
          : selection.fallbackCitations.slice(0, 3),
    };
  } catch (error: unknown) {
    if (isCompanionQaCancelledError(error)) {
      return { kind: 'cancelled' };
    }
    if (isLlmUnconfiguredError(error)) {
      return {
        kind: 'unconfigured',
        notice:
          selection.fallbackCitations.length > 0
            ? '未配置 AI 模型，已为您定位相关字幕片段'
            : '未配置 AI 模型，请先前往设置配置模型与 API 密钥',
        citations: selection.fallbackCitations,
        reason: getErrorMessage(error),
      };
    }
    const suggestSettings = isLlmAuthError(error);
    const detail = getErrorMessage(error).trim();
    return {
      kind: 'error',
      message: detail || 'AI 伴读请求失败，请检查网络连接或模型配置后重试。',
      retryable: true,
      suggestSettings,
    };
  } finally {
    await invoke('handout_release', { requestId }).catch(() => undefined);
  }
}
