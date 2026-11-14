/**
 * 作文批改管线（移植 `dstu-tutor/src/essay_grading/pipeline.rs` 的纯函数与
 * 无 IO 的状态机部分：prompt 构造、评分解析、注入过滤、图片校验、阶段探测、
 * 错误分类与流会话互斥）。
 *
 * 流式 LLM 调用本身不在此移植：TS 侧以 `EssayStreamTransport` 窄接口注入，
 * 由调用方（service 层）提供具体实现。
 */
import { AppErrorType } from '../../../../platform/errors/api.ts';
import { decodeBase64Standard, statusLine } from '../../../../platform/util/portable.ts';
import type { JsonValue } from '../../../../platform/errors/api.ts';
import {
  canonicalModeId, getBuiltinGradingModes, getDefaultGradingMode,
} from './types.ts';
import type { DimensionScore, GradingMode, ParsedScore, GradeCode, GradingRequest } from './types.ts';
import {
  LATEX_OUTPUT_BRIEF, MARKER_INSTRUCTIONS, MODEL_ESSAY_INSTRUCTIONS,
  SCORE_FORMAT_INSTRUCTIONS, SECTION_INSTRUCTIONS,
} from './prompts.ts';
import { buildStatsPromptBlock, calculateTextStats } from './text_stats.ts';
import { f32Json, f32Sum } from './f32.ts';

export const MAX_INPUT_CHARS = 50_000;
export const MAX_PREVIOUS_RESULT_CHARS = 8_000;
export const MAX_IMAGES_PER_KIND = 6;
export const MAX_IMAGE_DECODED_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_DECODED_BYTES = 100 * 1024 * 1024;

/** 批改链路的结构化错误（对应 Rust `AppError`，可安全跨 IPC 传递）。 */
export class EssayGradingError extends Error {
  readonly errorType: AppErrorType;
  readonly details: JsonValue;

  constructor(errorType: AppErrorType, message: string, details: JsonValue = null) {
    super(message);
    this.name = 'EssayGradingError';
    this.errorType = errorType;
    this.details = details;
  }
}

/** 从结构化错误的 details 中读取 retryable 标记（分类错误专用） */
export function errorIsRetryable(error: EssayGradingError): boolean {
  const details = error.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return false;
  return details['retryable'] === true;
}

/**
 * 分类 HTTP 非 2xx 响应为结构化错误。
 *
 * 消息保持历史前缀「批改 API 返回错误 {status}: ...」（前端正则依赖状态码文本），
 * details 附加 category/retryable 供前端与 error 事件消费。
 */
export function classifyLlmHttpError(status: number, body: string): EssayGradingError {
  const lower = body.toLowerCase();
  const isContentFilter = lower.includes('content_filter')
    || lower.includes('content filter')
    || lower.includes('content management policy')
    || lower.includes('content policy')
    || lower.includes('data_inspection_failed')
    || body.includes('敏感内容')
    || body.includes('内容安全');
  const [category, retryable] = classifyHttpStatus(status, isContentFilter);
  const bodySnippet = Array.from(body).slice(0, 600).join('');
  return new EssayGradingError(
    AppErrorType.LLM,
    `批改 API 返回错误 ${statusLine(status)}: ${bodySnippet}`,
    {
      code: 'ESSAY_LLM_HTTP_ERROR',
      category,
      http_status: status,
      retryable,
    },
  );
}

function classifyHttpStatus(status: number, isContentFilter: boolean): [string, boolean] {
  if (status === 401 || status === 403) return ['auth', false];
  if (status === 408) return ['timeout', true];
  if (status === 429) return ['rate_limit', true];
  if ((status === 400 || status === 422) && isContentFilter) return ['content_filter', false];
  if (status >= 500 && status <= 599) return ['server', true];
  if (isContentFilter) return ['content_filter', false];
  return ['api', false];
}

// ============================================================================
// 流会话互斥
// ============================================================================

const ACTIVE_STREAM_SESSIONS = new Set<string>();

/**
 * 流会话占用守卫：acquire 成功后独占该 stream_session_id，release 时释放。
 */
export class StreamSessionGuard {
  private readonly streamSessionId: string;
  private released = false;

  private constructor(streamSessionId: string) {
    this.streamSessionId = streamSessionId;
  }

