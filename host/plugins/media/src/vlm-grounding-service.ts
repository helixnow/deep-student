/**
 * `dstu-vision/src/vlm_grounding_service.rs::VlmGroundingService` — Stage 2 VLM 一体化页面分析
 * (`analyze_page_by_blob` / `analyze_single_page`)、DOCX 配图描述 (`describe_image`)、
 * DOCX 图文直提 (`extract_docx_questions_stream`)。
 *
 * - 模型选择 = `get_vlm_config_candidates` / `get_vlm_config`（`handout-llm.ts`，同一份移植）。
 * - 单发请求 = L02 `llmStreaming.singleShotCompletion`（Rust `single_shot_completion`）。
 * - DOCX 流式 = L02 已发布的 `providerAdapterForConfig` + `prepareProviderRequest`（含 Codex OAuth 经
 *   L01 `llmCodexAuth.sendStreamWithSingleRefresh`）+ 平台 `SseEventBuffer` + L02 `IncrementalJsonArrayParser`，
 *   重试/空闲超时/字节预算逐分支对照 Rust 手写循环。
 * - 图片缩放/JPEG 重编码 = F7 `nativeImage`。
 * 对外错误：`CommandError(AppError)`（与 `pageRasterizer` 一致）。
 */
import { STATUS_CODES } from 'node:http';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { SseEventBuffer, rustTrim, rustTrimStart } from '../../../platform/util/portable.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import {
  IncrementalJsonArrayParser, defaultSingleShotOptions, prepareProviderRequest, providerAdapterForConfig,
  type ApiConfig, type LLMManager, type LlmOcrModels, type LlmStreamingService,
} from '../../llm/api.ts';
import { LATEX_OUTPUT_BRIEF, type LlmAdapterService, type LlmCodexAuthService } from '../../llm-providers/api.ts';
import type { PageSlice } from '../api.ts';
import { decodeBase64Standard } from './base64.ts';
import { loadPageImageBytes, type FigureStoreDeps } from './figure-extractor.ts';
import { getVlmConfig, getVlmConfigCandidates } from './handout-llm.ts';
import { isRetryableHttpStatus, sanitizeUrlForLog, zhipuSupportsThinking } from './l02-unpublished.ts';
import { DIFFICULTY_RUBRIC } from './prompt-contracts.ts';
import {
  DOCX_VLM_MAX_DIMENSION, DOCX_VLM_MAX_IMAGE_BYTES, DOCX_VLM_MAX_IMAGES, DOCX_VLM_MAX_SOURCE_IMAGE_BYTES,
  DOCX_VLM_MAX_SOURCE_PIXELS, DOCX_VLM_MAX_TOTAL_IMAGE_BYTES, DOCX_VLM_STREAM_IDLE_TIMEOUT_SECS,
  accountDocxVlmStreamBytes, buildVlmRequestBody, remapDocxQuestionImageIndices, truncateUtf8,
  type PreparedDocxImage, type PreparedDocxImages,
} from './vlm-grounding.ts';
import {
  decodeVlmExtractedQuestionValue, decodeVlmExtractedQuestionsJson, decodeVlmExtractedQuestionsNodes,
  decodeVlmPageAnalysisJson, decodeVlmQuestionsJson, decodeVlmQuestionsValue, parseJsonNode,
  type VlmExtractedQuestion, type VlmPageAnalysis,
} from './vlm-serde.ts';

export interface VlmGroundingLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface VlmGroundingDeps {
  llm(): LLMManager;
  ocrModels(): LlmOcrModels;
  streaming(): LlmStreamingService;
  adapters(): LlmAdapterService;
  codex(): LlmCodexAuthService | undefined;
  image(): NativeImage;
  store: FigureStoreDeps;
  /** Rust builds its own `reqwest::Client` (connect timeout only) for the DOCX stream. */
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  /** `DOCX_VLM_STREAM_IDLE_TIMEOUT_SECS` in ms (tests shorten it). */
  idleTimeoutMs: number;
  log: VlmGroundingLog;
}

const NO_VLM_MODEL = '未找到可用的 VLM 模型（需要 GLM-4.6V / Qwen-VL 等多模态模型），请在设置中配置';
const ALL_CANDIDATES_FAILED = '所有 VLM 候选模型均失败，请检查模型配置';

/** Error → Rust `AppError` value; non-AppError failures (bugs) are rethrown. */
function appErrorOf(error: unknown): AppError {
  if (error instanceof CommandError) return error.value as AppError;
  if (error !== null && typeof error === 'object' && 'error_type' in error && 'message' in error) {
    const value = error as { error_type: AppError['error_type']; message: string; details?: JsonValue };
    return { error_type: value.error_type, message: value.message, details: value.details ?? null };
  }
  throw error;
}
const fail = (error: AppError): never => { throw new CommandError(error); };
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');
const charCount = (s: string): number => Array.from(s).length;
const takeChars = (s: string, n: number): string => Array.from(s).slice(0, n).join('');

