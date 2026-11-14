/** Page-level OCR owner exits: exam_engine.rs:350–394 (image preparation), :465–676
 * (request_deepseek_ocr_content), :685–843 (call_ocr_page_with_fallback), :1211
 * (call_deepseek_ocr_page_raw) and mod.rs:7394 (test_ocr_with_engine).
 */
import { extname, isAbsolute, join } from '../../../platform/util/path.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { ioMessageFor } from '../../../platform/paths/io-error.ts';
import { statusLine, utf8ByteLength } from '../../../platform/util/portable.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import {
  OcrAdapterFactory, isDedicatedOcrEngine, performSystemOcr, type LlmAdapterService, type LlmCodexAuthService,
  type OcrEngineType, type OcrRegion, type OcrTaskType,
} from '../../llm-providers/api.ts';
import type {
  ApiConfig, ExamSegmentationCard, LLMManager, LlmOcrModels, LlmOcrPages, LlmOcrRegions, LlmStreamingService,
  LlmUsageRecorder,
} from '../api.ts';
import { OCR_CIRCUIT_BREAKER, type OcrCircuitBreaker } from './ocr_circuit_breaker.ts';
import type { OcrHedgeOwner } from './ocr_hedge_service.ts';
import { buildOcrRequestBody } from './exam_engine.ts';
import { applyReasoningConfig, type JsonObject } from './question_authoring.ts';
import { ZhipuAdapter } from './adapters/zhipu.ts';
import { defaultSingleShotOptions } from './single_shot_stream.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { prepareProviderRequest } from './prepared_request.ts';
import { normalizeNonstreamResponseToOpenaiForConfig } from './mod_compat.ts';
import { sanitizeRequestBodyForAudit, sanitizeUrlForLog } from './audit.ts';
import { estimateTokens } from './tokens.ts';
import { logDebug, logError, logInfo, logWarn } from './logging.ts';
import { isOfficialDeepseekOcr, recognizeDeepseekPage } from './deepseek_ocr_api.ts';

/** mod.rs:3135–3136. */
export const EXAM_SEGMENT_MAX_IMAGE_BYTES = 1_500_000;
export const EXAM_SEGMENT_MAX_DIMENSION = 1_600;

function messageOf(error: unknown): string {
  return error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

function isAppError(value: unknown): value is AppError {
  return value !== null && typeof value === 'object' && 'error_type' in value && 'message' in value;
}

/** `ctx.files` 中 OCR 页面服务读取图片用到的操作。 */
export type OcrImageFiles = Pick<FilesService, 'readBytes'>;

/** Rust `io::Error` Display：`ctx.files` 的 `FileError` 保留底层 Node 错误（`cause`），按它复刻文案。 */
function ioText(error: unknown, platform: string): string {
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  return ioMessageFor(cause ?? error, platform);
}

/** dstu-storage file_manager.rs:237 `FileManager::resolve_image_path` (F3 has no public port).
 *
 * 符号链接逃逸由 `ctx.files` 的根目录包含判断兜底：读文件时越界会被拒绝，
 * 这里只保留 Rust 的字面 `..` 组件检查与相对路径归一。 */
export function resolveImagePath(imagesDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) return relativePath;
  const trimmed = (relativePath.startsWith('images/') ? relativePath.slice('images/'.length) : relativePath).replace(/^\/+/, '');
  const candidate = join(imagesDir, trimmed);
  if (trimmed.split(/[\\/]/).includes('..')) {
    logWarn(`路径遍历拦截: 检测到 '..' 组件 in ${relativePath}`);
    return imagesDir;
  }
  return candidate;
}

/** exam_engine.rs `infer_image_mime`. */
export function inferImageMime(path: string): string {
  const extension = extname(path).slice(1).toLowerCase() || 'png';
  switch (extension) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'gif': return 'image/gif';
    default: return 'image/png';
  }
}

/** `detect_mime_from_image_bytes` (image::guess_format subset). */
export function detectMimeFromImageBytes(bytes: Uint8Array): string | null {
  const starts = (signature: readonly number[]): boolean => signature.every((value, index) => bytes[index] === value);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45
    && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (starts([0x42, 0x4d])) return 'image/bmp';
  return null;
}