  static acquire(streamSessionId: string): StreamSessionGuard | null {
    if (ACTIVE_STREAM_SESSIONS.has(streamSessionId)) return null;
    ACTIVE_STREAM_SESSIONS.add(streamSessionId);
    return new StreamSessionGuard(streamSessionId);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    ACTIVE_STREAM_SESSIONS.delete(this.streamSessionId);
  }
}

// ============================================================================
// 阶段探测
// ============================================================================

/** 批改阶段（progress 事件的 stage 代码，只允许前进） */
// 常量对象 + 同名类型代替 enum：Host 以 Node 类型擦除运行，不支持 enum。数值与 Rust 枚举判别值一致。
export const GradingStage = {
  Preparing: 0,
  Annotating: 1,
  Polishing: 2,
  ModelEssay: 3,
  Scoring: 4,
  Saving: 5,
} as const;
export type GradingStage = (typeof GradingStage)[keyof typeof GradingStage];

export function gradingStageCode(stage: GradingStage): string {
  switch (stage) {
    case GradingStage.Preparing: return 'preparing';
    case GradingStage.Annotating: return 'annotating';
    case GradingStage.Polishing: return 'polishing';
    case GradingStage.ModelEssay: return 'model_essay';
    case GradingStage.Scoring: return 'scoring';
    case GradingStage.Saving: return 'saving';
  }
}

/**
 * 阶段探测器：根据流式输出中的结构标记推进阶段。
 * 保留上一块尾部若干字符做拼接窗口，处理标记跨 chunk 边界的情况。
 */
export class StageTracker {
  /** 拼接窗口保留的尾部字符数（须覆盖最长探测标记 `<section-model-essay>`） */
  static readonly TAIL_KEEP_CHARS = 24;

  private current: GradingStage = GradingStage.Preparing;
  private tail = '';

  private bump(stage: GradingStage, advanced: GradingStage[]): void {
    if (this.current < stage) {
      this.current = stage;
      advanced.push(stage);
    }
  }

  /** 消费一个新 chunk，返回本次前进到的新阶段（按序，可能多个） */
  advance(chunk: string): GradingStage[] {
    const window = this.tail + chunk;
    const advanced: GradingStage[] = [];
    if (chunk.trim().length > 0) {
      this.bump(GradingStage.Annotating, advanced);
    }
    if (window.includes('<section-polish>')) {
      this.bump(GradingStage.Polishing, advanced);
    }
    if (window.includes('<section-model-essay>')) {
      this.bump(GradingStage.ModelEssay, advanced);
    }
    if (window.includes('<score')) {
      this.bump(GradingStage.Scoring, advanced);
    }

    const windowChars = Array.from(window);
    this.tail = windowChars.length > StageTracker.TAIL_KEEP_CHARS
      ? windowChars.slice(windowChars.length - StageTracker.TAIL_KEEP_CHARS).join('')
      : window;
    return advanced;
  }
}

// ============================================================================
// 模式解析
// ============================================================================

/**
 * 解析批阅模式，不静默改写调用方指定的 rubric。
 *
 * `null` 表示使用默认模式；一旦显式给出 ID，缺失的自定义/预置模式
 * 就是 Validation 错误，而不是回退到默认 rubric。
 */
export function resolveGradingMode(
  modeId: string | null,
  customModes: GradingMode[],
): GradingMode {
  if (modeId === null) return getDefaultGradingMode();

  const canonicalId = canonicalModeId(modeId);
  const custom = customModes.find((mode) => mode.id === canonicalId);
  if (custom !== undefined) return custom;
  const builtin = getBuiltinGradingModes().find((mode) => mode.id === canonicalId);
  if (builtin !== undefined) return builtin;

  const requestedId = modeId.trim();
  const zhCn = `批阅模式不存在：${requestedId}。请先查询可用模式后重试。`;
  const enUs = `Grading mode '${requestedId}' does not exist. List the available modes and retry.`;
  throw new EssayGradingError(
    AppErrorType.Validation,
    `${zhCn} / ${enUs}`,
    {
      code: 'ESSAY_MODE_NOT_FOUND',
      field: 'mode_id',
      mode_id: modeId,
      canonical_mode_id: canonicalId,
      retryable: false,
      messageKey: 'chat.tools.essay.errors.modeNotFound',
      messageParams: { modeId: requestedId },
      messageFallback: { 'zh-CN': zhCn, 'en-US': enUs },
    },
  );
}