/** `detect_image_format`（vlm_grounding_service.rs:1551，仅 png/jpeg/webp，默认 png）。 */
export function detectVlmImageFormat(data: Uint8Array): [string, string] {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return ['image/png', 'png'];
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (data.length > 12 && Buffer.from(data.subarray(0, 4)).toString('latin1') === 'RIFF'
    && Buffer.from(data.subarray(8, 12)).toString('latin1') === 'WEBP') return ['image/webp', 'webp'];
  return ['image/png', 'png'];
}

/** reqwest `StatusCode` Display: `"<code> <canonical reason>"`. */
function statusText(status: number): string {
  const reason = status === 418 ? "I'm a teapot" : STATUS_CODES[status];
  return `${status} ${reason ?? '<unknown status code>'}`;
}

function thinkingPatch(deps: VlmGroundingDeps, config: ApiConfig, body: Record<string, unknown>): void {
  if (zhipuSupportsThinking(config.model)) {
    const enable = deps.ocrModels().isOcrThinkingEnabled();
    body.thinking = { type: enable ? 'enabled' : 'disabled' };
  }
}

function vlmConfigOf(config: ApiConfig): { model: string; maxOutputTokens: number; maxTokensLimit: number | null } {
  return { model: config.model, maxOutputTokens: config.maxOutputTokens, maxTokensLimit: config.maxTokensLimit ?? null };
}

/** Strip a leading ```json / ``` fence (Rust strip_prefix → trim_start → strip_suffix(```).unwrap_or(rest) → trim). */
function stripFence(content: string): string {
  const trimmed = rustTrim(content);
  for (const prefix of ['```json', '```']) {
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length);
      const start = rustTrimStart(rest);
      return rustTrim(start.endsWith('```') ? start.slice(0, -3) : rest);
    }
  }
  return trimmed;
}

/** `&s[start..=end]` between the first `open` and the last `close`; unchanged when either is missing. */
function between(s: string, open: string, close: string): string | null {
  const start = s.indexOf(open);
  if (start < 0) return null;
  const end = s.lastIndexOf(close);
  return end >= 0 ? s.slice(start, end + 1) : s;
}

/** `parse_vlm_response`. */
export function parseVlmResponse(content: string, log: VlmGroundingLog): VlmPageAnalysis {
  const stripped = stripFence(content);
  const jsonStr = between(stripped, '[', ']') ?? between(stripped, '{', '}') ?? stripped;

  const analysis = decodeVlmPageAnalysisJson(jsonStr);
  if (analysis !== null) return analysis;
  const questions = decodeVlmQuestionsJson(jsonStr);
  if (questions !== null) return { questions };
  const obj = parseJsonNode(jsonStr);
  if (obj !== null && obj.kind === 'object') {
    const qs = [...obj.members].reverse().find(m => m.key === 'questions')?.value;
    if (qs !== undefined && qs.kind === 'array') {
      const decoded = decodeVlmQuestionsValue(qs.items);
      if (decoded !== null) return { questions: decoded };
    }
  }
  log.warn(`[VLM-Grounding] 无法解析 VLM 响应为结构化数据，原始内容: ${truncateUtf8(jsonStr, 500)}`);
  return fail(AppError.llm('VLM 响应无法解析为题目分析结果'));
}

/** `parse_docx_extraction_response`. */
export function parseDocxExtractionResponse(content: string, log: VlmGroundingLog): VlmExtractedQuestion[] {
  const stripped = stripFence(content);
  const jsonStr = between(stripped, '[', ']') ?? stripped;

  const questions = decodeVlmExtractedQuestionsJson(jsonStr);
  if (questions !== null) {
    log.info(`[VLM-Grounding] DOCX 提取成功: ${questions.length} 道题目`);
    return questions;
  }
  const obj = parseJsonNode(jsonStr);
  if (obj !== null && obj.kind === 'object') {
    const qs = [...obj.members].reverse().find(m => m.key === 'questions')?.value;
    if (qs !== undefined && qs.kind === 'array') {
      const decoded = decodeVlmExtractedQuestionsNodes(qs.items);
      if (decoded !== null) {
        log.info(`[VLM-Grounding] DOCX 提取成功 (wrapped): ${decoded.length} 道题目`);
        return decoded;
      }
    }
  }
  log.warn(`[VLM-Grounding] 无法解析 DOCX 提取响应: ${truncateUtf8(jsonStr, 500)}`);
  return fail(AppError.llm('VLM 响应无法解析为题目列表'));
}