/** exam_engine.rs:350 `prepare_segmentation_image_data`. */
export async function prepareSegmentationImageData(image: Pick<NativeImage, 'resizeTriangleJpeg'>,
  files: OcrImageFiles, resolvePath: (path: string) => string, path: string, defaultMime: string, platform: string): Promise<{ dataUrl: string; size: number }> {
  const absolute = resolvePath(path);
  let data: Uint8Array;
  try { data = await files.readBytes(absolute); }
  catch (error) { throw AppError.file_system(`读取试卷图片失败: ${ioText(error, platform)}`); }
  const detected = detectMimeFromImageBytes(data) ?? defaultMime;
  if (data.length <= EXAM_SEGMENT_MAX_IMAGE_BYTES) {
    return { dataUrl: `data:${detected};base64,${toBase64(data)}`, size: data.length };
  }
  let buffer: Uint8Array;
  try {
    buffer = await image.resizeTriangleJpeg(data, EXAM_SEGMENT_MAX_DIMENSION, EXAM_SEGMENT_MAX_DIMENSION, 85);
  } catch (error) {
    const stage = error !== null && typeof error === 'object' && 'stage' in error ? (error as { stage: string }).stage : 'decode';
    throw AppError.file_system(`${stage === 'encode' ? '压缩试卷图片失败' : '加载试卷图片失败'}: ${messageOf(error)}`);
  }
  return { dataUrl: `data:image/jpeg;base64,${toBase64(buffer)}`, size: buffer.length };
}

export interface OcrPagesRuntime {
  manager: Pick<LLMManager, 'getApiConfigs' | 'decryptApiKey'>;
  models: Pick<LlmOcrModels, 'getOcrConfigsByPriority' | 'getFreeTextOcrCandidatesByPriority'
    | 'getOcrModelConfigForEngine' | 'isOcrThinkingEnabled'>;
  regions: LlmOcrRegions;
  streaming: LlmStreamingService;
  image: Pick<NativeImage, 'resizeTriangleJpeg' | 'dimensions'>;
  adapters: LlmAdapterService;
  codex: LlmCodexAuthService | undefined;
  fetch: typeof fetch;
  /** `ctx.files`：页面图片读取（限定在允许根内）。 */
  files(): OcrImageFiles;
  /** FileManager::resolve_image_path. */
  resolveImagePath(path: string): string;
  /** Node platform name; Rust `io::Error` Display takes the platform libc's strerror text. */
  platform: string;
  emit(name: string, payload: JsonValue): void;
  usage(): LlmUsageRecorder | undefined;
  hedge: OcrHedgeOwner;
  breaker?: OcrCircuitBreaker;
  systemOcr?(bytes: Uint8Array): Promise<string>;
}

const SYSTEM_OCR_TIMEOUT_MS = 60_000;