// ============================================================================
// 属性 / 评分解析
// ============================================================================

/** 从标签属性串中按名字提取属性值（与书写顺序无关，容忍未知属性） */
export function extractAttr(attrs: string, name: string): string | null {
  const regex = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrs)) !== null) {
    if (match[1] === name) return decodeXmlEntities(match[2] as string);
  }
  return null;
}

function entityToChar(entity: string): string | null {
  switch (entity) {
    case 'amp': return '&';
    case 'lt': return '<';
    case 'gt': return '>';
    case 'quot': return '"';
    case 'apos': return "'";
    default: break;
  }
  let codePoint: number | null = null;
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const hex = entity.slice(2);
    if (/^[0-9A-Fa-f]+$/.test(hex)) codePoint = Number.parseInt(hex, 16);
  } else if (entity.startsWith('#')) {
    const dec = entity.slice(1);
    if (/^[0-9]+$/.test(dec)) codePoint = Number.parseInt(dec, 10);
  }
  if (codePoint === null || !Number.isFinite(codePoint) || codePoint > 0x10ffff) return null;
  return String.fromCodePoint(codePoint);
}

/**
 * 解码属性值里的 XML 实体：模型按 XML 写属性时会把 & 写成 &amp;
 * （如雅思维度 `Grammatical Range &amp; Accuracy`）。只认标准命名实体与数字实体，
 * 其余 `&` 保持原样。
 */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  let out = '';
  let rest = value;
  for (;;) {
    const pos = rest.indexOf('&');
    if (pos < 0) break;
    out += rest.slice(0, pos);
    const tail = rest.slice(pos);
    const rawEnd = tail.indexOf(';');
    const ch = rawEnd >= 0 && rawEnd <= 10 ? entityToChar(tail.slice(1, rawEnd)) : null;
    if (ch !== null) {
      out += ch;
      rest = tail.slice(rawEnd + 1);
    } else {
      out += '&';
      rest = tail.slice(1);
    }
  }
  return out + rest;
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.fround(parsed) : null;
}