/** `build_analysis_prompt`. */
export function buildAnalysisPrompt(textHint: string | null): string {
  let hintSection = '';
  if (textHint !== null && textHint !== '') {
    const truncated = charCount(textHint) > 1500 ? `${takeChars(textHint, 1500)}...(截断)` : textHint;
    hintSection = `

**机器提取的文本参考**（可能有误，仅供辅助识别模糊内容，以图片为准）：
---
${truncated}
---
`;
  }
  return `请分析这张试卷/题目页面图片，识别其中的所有题目和配图。${hintSection}
**任务**：
1. 识别页面中每道题目的完整内容（题号、题干、选项、答案、解析）
2. 识别页面中所有图片/配图/插图，并确定它们属于哪道题目
3. 给出每道题目和每张图片在页面中的位置坐标
4. 如果页面开头有未完成的题目（接续上一页），标记 continues_from_previous
5. 如果页面末尾有未完成的题目（续接下一页），标记 continues_to_next

**输出要求**：
请输出 JSON 数组，每个元素代表一道题目（只输出 JSON，不要其他内容）：

\`\`\`json
[
  {
    "label": "1",
    "bbox": [0.05, 0.02, 0.95, 0.17],
    "raw_text": "1. 下列关于力的说法正确的是（  ）\\nA. 力是物体...\\nB. 力可以...\\nC. ...\\nD. ...",
    "is_group": false,
    "sub_questions": [],
    "figures": [
      {
        "bbox": [0.60, 0.03, 0.92, 0.15],
        "fig_label": "配图"
      }
    ],
    "continues_from_previous": false,
    "continues_to_next": false
  }
]
\`\`\`

**字段说明**：
- \`label\`: 题号（如 "1", "2", "5-8"）
- \`bbox\`: 题目区域坐标 [x1, y1, x2, y2]，左上角到右下角，归一化到 0-1
- \`raw_text\`: 题目的完整文本（含题号、题干、选项等），数学公式用 LaTeX 格式
- \`is_group\`: 是否为题组（多道题共享一段材料或配图时为 true）
- \`sub_questions\`: 题组时的子题号列表
- \`figures\`: 该题关联的配图列表
  - \`bbox\`: 图片区域坐标 [x1, y1, x2, y2]，归一化到 0-1
  - \`fig_label\`: 图片标签（"图1", "配图", "选项图"等）
- \`continues_from_previous\`: 此题是否接续上一页（页面开头的不完整题目）
- \`continues_to_next\`: 此题是否在下一页继续（页面末尾的不完整题目）

**重要规则**：
1. 公式格式：${LATEX_OUTPUT_BRIEF}
2. 每道题的 raw_text 必须包含完整内容（题干+选项+答案+解析，如果页面上有的话）
3. 如果多道题共享一张配图（如阅读理解），将它们标记为 is_group=true
4. bbox 坐标格式为 [x1, y1, x2, y2]：(x1,y1) 是左上角，(x2,y2) 是右下角，值域 0-1
5. 如果题目没有配图，figures 留空数组
6. 注意区分题目配图和装饰性元素（页眉页脚、水印等不需要标记）
7. 如果页面开头的内容明显是上一页题目的延续（如选项 C/D 开头、答案解析开头），标记 continues_from_previous=true
8. 如果页面末尾的题目明显未结束（题干不完整、选项缺失），标记 continues_to_next=true`;
}

/** `describe_image_with_config` prompt. */
export function buildDescribePrompt(): string {
  return `请详细描述这张图片的内容。这是一份试题/学习材料中的配图。

要求：
1. 如果是数学/物理/化学等图形，精确描述图中的坐标、标注、数值、方程
2. 如果是表格，用文字或 Markdown 表格转录完整内容
3. 如果是示意图/流程图，描述各部分的关系和标注
4. 如果包含文字，完整转录；公式格式遵循下方的 LaTeX 公式契约
5. 只输出描述，不要其他多余内容\n\n${LATEX_OUTPUT_BRIEF}`;
}