export function createOcrPagesService(runtime: OcrPagesRuntime): LlmOcrPages {
  const breaker = runtime.breaker ?? OCR_CIRCUIT_BREAKER;
  const systemOcr = runtime.systemOcr ?? performSystemOcr;

  function debug(level: string, stage: string, page: number, message: string, data: JsonValue = null): void {
    const prefix = `[DeepSeek-OCR-Debug:${stage}:page-${page}]`;
    logDebug(`${prefix} [${level.toUpperCase()}] ${message}`);
    if (data !== null) logDebug(`${prefix}   data: ${JSON.stringify(data, null, 2)}`);
    try { runtime.emit('deepseek_ocr_log', { level, stage, page_index: page, message, data }); }
    catch (error) { logError(`[DeepSeek-OCR-Debug] 发送事件失败: ${messageOf(error)}`); }
  }

  /** exam_engine.rs:465 request_deepseek_ocr_content. */
  async function requestOcrContent(config: ApiConfig, pagePath: string, pageIndex: number): Promise<string> {
    const effective = OcrAdapterFactory.inferEngineFromModel(config.model);
    const adapter = OcrAdapterFactory.create(effective);
    const engineName = adapter.displayName();
    debug('info', 'request', pageIndex, `开始调用 ${engineName} API`);
    const { dataUrl } = await prepareSegmentationImageData(runtime.image, runtime.files(), path => runtime.resolveImagePath(path), pagePath, inferImageMime(pagePath), runtime.platform);
    if (isOfficialDeepseekOcr(config)) return recognizeDeepseekPage(runtime.fetch,
      await runtime.manager.decryptApiKey(config.apiKey), dataUrl, 'rich_layout_recognition');
    const promptText = adapter.buildPrompt('grounding');
    const messages: JsonObject[] = [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: dataUrl, detail: adapter.requiresHighDetail() ? 'high' : 'low' } },
      { type: 'text', text: promptText },
    ] }];
    debug('debug', 'request', pageIndex, `使用的 prompt (${engineName})`, { prompt: promptText, engine: adapter.engineType() });
    const body = buildOcrRequestBody(config, messages, adapter.recommendedTemperature()) as JsonObject;
    applyReasoningConfig(body, config, null);
    if (ZhipuAdapter.supportsThinkingStatic(config.model)) {
      body.thinking = { type: runtime.models.isOcrThinkingEnabled() ? 'enabled' : 'disabled' };
    }
    const extra = adapter.getExtraRequestParams();
    if (extra !== null) {
      if (typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
      else body.extra_params = extra;
    }
    const penalty = adapter.recommendedRepetitionPenalty();
    if (penalty !== null) body.repetition_penalty = penalty;
    logInfo(`[DeepSeek-OCR] 页面 ${pageIndex} 发送请求 (streaming): base_url=${sanitizeUrlForLog(config.baseUrl)}, body_size≈${Math.floor(utf8ByteLength(JSON.stringify(body)) / 1024)}KB`);
    const opts = { ...defaultSingleShotOptions(`${engineName}-OCR(page ${pageIndex})`), maxRetries: 1 };
    const completion = await runtime.streaming.singleShotCompletion(config, body as JsonValue, null, null,
      'DeepSeek-OCR 请求构建失败', opts, null);
    const content = completion.content;
    const usage = completion.usage ?? null;
    logInfo(`[DeepSeek-OCR] 页面 ${pageIndex} 收到响应: ${utf8ByteLength(content)} 字符 (attempts=${completion.attempts}, stream=${completion.mode === 'stream'}, finish=${completion.finishReason === null ? 'None' : `Some("${completion.finishReason}")`})`);
    debug('info', 'response', pageIndex, `响应完成: attempts=${completion.attempts}, stream=${completion.mode === 'stream'}`);
    debug('info', 'response', pageIndex, `content 长度: ${utf8ByteLength(content)} 字符`);
    debug('info', 'response', pageIndex, '完整 content 内容', { content });
    debug('info', 'response', pageIndex, 'Token 使用情况', usage);

    const object = usage !== null && typeof usage === 'object' && !Array.isArray(usage) ? usage as { [key: string]: JsonValue } : null;
    const u64 = (value: JsonValue | undefined): number | null =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
    const field = (...keys: string[]): JsonValue | undefined => {
      for (const key of keys) if (object !== null && key in object) return object[key];
      return undefined;
    };
    const measuredPrompt = u64(field('prompt_tokens', 'input_tokens'));
    const measuredCompletion = u64(field('completion_tokens', 'output_tokens'));
    const details = field('prompt_tokens_details', 'input_tokens_details');
    const detailCached = details !== null && typeof details === 'object' && !Array.isArray(details) && 'cached_tokens' in details
      ? details.cached_tokens : undefined;
    const cachedRaw = detailCached !== undefined ? detailCached : field('prompt_cache_hit_tokens', 'cached_tokens');
    const cached = u64(cachedRaw);
    const tokenSource = measuredPrompt !== null && measuredCompletion !== null ? 'api'
      : measuredPrompt === null && measuredCompletion === null ? 'heuristic' : 'mixed';
    const record = {
      promptTokens: (measuredPrompt ?? 0) >>> 0, completionTokens: (measuredCompletion ?? estimateTokens(content)) >>> 0,
      reasoningTokens: null, cachedTokens: cached === null ? null : cached >>> 0, cacheWriteTokens: null,
      callerType: 'exam_sheet' as const, model: config.model, sessionId: null, variantId: null, runId: null, durationMs: null,
      success: true, errorMessage: null, adapter: effectiveApiProtocolForConfig(config), tokenSource,
    } as const;
    const recorder = runtime.usage();
    if (recorder === undefined) logWarn('[LLM Usage] F3 llmUsage 记录服务未安装，本次 OCR 用量未落库');
    else recorder.recordLlmUsageCacheExtWithIdentity(record);
    return content;
  }

  /** exam_engine.rs:1211 call_deepseek_ocr_page_raw. */
  async function ocrPageRaw(config: ApiConfig, pagePath: string, pageIndex: number): Promise<ExamSegmentationCard[]> {
    const effective = OcrAdapterFactory.inferEngineFromModel(config.model);
    const content = await requestOcrContent(config, pagePath, pageIndex);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await runtime.files().readBytes(runtime.resolveImagePath(pagePath))); }
    catch (error) { throw AppError.file_system(`读取图片尺寸失败: ${messageOf(error)}`); }
    return runtime.regions.parse(content, bytes, pagePath, pageIndex, effective);
  }

  /** exam_engine.rs:221 system_ocr_full_page. */
  async function systemOcrFullPage(pagePath: string): Promise<string> {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await runtime.files().readBytes(runtime.resolveImagePath(pagePath))); }
    catch (error) { throw new Error(`read page image failed: ${messageOf(error)}`); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`system_ocr timed out after ${SYSTEM_OCR_TIMEOUT_MS / 1000}s`)), SYSTEM_OCR_TIMEOUT_MS);
    });
    try {
      return await Promise.race([deadline, systemOcr(bytes).catch((error: unknown) => {
        throw new Error(`system_ocr failed: ${messageOf(error)}`);
      })]);
    } finally { clearTimeout(timer); }
  }

  /** exam_engine.rs:876 call_ocr_free_text_with_fallback_filtered. */
  async function freeText(imagePath: string, dedicatedOnly: boolean, cancellation?: AbortSignal): Promise<string> {
    if (!breaker.allowRequest()) throw AppError.llm('OCR 服务暂时不可用（连续失败触发熔断），请稍后重试');
    let engines: Awaited<ReturnType<typeof runtime.models.getFreeTextOcrCandidatesByPriority>> = [];
    try { engines = await runtime.models.getFreeTextOcrCandidatesByPriority(); } catch { engines = []; } // boundary-allow empty-catch: Rust `.unwrap_or_default()`
    if (dedicatedOnly) {
      engines = engines.filter(candidate => isDedicatedOcrEngine(candidate.kind === 'systemOcr' ? 'system_ocr' : candidate.engineType));
    }
    if (engines.length === 0) {
      breaker.cancelProbe();
      throw AppError.configuration('没有已启用的 OCR 引擎，请在设置中配置');
    }
    let dataUrl: string;
    try { ({ dataUrl } = await prepareSegmentationImageData(runtime.image, runtime.files(), path => runtime.resolveImagePath(path), imagePath, inferImageMime(imagePath), runtime.platform)); }
    catch (error) { breaker.cancelProbe(); throw error; }
    let systemImage: Uint8Array | null = null;
    if (engines.some(candidate => candidate.kind === 'systemOcr')) {
      try { systemImage = new Uint8Array(await runtime.files().readBytes(runtime.resolveImagePath(imagePath))); }
      catch (error) { logWarn(`[OCR-Hedge] System OCR image read failed: ${ioMessageFor(error, runtime.platform)}`); }
    }
    let prepared: Awaited<ReturnType<OcrHedgeOwner['prepareCandidates']>>;
    try { prepared = await runtime.hedge.prepareCandidates(dataUrl, engines, systemImage); }
    catch (error) { breaker.cancelProbe(); throw error; }
    return runtime.hedge.executeAcquired(prepared, cancellation);
  }

  return {
    callOcrFreeTextWithFallback: (imagePath: string) => freeText(imagePath, false),
    callDedicatedOcrFreeTextWithFallback: (imagePath: string, cancellation: AbortSignal) => freeText(imagePath, true, cancellation),
    async callOcrPageWithFallback(pagePath: string, pageIndex: number, task: OcrTaskType) {
      let engines: (readonly [ApiConfig, OcrEngineType])[] = [];
      try { engines = await runtime.models.getOcrConfigsByPriority(task); } catch { engines = []; } // boundary-allow empty-catch: Rust `.unwrap_or_default()`
      if (engines.length === 0) throw AppError.configuration('没有已启用的 OCR 引擎，请在设置中配置');
      if (!breaker.allowRequest()) throw AppError.llm('OCR 服务暂时不可用（连续失败触发熔断），请稍后重试');
      let lastError: AppError | null = null;
      const MAX_5XX_PER_ENGINE = 2;
      let consecutive5xx = 0;
      let lastEngineIndex: number | null = null;
      for (const [idx, [config, engineType]] of engines.entries()) {
        if (lastEngineIndex !== idx) { consecutive5xx = 0; lastEngineIndex = idx; }
        logDebug(`[OCR] Trying engine #${idx} (${engineType}, model=${config.model})`);
        try {
          const cards = await ocrPageRaw(config, pagePath, pageIndex);
          if (idx > 0) logInfo(`[OCR] Fallback succeeded: engine #${idx} (${engineType}) for page ${pageIndex}`);
          breaker.recordSuccess();
          return cards;
        } catch (caught) {
          const error = isAppError(caught) ? caught : AppError.unknown(messageOf(caught));
          logWarn(`[OCR] Engine #${idx} (${engineType}) failed for page ${pageIndex}: ${error.message}`);
          const details = error.details;
          const rawStatus = details !== null && details !== undefined && typeof details === 'object' && !Array.isArray(details)
            ? (details as { [key: string]: JsonValue }).status : undefined;
          const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 0 ? rawStatus : null;
          if (status !== null && status >= 400 && status < 500) {
            breaker.recordFailure();
            throw error;
          }
          if (status !== null && status >= 500) {
            consecutive5xx += 1;
            if (consecutive5xx >= MAX_5XX_PER_ENGINE) {
              logWarn(`[OCR] Engine #${idx} (${engineType}) hit ${consecutive5xx} consecutive 5xx errors for page ${pageIndex}, skipping to next engine`);
              continue;
            }
          } else consecutive5xx = 0;
          lastError = error;
        }
      }
      let candidates: Awaited<ReturnType<typeof runtime.models.getFreeTextOcrCandidatesByPriority>> = [];
      try { candidates = await runtime.models.getFreeTextOcrCandidatesByPriority(); } catch { candidates = []; } // boundary-allow empty-catch: Rust `.unwrap_or_default()`
      if (candidates.some(candidate => candidate.kind === 'systemOcr')) {
        logInfo(`[OCR] 所有远程引擎失败，尝试本地系统 OCR 兜底（page ${pageIndex}）`);
        try {
          const text = await systemOcrFullPage(pagePath);
          const trimmed = text.trim();
          if (trimmed !== '') {
            breaker.recordSuccess();
            logInfo(`[OCR] 系统 OCR 兜底成功（page ${pageIndex}, ${utf8ByteLength(trimmed)} chars）`);
            return [{ question_label: '全页内容', bbox: { x: 0, y: 0, width: 1, height: 1 }, ocr_text: trimmed, tags: [],
              extra_metadata: { fallback_mode: 'system_ocr_full_page' }, card_id: `fp_p${pageIndex}_r0` }];
          }
          logWarn(`[OCR] 系统 OCR 兜底返回空文本（page ${pageIndex}）`);
        } catch (error) {
          logWarn(`[OCR] 系统 OCR 兜底失败（page ${pageIndex}）: ${messageOf(error)}`);
        }
      }
      breaker.recordFailure();
      throw lastError ?? AppError.configuration('所有 OCR 引擎均失败');
    },

    async testOcrWithEngine(imagePath: string, engineType: OcrEngineType, configId: string | null) {
      const adapter = OcrAdapterFactory.create(engineType);
      const engineName = adapter.displayName();
      let config: ApiConfig;
      if (configId !== null) {
        const found = (await runtime.manager.getApiConfigs()).find(candidate => candidate.id === configId);
        if (found === undefined) throw AppError.configuration(`找不到配置 ID: ${configId}`);
        config = found;
      } else config = await runtime.models.getOcrModelConfigForEngine(engineType);
      logDebug(`[OCR Test] 使用引擎 ${engineName} 测试，模型: ${config.model}`);
      if (isOfficialDeepseekOcr(config)) {
        const content = await requestOcrContent(config, imagePath, 0);
        const { width, height } = await runtime.image.dimensions(await runtime.files().readBytes(runtime.resolveImagePath(imagePath)));
        const result = adapter.parseResponse(content, width, height, 0, imagePath, 'grounding');
        const regions = result.regions.length ? result.regions : [{ label: 'text', text: result.markdown_text ?? content }];
        return { text: regions.map(region => region.text).join('\n'), regions };
      }
      const { dataUrl } = await prepareSegmentationImageData(runtime.image, runtime.files(), path => runtime.resolveImagePath(path), imagePath, inferImageMime(imagePath), runtime.platform);
      const body: JsonObject = {
        model: config.model,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl, detail: adapter.requiresHighDetail() ? 'high' : 'low' } },
          { type: 'text', text: adapter.buildPrompt('grounding') },
        ] }],
        temperature: adapter.recommendedTemperature(),
        max_tokens: (buildOcrRequestBody(config, [], 0) as { max_tokens: JsonValue }).max_tokens,
        stream: false,
      };
      const extra = adapter.getExtraRequestParams();
      if (extra !== null) {
        if (typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
        else body.extra_params = extra;
      }
      const penalty = adapter.recommendedRepetitionPenalty();
      if (penalty !== null) {
        body.repetition_penalty = penalty;
        logDebug(`[OCR Test] 设置 repetition_penalty = ${penalty} (避免重复输出)`);
      }
      const protocol = effectiveApiProtocolForConfig(config);
      const provider = runtime.adapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
        : protocol === 'google_generate_content' ? 'gemini' : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
      const { request, codexRequest } = await prepareProviderRequest(runtime.adapters, runtime.codex, provider, config,
        body as JsonValue, null, null, `${engineName} 请求构建失败`);
      const sanitizedUrl = sanitizeUrlForLog(request.url);
      logDebug(`[LLM_AUDIT:OCR_ENGINE_TEST] model=${config.model} url=${sanitizedUrl}\n${JSON.stringify(sanitizeRequestBodyForAudit(request.body), null, 2)}`);
      const TIMEOUT_MS = 300_000;
      let response: Response;
      if (codexRequest !== null && runtime.codex !== undefined) {
        response = await runtime.codex.sendWithSingleRefresh(codexRequest, { fetch: runtime.fetch, timeoutMs: TIMEOUT_MS });
      } else {
        try {
          response = await runtime.fetch(request.url, { method: 'POST', headers: request.headers,
            body: JSON.stringify(request.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (error) { throw AppError.network(`${engineName} 请求失败: ${messageOf(error)}`); }
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw AppError.llm(`${engineName} API 返回错误 (${statusLine(response.status)}): ${text}`);
      }
      let json: JsonValue;
      try { json = await response.json() as JsonValue; }
      catch (error) { throw AppError.llm(`解析 ${engineName} 响应失败: ${messageOf(error)}`); }
      const normalized = normalizeNonstreamResponseToOpenaiForConfig(config, json) as
        { choices?: { message?: { content?: unknown } }[] } | null;
      const raw = normalized?.choices?.[0]?.message?.content;
      const content = typeof raw === 'string' ? raw : '';
      let width = 1000, height = 1000;
      try { ({ width, height } = await runtime.image.dimensions(new Uint8Array(await runtime.files().readBytes(imagePath)))); }
      catch { width = 1000; height = 1000; } // boundary-allow empty-catch: Rust `.unwrap_or((1000, 1000))`
      const textRegion = (): OcrRegion => ({ label: 'text', text: content, raw_output: content });
      let regions: OcrRegion[];
      try { regions = adapter.parseResponse(content, width, height, 0, imagePath, 'grounding').regions; }
      catch { regions = [textRegion()]; } // boundary-allow empty-catch: Rust `Err(_) =>` 原文单区域
      const finalRegions = regions.length === 0 ? [textRegion()] : regions;
      return { text: finalRegions.map(region => region.text).join('\n'), regions: finalRegions };
    },
  };
}