/** 从批改结果中解析评分（`<score>`/`<dim>` 属性任意顺序均可解析） */
export function parseScoreFromResult(result: string, mode: GradingMode): ParsedScore | null {
  const scoreRegex = /<score\b([^>]*)>([\s\S]*?)<\/score>/g;
  const dimRegex = /<dim\b([^>]*)>([^<]*)<\/dim>/g;

  // 协议规定评分在回复最末尾且只有一个；若 LLM 违规输出多个 <score>，
  // 取最后一个（末尾的才是最终评分，前面的多为示例/中间描述）
  let scoreMatch: RegExpExecArray | null = null;
  let candidate: RegExpExecArray | null;
  while ((candidate = scoreRegex.exec(result)) !== null) scoreMatch = candidate;
  if (scoreMatch === null) return null;

  const scoreAttrs = scoreMatch[1] as string;
  const dimsContent = scoreMatch[2] as string;

  const totalRaw = extractAttr(scoreAttrs, 'total');
  const maxRaw = extractAttr(scoreAttrs, 'max');
  if (totalRaw === null || maxRaw === null) return null;
  const totalParsed = parseNumber(totalRaw);
  const maxTotalParsed = parseNumber(maxRaw);
  if (totalParsed === null || maxTotalParsed === null) return null;

  // 边界校验
  if (!Number.isFinite(maxTotalParsed) || maxTotalParsed <= 0) return null;
  if (!Number.isFinite(totalParsed)) return null;

  // 校验 max_total 与模式配置的一致性，以模式配置为权威值
  const modeTotalMax = Math.fround(mode.totalMaxScore);
  const modeMax = Number.isFinite(modeTotalMax) && modeTotalMax > 0
    ? modeTotalMax
    : maxTotalParsed;

  let total = Math.max(0, Math.min(totalParsed, modeMax));

  // 解析维度评分：单个坏维度（score="8分"、"8.5/10" 等格式漂移）只跳过该维度
  const dimensions: DimensionScore[] = [];
  let dimMatch: RegExpExecArray | null;
  while ((dimMatch = dimRegex.exec(dimsContent)) !== null) {
    const attrs = dimMatch[1] ?? '';
    const nameValue = extractAttr(attrs, 'name');
    if (nameValue === null || nameValue.length === 0) continue;
    const scoreAttr = extractAttr(attrs, 'score');
    const scoreParsed = scoreAttr === null ? null : parseNumber(scoreAttr);
    if (scoreParsed === null) continue;
    const maxAttr = extractAttr(attrs, 'max');
    const dimMaxParsed = maxAttr === null ? null : parseNumber(maxAttr);
    if (dimMaxParsed === null) continue;
    const rawComment = (dimMatch[2] ?? '').trim();
    const comment = rawComment.length === 0 ? null : rawComment;

    if (!Number.isFinite(dimMaxParsed) || dimMaxParsed <= 0) continue;
    if (!Number.isFinite(scoreParsed)) continue;

    // 模式配置的维度满分为权威值；clamp 与落库的 maxScore 使用同一个 dimMax
    const configured = mode.scoreDimensions.find((dim) => dim.name === nameValue);
    const configuredMaxScore = configured === undefined ? null : Math.fround(configured.maxScore);
    const configuredMax = configuredMaxScore !== null
      && Number.isFinite(configuredMaxScore) && configuredMaxScore > 0
      ? configuredMaxScore
      : null;
    const dimMax = configuredMax ?? dimMaxParsed;
    const score = Math.max(0, Math.min(scoreParsed, dimMax));

    dimensions.push({ name: nameValue, score, maxScore: dimMax, comment });
  }

  // 求和制模式一致性校正：维度满分之和等于总分满分（非 band 制），
  // 且全部模式维度均成功解析时，以逐维度得分之和为准。
  const dimsMaxSum = f32Sum(mode.scoreDimensions.map((dim) => dim.maxScore));
  const isSumMode = mode.scoreDimensions.length > 0 && Math.abs(Math.fround(dimsMaxSum - modeMax)) < Math.fround(0.01);
  const allModeDimsParsed = dimensions.length === mode.scoreDimensions.length
    && mode.scoreDimensions.every((modeDim) => dimensions.some((dim) => dim.name === modeDim.name));
  if (isSumMode && allModeDimsParsed) {
    const dimSum = f32Sum(dimensions.map((dim) => dim.score));
    if (Math.abs(Math.fround(dimSum - total)) > 0.5) {
      total = Math.max(0, Math.min(dimSum, modeMax));
    }
  }

  const percentage = Math.fround(Math.fround(total / modeMax) * 100);
  const grade: GradeCode = percentage >= 90
    ? 'excellent'
    : percentage >= 75
      ? 'good'
      : percentage >= 60
        ? 'pass'
        : 'fail';

  return {
    total: f32Json(total), maxTotal: f32Json(modeMax), grade,
    dimensions: dimensions.map((dim) => ({ ...dim, score: f32Json(dim.score), maxScore: f32Json(dim.maxScore) })),
  };
}

// ============================================================================
// 用户输入净化
// ============================================================================

const ZH_INJECTION_RE = /(?:忽略|无视|忘记|忘掉|抛开|不要理会)\s*(?:掉)?\s*(?:以上|上述|之前|前面|上面|所有|全部)\s*(?:的)?\s*(?:所有|全部)?\s*(?:系统)?\s*(?:指令|指示|命令|提示词|提示|prompt|规则|要求|设定|设置|约束|限制)/g;
const EN_INJECTION_RES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|the\s+|any\s+)?(?:above|previous|prior|earlier|preceding)\s*(?:instructions?|prompts?|rules?|messages?|directions?|text)?/gi,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|the\s+|any\s+)?(?:instructions?|prompts?|system\s+prompts?)/gi,
];

/**
 * 净化用户输入，移除潜在的注入攻击内容（字符数截断，避免 UTF-8 边界问题）。
 *
 * 中英文都要求"动词 + 指令对象"同现才过滤，避免误伤正当论述
 * （如"我们不能忽略以上因素"、"ignore all distractions"）。
 */
export function sanitizeUserInput(input: string, maxChars: number): string {
  const chars = Array.from(input);
  const truncated = chars.length > maxChars ? chars.slice(0, maxChars).join('') : input;
  let result = truncated.replace(ZH_INJECTION_RE, '[已过滤]');
  for (const regex of EN_INJECTION_RES) {
    result = result.replace(regex, '[filtered]');
  }
  return result;
}