/** `build_docx_extraction_prompt`. */
export function buildDocxExtractionPrompt(imageCount: number, extractedText: string): string {
  const textSection = charCount(extractedText) > 8000 ? `${takeChars(extractedText, 8000)}...(截断)` : extractedText;
  return `你是一个试题提取专家。上面是从一份 DOCX 文档中提取的 ${imageCount} 张嵌入图片（编号为图片0到图片${Math.max(0, imageCount - 1)}）。

**文档提取的文本内容**（仅供参考，图片内容请直接看图）：
---
${textSection}
---

**你的任务**：
1. 结合图片和文本，识别文档中的**所有题目**
2. 准确判断每张图片属于哪道题目（通过图片内容和文本上下文判断）
3. 提取每道题的完整结构化信息

**输出 JSON 数组**，每个元素代表一道题目（只输出 JSON，不要其他内容）：

\`\`\`json
[
  {
    "content": "题干文本（不含选项；表格用 Markdown 格式；公式用 LaTeX：$...$）",
    "question_type": "single_choice",
    "options": [{"key": "A", "content": "选项内容"}, ...],
    "answer": "A",
    "explanation": "解析（如果文档中有）",
    "image_indices": [0],
    "difficulty": "medium",
    "tags": ["力学"]
  }
]
\`\`\`

**字段说明**：
- \`question_type\`: single_choice / multiple_choice / fill_blank / short_answer / calculation / proof / essay
- \`options\`: 仅选择题需要，其他题型留空数组 \`[]\`
- \`image_indices\`: 属于该题的图片编号数组（对应上方【图片N】），无图则 \`[]\`
- \`difficulty\`: easy / medium / hard / very_hard，按下方判定标准逐题判断

${DIFFICULTY_RUBRIC}

**重要规则**：
1. 公式格式：${LATEX_OUTPUT_BRIEF}
2. 每张图片最多归属一道题目（装饰性图片如水印/页眉不需要归属）
3. 如果图片本身就是题目内容（整道题是图片），在 content 中用文字描述图片内容
4. 如果多道题共享一张图片（题组），将图片归属到题组的第一道题
5. 题目按文档中出现的顺序排列
6. 只输出 JSON 数组，不要输出任何其他内容
7. **选择题的 content 只包含题干**，不要把选项文本（A/B/C/D 的内容）写进 content，选项放到 options 数组中
8. 如果题干包含表格，请使用标准 Markdown 表格格式（必须有表头分隔行 \`|---|---|\`），例如：
   | 列1 | 列2 |
   |---|---|
   | 数据1 | 数据2 |`;
}

const base64UpperBound = (len: number): number => Math.floor((len + 3) / 4) * 3;

/**
 * `prepare_docx_image`（含缩放 + JPEG 85/75/65/55 重编码分支，经 F7 nativeImage）。
 * 失败抛出 `Error(reason)`，调用方记录并省略该图。
 */
export async function prepareDocxImageNative(
  dataUrl: string, sourceIndex: number, image: NativeImage, log: VlmGroundingLog,
): Promise<PreparedDocxImage> {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('缺少 data URL 分隔符');
  const header = dataUrl.slice(0, comma);
  if (!header.startsWith('data:image/') || !header.includes(';base64')) {
    throw new Error('不是受支持的 base64 图片 data URL');
  }
  const payload = rustTrim(dataUrl.slice(comma + 1));
  if (base64UpperBound(payload.length) > DOCX_VLM_MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`源图片可能超过 ${DOCX_VLM_MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)}MB 上限`);
  }
  let bytes: Uint8Array;
  try { bytes = decodeBase64Standard(payload); }
  catch (error) { throw new Error(`base64 解码失败: ${messageOf(error)}`); }
  if (bytes.length === 0) throw new Error('图片内容为空');
  if (bytes.length > DOCX_VLM_MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`源图片超过 ${DOCX_VLM_MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)}MB 上限`);
  }
  let width: number;
  let height: number;
  try { ({ width, height } = await image.dimensions(bytes)); }
  catch (error) { throw new Error(`无法读取图片尺寸: ${messageOf(error)}`); }
  if (width === 0 || height === 0 || width * height > DOCX_VLM_MAX_SOURCE_PIXELS) {
    throw new Error(`图片尺寸 ${width}x${height} 超出安全上限`);
  }
  if (bytes.length <= DOCX_VLM_MAX_IMAGE_BYTES && width <= DOCX_VLM_MAX_DIMENSION && height <= DOCX_VLM_MAX_DIMENSION) {
    return { dataUrl, sourceIndex, byteLen: bytes.length };
  }

  let decoded;
  try { decoded = await image.decodeRgba(bytes); }
  catch (error) { throw new Error(`图片解码失败: ${messageOf(error)}`); }
  const bounds = image.resizeDimensions(decoded.width, decoded.height, DOCX_VLM_MAX_DIMENSION, DOCX_VLM_MAX_DIMENSION);
  const resized = image.resizeRgba(decoded, bounds.width, bounds.height, 'triangle');
  for (const quality of [85, 75, 65, 55]) {
    let out: Uint8Array;
    try { out = await image.encode(resized, { format: 'jpeg', quality }); }
    catch (error) { throw new Error(`JPEG 压缩失败: ${messageOf(error)}`); }
    if (out.length <= DOCX_VLM_MAX_IMAGE_BYTES) {
      log.info(`[VLM-Grounding] DOCX 图片压缩: ${(bytes.length / (1024 * 1024)).toFixed(1)}MB -> `
        + `${(out.length / (1024 * 1024)).toFixed(1)}MB (quality=${quality})`);
      return { dataUrl: `data:image/jpeg;base64,${Buffer.from(out).toString('base64')}`, sourceIndex, byteLen: out.length };
    }
  }
  throw new Error(`压缩后仍超过 ${Math.trunc(DOCX_VLM_MAX_IMAGE_BYTES / 1024)}KB 上限`);
}

async function decryptKey(deps: VlmGroundingDeps, config: ApiConfig): Promise<string> {
  return await deps.llm().decryptApiKey(config.apiKey);
}

/** `analyze_single_page_with_config`. */
async function analyzeSinglePageWithConfig(
  deps: VlmGroundingDeps, config: ApiConfig, imageDataUrl: string, textHint: string | null,
): Promise<VlmPageAnalysis> {
  const apiKey = await decryptKey(deps, config);
  const prompt = buildAnalysisPrompt(textHint);
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
      { type: 'text', text: prompt },
    ],
  }];
  const body = buildVlmRequestBody(vlmConfigOf(config), messages, false);
  const maxTokens = body.max_tokens as number;
  thinkingPatch(deps, config, body);
  const opts = defaultSingleShotOptions(`VLM-Grounding(${config.model})`);
  deps.log.info(`[VLM-Grounding] 发送分析请求 (streaming): model=${config.model}, base_url=${sanitizeUrlForLog(config.baseUrl)}`);
  const completion = await deps.streaming().singleShotCompletion(config, body as JsonValue, apiKey, null,
    'VLM 请求构建失败', opts, null);
  if (completion.finishReason === 'length') {
    deps.log.warn(`[VLM-Grounding] 输出达到 max_tokens 上限 (${maxTokens})，结果可能被截断`);
  }
  deps.log.info(`[VLM-Grounding] 收到响应: ${byteLen(completion.content)} 字符 (attempts=${completion.attempts}, stream=${completion.mode === 'stream'})`);
  return parseVlmResponse(completion.content, deps.log);
}

/** `analyze_single_page`: candidates in priority order, fail over on any error. */
export async function analyzeSinglePage(
  deps: VlmGroundingDeps, imageDataUrl: string, textHint: string | null,
): Promise<VlmPageAnalysis> {
  const candidates = await getVlmConfigCandidates(deps);
  if (candidates.length === 0) fail(AppError.configuration(NO_VLM_MODEL));
  let lastError: AppError | null = null;
  for (const config of candidates) {
    try {
      const analysis = await analyzeSinglePageWithConfig(deps, config, imageDataUrl, textHint);
      if (lastError !== null) deps.log.info(`[VLM-Grounding] 切换到 ${config.model} (${config.name}) 后成功`);
      return analysis;
    } catch (error) {
      const e = appErrorOf(error);
      deps.log.warn(`[VLM-Grounding] 模型 ${config.model} (${config.name}) 分析失败: ${e.message}，尝试下一个候选`);
      lastError = e;
    }
  }
  return fail(lastError ?? AppError.configuration(ALL_CANDIDATES_FAILED));
}

/** `analyze_page_by_blob`. */
export async function analyzePageByBlob(deps: VlmGroundingDeps, page: PageSlice): Promise<VlmPageAnalysis> {
  const imageBytes = loadPageImageBytes(deps.store, page.blob_hash);
  const [mime] = detectVlmImageFormat(imageBytes);
  const dataUrl = `data:${mime};base64,${Buffer.from(imageBytes).toString('base64')}`;
  return analyzeSinglePage(deps, dataUrl, page.text_hint);
}

/** `describe_image_with_config`. */
async function describeImageWithConfig(deps: VlmGroundingDeps, config: ApiConfig, dataUrl: string): Promise<string> {
  const apiKey = await decryptKey(deps, config);
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      { type: 'text', text: buildDescribePrompt() },
    ],
  }];
  const body = buildVlmRequestBody(vlmConfigOf(config), messages, false);
  thinkingPatch(deps, config, body);
  const opts = { ...defaultSingleShotOptions(`VLM-Describe(${config.model})`), maxRetries: 1 };
  const completion = await deps.streaming().singleShotCompletion(config, body as JsonValue, apiKey, null,
    'VLM 图片描述请求构建失败', opts, null);
  return rustTrim(completion.content);
}