// ============================================================================
// 图片校验
// ============================================================================

/** 估算 base64 负载解码后的字节数（无需实际解码；兼容 data URI 前缀） */
export function estimatedDecodedLen(base64Data: string): number {
  const commaIndex = base64Data.indexOf(',');
  const payload = commaIndex >= 0 && base64Data.slice(0, commaIndex).startsWith('data:')
    ? base64Data.slice(commaIndex + 1)
    : base64Data;
  return Math.floor((payload.trim().length * 3) / 4);
}

function imageLimitError(message: string, reason: string, kind: string): EssayGradingError {
  return new EssayGradingError(AppErrorType.Validation, message, {
    code: 'ESSAY_IMAGE_LIMIT_EXCEEDED',
    reason, // count | single_size | total_size
    kind, // essay | topic | all
    retryable: false,
    limits: {
      max_images_per_kind: MAX_IMAGES_PER_KIND,
      max_image_decoded_bytes: MAX_IMAGE_DECODED_BYTES,
      max_total_image_decoded_bytes: MAX_TOTAL_IMAGE_DECODED_BYTES,
    },
  });
}

/** 校验多模态图片的数量与体积上限，超限抛出结构化 Validation 错误 */
export function validateImagePayloads(essayImages: readonly string[], topicImages: readonly string[]): void {
  let totalBytes = 0;
  const groups: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['essay', '作文原图', essayImages],
    ['topic', '题目参考图片', topicImages],
  ];
  for (const [kind, label, images] of groups) {
    if (images.length > MAX_IMAGES_PER_KIND) {
      throw imageLimitError(
        `${label}数量超限：${images.length} 张（每类最多 ${MAX_IMAGES_PER_KIND} 张）`,
        'count',
        kind,
      );
    }
    images.forEach((image, index) => {
      const bytes = estimatedDecodedLen(image);
      if (bytes > MAX_IMAGE_DECODED_BYTES) {
        throw imageLimitError(
          `${label}第 ${index + 1} 张体积超限：约 ${(bytes / (1024 * 1024)).toFixed(1)}MB（单张最大 ${MAX_IMAGE_DECODED_BYTES / (1024 * 1024)}MB）`,
          'single_size',
          kind,
        );
      }
      totalBytes += bytes;
    });
  }
  if (totalBytes > MAX_TOTAL_IMAGE_DECODED_BYTES) {
    throw imageLimitError(
      `图片总体积超限：约 ${(totalBytes / (1024 * 1024)).toFixed(1)}MB（合计最大 ${MAX_TOTAL_IMAGE_DECODED_BYTES / (1024 * 1024)}MB）`,
      'total_size',
      'all',
    );
  }
}

// ============================================================================
// 图片 MIME 猜测
// ============================================================================

const BASE64_HEAD_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64Head(payload: string): Uint8Array | null {
  const head = payload.slice(0, 24);
  if (head.length === 0) return new Uint8Array(0);
  if (head.length % 4 !== 0 || !BASE64_HEAD_RE.test(head)) return null;
  const decoded = decodeBase64Standard(head);
  return decoded.bytes ?? null;
}

/** 根据 base64 数据的前几个字节猜测图片 MIME 类型（兼容 data URI 前缀） */
export function guessImageMime(base64Data: string): string {
  if (base64Data.startsWith('data:')) {
    const rest = base64Data.slice('data:'.length);
    const declared = rest.split(/[;,]/, 1)[0] ?? '';
    switch (declared) {
      case 'image/png': return 'image/png';
      case 'image/jpeg':
      case 'image/jpg': return 'image/jpeg';
      case 'image/webp': return 'image/webp';
      case 'image/gif': return 'image/gif';
      default: break;
    }
  }
  const commaIndex = base64Data.indexOf(',');
  const payload = commaIndex >= 0 && base64Data.slice(0, commaIndex).startsWith('data:')
    ? base64Data.slice(commaIndex + 1)
    : base64Data;
  const bytes = decodeBase64Head(payload);
  if (bytes !== null) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
    if (bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'image/webp';
    }
  }
  return 'image/jpeg';
}

// ============================================================================
// 文本截断
// ============================================================================

/**
 * 超长文本保留头尾、截去中间。
 *
 * 上一轮批改结果的「总分/总结」在尾部，纯头部截断会丢失关键上下文。
 */