/** `describe_image`. */
export async function describeImage(deps: VlmGroundingDeps, imageBytes: Uint8Array): Promise<string> {
  const [mime] = detectVlmImageFormat(imageBytes);
  const dataUrl = `data:${mime};base64,${Buffer.from(imageBytes).toString('base64')}`;
  const candidates = await getVlmConfigCandidates(deps);
  if (candidates.length === 0) fail(AppError.configuration(NO_VLM_MODEL));
  let lastError: AppError | null = null;
  for (const config of candidates) {
    try {
      const description = await describeImageWithConfig(deps, config, dataUrl);
      if (lastError !== null) deps.log.info(`[VLM-Grounding] 图片描述切换到 ${config.model} (${config.name}) 后成功`);
      return description;
    } catch (error) {
      const e = appErrorOf(error);
      deps.log.warn(`[VLM-Grounding] 图片描述模型 ${config.model} (${config.name}) 失败: ${e.message}，尝试下一个候选`);
      lastError = e;
    }
  }
  return fail(lastError ?? AppError.configuration(ALL_CANDIDATES_FAILED));
}

type ReadResult = { kind: 'chunk'; value: Uint8Array } | { kind: 'end' } | { kind: 'idle' } | { kind: 'error'; error: unknown };

async function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<ReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<ReadResult>(resolve => { timer = setTimeout(() => resolve({ kind: 'idle' }), ms); });
  const read = reader.read().then(
    (r): ReadResult => r.done ? { kind: 'end' } : { kind: 'chunk', value: r.value },
    (error: unknown): ReadResult => ({ kind: 'error', error }),
  );
  try { return await Promise.race([read, idle]); }
  finally { clearTimeout(timer); }
}

/**
 * `extract_docx_questions_stream`：所有嵌入图片 + 文本单次发送，SSE 流式增量解析，
 * 每解析出一题回调 `onQuestion`（返回 false 中止）。返回回调的题目总数。
 */
export async function extractDocxQuestionsStream(
  deps: VlmGroundingDeps,
  imageDataUrls: readonly string[],
  extractedText: string,
  onQuestion: (question: VlmExtractedQuestion) => boolean,
): Promise<number> {
  if (imageDataUrls.length === 0) fail(AppError.validation('图片列表为空'));

  const config = await getVlmConfig(deps);
  let apiKey: string;
  try { apiKey = await decryptKey(deps, config); } catch (error) { return fail(appErrorOf(error)); }

  const totalInputCount = imageDataUrls.length;
  const prepared: PreparedDocxImages = {
    images: [], rejected: [], omittedByCount: Math.max(0, totalInputCount - DOCX_VLM_MAX_IMAGES), totalBytes: 0,
  };
  for (const [sourceIndex, dataUrl] of imageDataUrls.slice(0, DOCX_VLM_MAX_IMAGES).entries()) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) {
      prepared.rejected.push([sourceIndex, '缺少 data URL 分隔符']);
      continue;
    }
    const payload = rustTrim(dataUrl.slice(comma + 1));
    if (base64UpperBound(payload.length) > DOCX_VLM_MAX_SOURCE_IMAGE_BYTES) {
      prepared.rejected.push([sourceIndex, `源图片可能超过 ${DOCX_VLM_MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)}MB 上限`]);
      continue;
    }
    let image: PreparedDocxImage;
    try { image = await prepareDocxImageNative(dataUrl, sourceIndex, deps.image(), deps.log); }
    catch (error) {
      prepared.rejected.push([sourceIndex, messageOf(error)]);
      continue;
    }
    const nextTotal = prepared.totalBytes + image.byteLen;
    if (nextTotal > DOCX_VLM_MAX_TOTAL_IMAGE_BYTES) {
      prepared.rejected.push([sourceIndex,
        `加入后超过整批 ${DOCX_VLM_MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)}MB 图片预算`]);
      continue;
    }
    prepared.totalBytes = nextTotal;
    prepared.images.push(image);
  }

  for (const [sourceIndex, reason] of prepared.rejected) {
    deps.log.warn(`[VLM-Grounding] 省略 DOCX 图片 ${sourceIndex}: ${reason}`);
  }
  if (prepared.omittedByCount > 0) {
    deps.log.warn(`[VLM-Grounding] DOCX 图片数 ${totalInputCount} 超过单请求上限 ${DOCX_VLM_MAX_IMAGES}，未处理后续 ${prepared.omittedByCount} 张图片`);
  }
  if (prepared.images.length === 0) fail(AppError.validation('DOCX 中没有通过安全检查且可发送给 VLM 的图片'));

  const sourceIndices = prepared.images.map(image => image.sourceIndex);
  const contentParts: JsonValue[] = [];
  prepared.images.forEach((image, idx) => {
    contentParts.push({ type: 'text', text: `【图片${idx}】` });
    contentParts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } });
  });
  const omittedTotal = prepared.rejected.length + prepared.omittedByCount;
  if (omittedTotal > 0) {
    contentParts.push({
      type: 'text',
      text: `注意：原文共有 ${totalInputCount} 张嵌入图片，其中 ${omittedTotal} 张因安全或请求预算未附带；请勿臆测未显示图片的内容。`,
    });
  }
  contentParts.push({ type: 'text', text: buildDocxExtractionPrompt(prepared.images.length, extractedText) });

  const body = buildVlmRequestBody(vlmConfigOf(config), [{ role: 'user', content: contentParts }], true);
  thinkingPatch(deps, config, body);

  const provider = providerAdapterForConfig(config);
  let preq: Awaited<ReturnType<typeof prepareProviderRequest>>;
  try {
    preq = await prepareProviderRequest(deps.adapters(), deps.codex(), provider, config, body as JsonValue, apiKey, null,
      'VLM DOCX 提取请求构建失败');
  } catch (error) { return fail(appErrorOf(error)); }

  deps.log.info(`[VLM-Grounding] DOCX 图文提取 (streaming): ${prepared.images.length}/${totalInputCount} 张图片, `
    + `${prepared.totalBytes} bytes, model=${config.model}, url=${sanitizeUrlForLog(preq.request.url)}`);

  const MAX_RETRIES = 2;
  let lastError = '';
  const deliver = (value: JsonValue): boolean | 'skip' => {
    const vq = decodeVlmExtractedQuestionValue(value);
    if (vq === null) return 'skip';
    remapDocxQuestionImageIndices(vq, sourceIndices);
    return onQuestion(vq);
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const delay = 3 ** attempt;
      deps.log.warn(`[VLM-Grounding] DOCX 提取第 ${attempt} 次重试，等待 ${delay}s`);
      await deps.sleep(delay * 1000);
    }

    let response: Response;
    try {
      if (preq.request.codex && preq.codexRequest !== null) {
        const codex = deps.codex();
        if (codex === undefined) fail(AppError.configuration('OpenAI Codex OAuth 请求必须经由 LLMManager 准备'));
        response = await codex!.sendStreamWithSingleRefresh(preq.codexRequest, { fetch: deps.fetch });
      } else {
        // No total timeout, like the client Rust builds for this stream (vlm_grounding_service.rs:771-775);
        // the chunk idle timeout below bounds it instead.
        const init: RequestInit & { requestTimeoutMs: null } = {
          method: 'POST',
          headers: [...preq.request.headers, ...(preq.request.headers.some(([k]) => k.toLowerCase() === 'content-type')
            ? [] : [['content-type', 'application/json'] as [string, string]])],
          body: JSON.stringify(preq.request.body),
          requestTimeoutMs: null,
        };
        try {
          response = await deps.fetch(preq.request.url, init);
        } catch (error) {
          throw AppError.network(`VLM DOCX 提取请求失败: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      const e = appErrorOf(error);
      lastError = e.message;
      if (attempt < MAX_RETRIES) continue;
      return fail(e);
    }

    const status = response.status;
    if (isRetryableHttpStatus(status)) {
      const text = await response.text().catch(() => '');
      lastError = `VLM API 返回 ${statusText(status)}: ${truncateUtf8(text, 200)}`;
      if (attempt < MAX_RETRIES) {
        deps.log.warn(`[VLM-Grounding] ${lastError}`);
        continue;
      }
      return fail(AppError.llm(lastError));
    }
    if (status < 200 || status > 299) {
      const text = await response.text().catch(() => '');
      return fail(AppError.llm(`VLM DOCX 提取 API 返回错误 ${statusText(status)}: ${truncateUtf8(text, 500)}`));
    }

    // ===== SSE 流式读取 + 增量 JSON 解析 =====
    const reader = response.body?.getReader();
    const sseBuffer = new SseEventBuffer();
    const jsonParser = new IncrementalJsonArrayParser();
    let fullContent = '';
    let fullContentBytes = 0;
    let streamEnded = false;
    let chunkCount = 0;
    let questionCount = 0;
    let aborted = false;
    let responseBytes = 0;
    let streamIdleTimedOut = false;

    const onContent = (content: string): void => {
      fullContent += content;
      fullContentBytes += byteLen(content);
      chunkCount += 1;
      for (const obj of jsonParser.feed(content) ?? []) {
        const r = deliver(obj);
        if (r === 'skip') continue;
        questionCount += 1;
        if (!r) { aborted = true; break; }
      }
      if (chunkCount % 50 === 0) {
        deps.log.info(`[VLM-Grounding] DOCX 流式进度: ${chunkCount} chunks, ${fullContentBytes} 字符, ${questionCount} 题`);
      }
    };

    try {
      for (;;) {
        const chunk = reader === undefined ? { kind: 'end' } as ReadResult
          : await readWithIdleTimeout(reader, deps.idleTimeoutMs);
        if (chunk.kind === 'end') break;
        if (chunk.kind === 'idle') {
          lastError = `VLM DOCX 流式响应空闲超过 ${DOCX_VLM_STREAM_IDLE_TIMEOUT_SECS} 秒`;
          streamIdleTimedOut = true;
          deps.log.warn(`[VLM-Grounding] ${lastError}`);
          break;
        }
        if (aborted) break;
        if (chunk.kind === 'chunk') {
          try { responseBytes = accountDocxVlmStreamBytes(responseBytes, chunk.value.length); }
          catch (error) { return fail(AppError.llm(messageOf(error))); }
          for (const line of sseBuffer.processBytes(chunk.value)) {
            if (SseEventBuffer.checkDoneMarker(line)) { streamEnded = true; break; }
            for (const event of provider.parseStream(line)) {
              if (event.type === 'ContentChunk') onContent(event.value);
              else if (event.type === 'Done') { streamEnded = true; break; }
              if (aborted) break;
            }
            if (streamEnded || aborted) break;
          }
        } else {
          if (fullContent !== '') {
            deps.log.warn(`[VLM-Grounding] 流式读取错误但已有 ${fullContentBytes} 字符/${questionCount} 题，继续处理: ${messageOf(chunk.error)}`);
            break;
          }
          lastError = `VLM 流式读取失败: ${messageOf(chunk.error)}`;
          if (attempt < MAX_RETRIES) {
            deps.log.warn(`[VLM-Grounding] ${lastError}`);
            break;
          }
          return fail(AppError.network(lastError));
        }
        if (streamEnded) break;
      }
      // 读取错误且可重试时 Rust 只 break 读取循环，随后照常走 flush/finalize/空响应判定。

      if (aborted) {
        deps.log.info(`[VLM-Grounding] DOCX 提取回调请求停止，已在 ${questionCount} 道题后终止`);
        return questionCount;
      }

      if (streamIdleTimedOut) {
        if (questionCount > 0) {
          deps.log.warn(`[VLM-Grounding] 流空闲超时，保留已提取的 ${questionCount} 道题目`);
          return questionCount;
        }
        if (attempt < MAX_RETRIES) continue;
        return fail(AppError.network(lastError));
      }

      // 处理自然关闭且没有空行分隔符的最后一个 SSE 事件。
      for (const remaining of sseBuffer.flush()) {
        if (rustTrim(remaining) === '') continue;
        if (SseEventBuffer.checkDoneMarker(remaining)) break;
        for (const event of provider.parseStream(remaining)) {
          if (event.type !== 'ContentChunk') continue;
          fullContent += event.value;
          fullContentBytes += byteLen(event.value);
          for (const obj of jsonParser.feed(event.value) ?? []) {
            const r = deliver(obj);
            if (r === 'skip') continue;
            questionCount += 1;
            if (!r) return questionCount;
          }
        }
      }

      for (const obj of jsonParser.finalize() ?? []) {
        const r = deliver(obj);
        if (r === 'skip') continue;
        questionCount += 1;
        if (!r) return questionCount;
      }

      if (questionCount === 0 && fullContent === '') {
        lastError = 'VLM 流式响应为空';
        if (attempt < MAX_RETRIES) continue;
        return fail(AppError.llm(lastError));
      }

      if (questionCount === 0 && fullContent !== '') {
        deps.log.warn(`[VLM-Grounding] 增量解析未提取到题目，回退完整解析 (${fullContentBytes} 字符)`);
        for (const vq of parseDocxExtractionResponse(fullContent, deps.log)) {
          remapDocxQuestionImageIndices(vq, sourceIndices);
          questionCount += 1;
          if (!onQuestion(vq)) break;
        }
      }

      deps.log.info(`[VLM-Grounding] DOCX 提取流式完成: ${chunkCount} chunks, ${fullContentBytes} 字符, ${questionCount} 道题目`);
      return questionCount;
    } finally {
      if (reader !== undefined) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  return fail(AppError.llm(lastError));
}