export function truncateKeepHeadTail(input: string, maxChars: number): string {
  const chars = Array.from(input);
  const total = chars.length;
  if (total <= maxChars) return input;
  // 预留省略标记的长度，头部约占 5/8、尾部约占 3/8
  const budget = Math.max(maxChars > 32 ? maxChars - 32 : 0, 64);
  const headChars = Math.floor((budget * 5) / 8);
  const tailChars = budget - headChars;
  const head = chars.slice(0, headChars).join('');
  const tail = chars.slice(total - tailChars).join('');
  return `${head}\n……（中间内容过长，已省略）……\n${tail}`;
}

// ============================================================================
// Prompt 构造
// ============================================================================

/** 英文界面：评语一律英文，但作文原文、润色句、范文与维度名保持原样 */
const RESPONSE_LANGUAGE_RULE_EN = '\n【Feedback language】\nWrite ALL feedback in English: every reason / explanation / text attribute of the markers, the <dim> comments, answers to the student\'s questions, and any other commentary. Keep the student\'s original text exactly as written, keep <polished> sentences and the model essay in the essay\'s own language, keep marker tag and attribute names unchanged, and keep each <dim name="..."> value exactly as configured above (do not translate dimension names).\n';

/** 中文界面（显式传入）：评语用中文——英文作文同样用中文讲解 */
const RESPONSE_LANGUAGE_RULE_ZH = '\n【反馈语言】\n所有评语、标记的 reason/explanation/text 属性、<dim> 评语与提问解答一律用中文撰写（英文作文也用中文讲解）；学生原文、<polished> 润色句与参考范文保持作文本身的语言，<dim> 的 name 与上方配置逐字一致。\n';

/**
 * 根据请求的反馈语言返回需追加的语言规则。
 * 缺省（null/空/未知值）返回 null，保持历史提示词不变；`en*` → 英文；`zh*` → 中文。
 */
export function responseLanguageRule(responseLanguage: string | null): string | null {
  const lang = (responseLanguage ?? '').trim().toLowerCase();
  if (lang.startsWith('en')) return RESPONSE_LANGUAGE_RULE_EN;
  if (lang.startsWith('zh')) return RESPONSE_LANGUAGE_RULE_ZH;
  return null;
}

/**
 * 构造批改 Prompt，返回 `[systemPrompt, userPrompt]`。
 * 含输入净化与长度校验（`MAX_INPUT_CHARS`）。
 */
export function buildGradingPrompts(
  request: GradingRequest,
  mode: GradingMode,
  hasEssayImages: boolean,
): [string, string] {
  // 允许纯图作文（多模态模型直接读原图）；仅当既无文本又无作文图片时才报错
  if (request.inputText.trim().length === 0 && !hasEssayImages) {
    throw new EssayGradingError(AppErrorType.Validation, '作文内容不能为空');
  }
  const inputCharCount = Array.from(request.inputText).length;
  if (inputCharCount > MAX_INPUT_CHARS) {
    throw new EssayGradingError(
      AppErrorType.Validation,
      `作文内容超过最大长度限制（${MAX_INPUT_CHARS} 字符）`,
    );
  }

  let systemPrompt = '';

  // 1. 批阅模式的系统提示词
  systemPrompt += mode.systemPrompt;
  systemPrompt += '\n\n';
  // 1.5 公式契约（共享常量）：作文中出现的公式统一按 LaTeX 输出
  systemPrompt += LATEX_OUTPUT_BRIEF;
  systemPrompt += '\n\n';

  // 2. 标记符使用说明
  systemPrompt += MARKER_INSTRUCTIONS;
  systemPrompt += '\n';

  // 2.5 润色提升 section 指令（始终启用）
  systemPrompt += SECTION_INSTRUCTIONS;
  // 如果有作文题干，追加参考范文 section 指令
  const topic = request.topic;
  if (topic !== null && topic.trim().length > 0) {
    systemPrompt += MODEL_ESSAY_INSTRUCTIONS;
  }
  systemPrompt += '\n';

  // 3. 评分格式说明，包含该模式的评分维度
  systemPrompt += SCORE_FORMAT_INSTRUCTIONS;
  systemPrompt += `\n\n该模式的评分维度（总分 ${mode.totalMaxScore} 分）：\n`;
  for (const dim of mode.scoreDimensions) {
    systemPrompt += `- ${dim.name}（${dim.maxScore}分）`;
    if (dim.description !== null) {
      systemPrompt += `：${dim.description}`;
    }
    systemPrompt += '\n';
  }

  // 4. 学生提问解答指令
  systemPrompt += '\n学生提问解答：\n';
  systemPrompt += '如果学生在作文尾部附加了提问、疑惑或请求（例如"老师，这里我不太确定该怎么写"、"请问这个词用得对吗"等），你需要在批改解析中对这些问题逐一进行解答，帮助学生理解和改进。注意区分正文内容与尾部提问，提问部分不纳入评分。\n';

  // 4.5 反馈语言规则（放在用户额外要求之前，用户可在额外要求中另行指定）
  const languageRule = responseLanguageRule(request.responseLanguage);
  if (languageRule !== null) systemPrompt += languageRule;

  // 5. 用户自定义 prompt（限制长度并净化）
  if (request.customPrompt !== null) {
    const trimmed = request.customPrompt.trim();
    if (trimmed.length > 0) {
      systemPrompt += '\n用户额外要求：\n';
      systemPrompt += sanitizeUserInput(trimmed, 2000);
    }
  }

  // 构造用户提示
  let userPrompt = '';
  const inputStats = calculateTextStats(request.inputText);

  if (topic !== null) {
    const trimmed = topic.trim();
    if (trimmed.length > 0) {
      userPrompt += '【作文题目】\n';
      userPrompt += sanitizeUserInput(trimmed, 1000);
      userPrompt += '\n\n---\n\n';
    }
  }

  // 上一轮上下文，供 AI 对比参考
  const hasPreviousContext = request.previousInput !== null || request.previousResult !== null;
  if (hasPreviousContext) {
    if (request.previousInput !== null) {
      const trimmed = request.previousInput.trim();
      if (trimmed.length > 0) {
        const condensed = truncateKeepHeadTail(trimmed, MAX_PREVIOUS_RESULT_CHARS);
        userPrompt += '【上一轮学生原文】\n';
        userPrompt += sanitizeUserInput(condensed, MAX_PREVIOUS_RESULT_CHARS);
        userPrompt += '\n\n';
      }
    }
    if (request.previousResult !== null) {
      const trimmed = request.previousResult.trim();
      if (trimmed.length > 0) {
        // 总分/总结在尾部，必须保留
        const condensed = truncateKeepHeadTail(trimmed, MAX_PREVIOUS_RESULT_CHARS);
        userPrompt += '【上一轮批改反馈】\n';
        userPrompt += sanitizeUserInput(condensed, MAX_PREVIOUS_RESULT_CHARS);
        userPrompt += '\n\n';
      }
    }
    userPrompt += '---\n\n';
    userPrompt += '以下为学生修改后的新版本，请对比上一轮原文，关注学生的改进与仍存在的问题，给出针对性批改。\n\n';
  }

  // 兼容旧版：根据作文类型和年级补充提示（空值不添加）
  const essayTypeHint = request.essayType === 'narrative'
    ? '这是一篇记叙文。'
    : request.essayType === 'argumentative'
      ? '这是一篇议论文。'
      : request.essayType === 'expository'
        ? '这是一篇说明文。'
        : '';
  const gradeHint = request.gradeLevel === 'middle_school'
    ? '请按照初中生的标准进行评判。'
    : request.gradeLevel === 'high_school'
      ? '请按照高中生的标准进行评判。'
      : request.gradeLevel === 'college'
        ? '请按照大学生的标准进行评判。'
        : '';
  if (essayTypeHint.length > 0 || gradeHint.length > 0) {
    userPrompt += `${essayTypeHint} ${gradeHint}\n\n`;
  }

  // 系统统计信息，避免模型依赖 token 估算字数
  userPrompt += buildStatsPromptBlock(inputStats);

  // 作文内容本身不做净化（保留原始内容以便正确批改）
  if (request.inputText.trim().length === 0 && hasEssayImages) {
    // 纯图作文——正文在原图中，提示模型直接读图批改
    userPrompt += '【学生作文】（正文见下方原始图片，请直接阅读图片进行批改）';
  } else {
    userPrompt += `【学生作文】\n${request.inputText}`;
  }

  return [systemPrompt, userPrompt];
}
