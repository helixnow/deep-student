import type { MultimodalIndexingMode, MultimodalInput, PluginLogger } from '../../api.ts';
import { AppError, type AppError as AppErrorValue } from '../../../../platform/errors/api.ts';
import { encodeUtf8, utf8ByteLength } from '../../../../platform/util/portable.ts';
import { EmbeddingChunker, EmbeddingTokenLimits, batchChunkTexts, type ChunkResult } from './embedding-chunker.ts';
import { MultimodalInput as MultimodalInputBuilder } from './types.ts';

/** multimodal/embedding_service.rs:39. VL models are slow; keep batches small. */
export const DEFAULT_BATCH_SIZE = 8;
/** multimodal/embedding_service.rs:41. */
export const DEFAULT_SUMMARY_CONCURRENCY = 10;
/** multimodal/embedding_service.rs:44: 1 initial attempt + 3 retries. */
export const VL_EMBED_MAX_ATTEMPTS = 4;
/** multimodal/embedding_service.rs:46. */
export const VL_EMBED_BACKOFF_BASE_MS = 500;
/** multimodal/embedding_service.rs:48. */
export const VL_EMBED_BACKOFF_MAX_MS = 8_000;

/** multimodal/embedding_service.rs:163 `EmbeddingServiceConfig`. */
export interface EmbeddingServiceConfig {
  batch_size: number;
  summary_concurrency: number;
  enable_fallback: boolean;
}

/** multimodal/embedding_service.rs:171 `impl Default for EmbeddingServiceConfig`. */
export function defaultEmbeddingServiceConfig(): EmbeddingServiceConfig {
  return {
    batch_size: DEFAULT_BATCH_SIZE,
    summary_concurrency: DEFAULT_SUMMARY_CONCURRENCY,
    enable_fallback: true,
  };
}

/** multimodal/embedding_service.rs:88 `EmbeddingProgress`. */
export interface EmbeddingProgress {
  phase: string;
  completed: number;
  total: number;
  current_page?: number;
  message: string;
}

/** multimodal/embedding_service.rs:128 `looks_like_valid_base64`. */
export function looksLikeValidBase64(data: string): boolean {
  if (utf8ByteLength(data) < 100) return false;
  const head = data.slice(0, 1024);
  for (const byte of encodeUtf8(head)) {
    const valid = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2f
      || byte === 0x3d || byte === 0x0d || byte === 0x0a;
    if (!valid) return false;
  }
  return true;
}

/** multimodal/embedding_service.rs:65 `is_transient_embedding_error`. */
export function isTransientEmbeddingError(error: AppErrorValue): boolean {
  if (error.error_type === 'Network') return true;
  const message = error.message;
  if (message.includes('请求过于频繁')
    || message.includes('暂时不可用')
    || message.includes('429')
    || message.includes('502')
    || message.includes('503')
    || message.includes('504')) {
    return true;
  }
  const lower = message.replace(/[A-Z]/g, char => char.toLowerCase());
  return lower.includes('rate limit') || lower.includes('timed out') || lower.includes('timeout');
}

/** Sub-second nanoseconds of the wall clock; only feeds retry jitter. */
function subsecNanos(): number {
  return Math.floor(((performance.timeOrigin + performance.now()) % 1000) * 1_000_000);
}

/** multimodal/embedding_service.rs:95 `vl_embed_backoff_delay` (exponential + 0–25% jitter). */
export function vlEmbedBackoffDelay(attempt: number, nanos = subsecNanos()): number {
  const shift = Math.max(0, Math.min(attempt, 6) - 1);
  const exp = VL_EMBED_BACKOFF_BASE_MS * (2 ** shift);
  const capped = Math.min(exp, VL_EMBED_BACKOFF_MAX_MS);
  const jitterRange = Math.floor(capped / 4);
  return capped + (nanos % (jitterRange + 1));
}

function cloneInput(input: MultimodalInput): MultimodalInput {
  return {
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
    ...(input.video === undefined ? {} : { video: input.video }),
  };
}

/**
 * multimodal/embedding_service.rs:461 `prepare_inputs_with_fallback`.
 * Invalid base64 images and empty image URLs degrade to their text content so
 * one bad page cannot abort a whole indexing run.
 */
export function prepareInputsWithFallback(inputs: readonly MultimodalInput[], logger?: PluginLogger): MultimodalInput[] {
  return inputs.map(input => {
    if (input.image !== undefined) {
      if ('data' in input.image) {
        if (!looksLikeValidBase64(input.image.data)) {
          logger?.warn('图片 Base64 数据无效（长度 %d 或含非法字符），降级为纯文本', input.image.data.length);
          if (input.text !== undefined) return { text: input.text };
        }
      } else if (input.image.url === '') {
        logger?.warn('图片 URL 为空，降级为纯文本');
        if (input.text !== undefined) return { text: input.text };
      }
    }
    return cloneInput(input);
  });
}

/** The frozen model assignment used by one logical batch (llm_manager::ApiConfig subset). */
export interface MultimodalEmbeddingModelConfig {
  id: string;
  model: string;
  enabled: boolean;
  is_embedding: boolean;
  is_multimodal: boolean;
  is_reranker: boolean;
}

export interface MultimodalEmbeddingRuntime {
  getVlEmbeddingModelConfig(): Promise<MultimodalEmbeddingModelConfig>;
  callMultimodalEmbeddingApiWithConfig(
    inputs: MultimodalInput[],
    config: MultimodalEmbeddingModelConfig,
  ): Promise<number[][]>;
}

export interface RetryOptions {
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injectable clock so the jitter does not make retries untestable. */
  nanos?: () => number;
  logger?: PluginLogger;
  /** 0-based batch index used only in Rust-matching log messages. */
  batchIndex?: number;
}

/**
 * multimodal/embedding_service.rs:415 `call_vl_embedding_with_retry`.
 * Transient failures back off exponentially; deterministic failures fail fast.
 */
export async function callVlEmbeddingWithRetry(
  call: () => Promise<number[][]>,
  options: RetryOptions = {},
): Promise<number[][]> {
  const maxAttempts = options.maxAttempts ?? VL_EMBED_MAX_ATTEMPTS;
  const sleep = options.sleep ?? (async (milliseconds: number) => { await new Promise<void>(resolve => { setTimeout(resolve, milliseconds); }); });
  const nanos = options.nanos ?? subsecNanos;
  const batchNumber = (options.batchIndex ?? 0) + 1;
  let attempt = 0;
  for (;;) {
    try {
      const result = await call();
      if (attempt > 0) options.logger?.info('  批次 %d 嵌入在第 %d 次重试后成功', batchNumber, attempt);
      return result;
    } catch (error) {
      attempt += 1;
      const value = toAppError(error);
      if (attempt >= maxAttempts || !isTransientEmbeddingError(value)) {
        options.logger?.error('  批次 %d 嵌入失败（共尝试 %d 次）: %s', batchNumber, attempt, value.message);
        throw error;
      }
      const backoff = vlEmbedBackoffDelay(attempt, nanos());
      options.logger?.warn(
        '  批次 %d 嵌入遇到瞬时错误（第 %d/%d 次尝试），%dms 后重试: %s',
        batchNumber, attempt, maxAttempts, backoff, value.message,
      );
      await sleep(backoff);
    }
  }
}

/** Error values cross the runtime boundary as plain IPC values in Rust. */
function toAppError(error: unknown): AppErrorValue {
  if (error !== null && typeof error === 'object' && 'error_type' in error && 'message' in error) {
    return error as AppErrorValue;
  }
  return AppError.unknown(error instanceof Error ? error.message : String(error));
}

/**
 * multimodal/embedding_service.rs:302 `embed_batch_with_progress_for_config`.
 * Progress callbacks replace the Rust mpsc channel; a synchronous callback
 * cannot be back-pressured, so no intermediate events are dropped.
 */
export async function embedBatchWithProgress(
  runtime: MultimodalEmbeddingRuntime,
  inputs: readonly MultimodalInput[],
  options: {
    config?: EmbeddingServiceConfig;
    modelConfig?: MultimodalEmbeddingModelConfig;
    onProgress?: (progress: EmbeddingProgress) => void;
    retry?: RetryOptions;
    logger?: PluginLogger;
  } = {},
): Promise<number[][]> {
  const config = options.config ?? defaultEmbeddingServiceConfig();
  if (inputs.length === 0) return [];
  const logger = options.logger;

  const modelConfig = options.modelConfig ?? await runtime.getVlEmbeddingModelConfig();
  if (!modelConfig.enabled || !modelConfig.is_embedding || !modelConfig.is_multimodal || modelConfig.is_reranker) {
    throw AppError.configuration('冻结的多模态嵌入配置已禁用或能力协议不匹配');
  }

  const total = inputs.length;
  const progress = options.onProgress;
  const allEmbeddings: number[][] = [];
  let completed = 0;

  progress?.({
    phase: 'embedding', completed, total, message: `开始多模态嵌入: 0/${total}`,
  });
  logger?.info('🖼️ 多模态嵌入服务：开始处理 %d 个输入，批量大小 %d', total, config.batch_size);

  for (let start = 0; start < total; start += config.batch_size) {
    const batchIndex = start / config.batch_size;
    logger?.debug(
      '  处理批次 %d: 输入 %d-%d / %d',
      batchIndex + 1, start + 1, Math.min(start + config.batch_size, total), total,
    );
    const chunk = inputs.slice(start, start + config.batch_size);
    const processed = config.enable_fallback ? prepareInputsWithFallback(chunk, logger) : chunk.map(cloneInput);
    const embeddings = await callVlEmbeddingWithRetry(
      () => runtime.callMultimodalEmbeddingApiWithConfig(processed, modelConfig),
      { ...options.retry, logger, batchIndex },
    );
    if (embeddings.length !== processed.length) {
      throw AppError.internal(`嵌入 API 返回数量不匹配: 期望 ${processed.length}, 实际 ${embeddings.length}`);
    }
    allEmbeddings.push(...embeddings);
    completed = Math.min(allEmbeddings.length, total);
    progress?.({
      phase: 'embedding', completed, total, current_page: completed, message: `多模态嵌入进度: ${completed}/${total}`,
    });
  }

  progress?.({
    phase: 'embedding', completed: total, total, current_page: total, message: `多模态嵌入完成: ${total}/${total}`,
  });
  logger?.info('✅ 多模态嵌入服务：完成 %d 个输入的向量化', allEmbeddings.length);
  return allEmbeddings;
}

/** multimodal/embedding_service.rs:441 `embed_pages`. */
export function pagesToInputs(
  pages: readonly (readonly [string, string, string | undefined])[],
  instruction?: string,
): MultimodalInput[] {
  return pages.map(([data, mediaType, text]) => {
    const input: MultimodalInput = text === undefined
      ? { image: { data, media_type: mediaType } }
      : { text, image: { data, media_type: mediaType } };
    return instruction === undefined ? input : { ...input, instruction };
  });
}

export interface TextEmbeddingModelConfig {
  id: string;
  model: string;
}

/**
 * L02 LLMManager methods used by `MultimodalEmbeddingService`.
 * L02 has not published these Host services yet, so this is the minimal
 * interface L02 must implement; tests provide a real in-memory substitute.
 */
export interface MultimodalEmbeddingServiceRuntime extends MultimodalEmbeddingRuntime {
  isMultimodalRagConfigured(): Promise<boolean>;
  callMultimodalEmbeddingApi(inputs: MultimodalInput[]): Promise<number[][]>;
  getEmbeddingModelConfig(): Promise<TextEmbeddingModelConfig>;
  callEmbeddingApi(texts: string[], configId: string): Promise<number[][]>;
  callOcrModelRawPrompt(
    prompt: string,
    images?: readonly { mime: string; base64: string }[],
  ): Promise<{ assistantMessage: string }>;
}

type ProgressSink = (progress: EmbeddingProgress) => void;

/**
 * multimodal/embedding_service.rs:149 `MultimodalEmbeddingService`.
 * State is explicit (runtime + config) instead of an Arc<LLMManager>.
 */
export class MultimodalEmbeddingService {
  _runtime: MultimodalEmbeddingServiceRuntime;
  _config: EmbeddingServiceConfig;
  _logger?: PluginLogger;

  constructor(
    runtime: MultimodalEmbeddingServiceRuntime,
    config: EmbeddingServiceConfig = defaultEmbeddingServiceConfig(),
    logger?: PluginLogger,
  ) {
    this._runtime = runtime;
    this._config = config;
    this._logger = logger;
  }

  /** multimodal/embedding_service.rs:164 `with_config`. */
  static withConfig(
    runtime: MultimodalEmbeddingServiceRuntime,
    config: EmbeddingServiceConfig,
    logger?: PluginLogger,
  ): MultimodalEmbeddingService {
    return new MultimodalEmbeddingService(runtime, config, logger);
  }

  /** multimodal/embedding_service.rs:172 `is_configured`. */
  async isConfigured(): Promise<boolean> { return this._runtime.isMultimodalRagConfigured(); }

  /** multimodal/embedding_service.rs:182 `is_vl_embedding_available`. */
  async isVlEmbeddingAvailable(): Promise<boolean> {
    try { await this._runtime.getVlEmbeddingModelConfig(); return true; } catch { return false; }
  }

  /** multimodal/embedding_service.rs:192 `detect_embedding_dimension`. */
  async detectEmbeddingDimension(): Promise<number> {
    const embeddings = await this._runtime.callMultimodalEmbeddingApi([MultimodalInputBuilder.text('test')]);
    const first = embeddings[0];
    if (first === undefined) throw AppError.configuration('无法检测嵌入模型输出维度');
    return first.length;
  }

  /** multimodal/embedding_service.rs:209 `get_model_version`. */
  async getModelVersion(): Promise<string> {
    const config = await this._runtime.getVlEmbeddingModelConfig();
    return `${config.model}@${config.id}`;
  }

  /** multimodal/embedding_service.rs:215 `embed_single`. */
  async embedSingle(input: MultimodalInput): Promise<number[]> {
    const embeddings = await this.embedBatch([input]);
    const first = embeddings[0];
    if (first === undefined) throw AppError.internal('嵌入 API 返回空结果');
    return first;
  }

  /** multimodal/embedding_service.rs:226 `embed_batch`. */
  async embedBatch(inputs: readonly MultimodalInput[]): Promise<number[][]> {
    return this.embedBatchWithProgress(inputs);
  }

  /** multimodal/embedding_service.rs:231 `embed_batch_with_progress`. */
  async embedBatchWithProgress(inputs: readonly MultimodalInput[], progress?: ProgressSink): Promise<number[][]> {
    const modelConfig = await this._runtime.getVlEmbeddingModelConfig();
    return this.embedBatchWithProgressForConfig(inputs, modelConfig, progress);
  }

  /** multimodal/embedding_service.rs:247 `embed_batch_with_progress_for_config`. */
  async embedBatchWithProgressForConfig(
    inputs: readonly MultimodalInput[],
    modelConfig: MultimodalEmbeddingModelConfig,
    progress?: ProgressSink,
  ): Promise<number[][]> {
    return embedBatchWithProgress(this._runtime, inputs, {
      config: this._config, modelConfig, onProgress: progress, logger: this._logger,
    });
  }

  /** multimodal/embedding_service.rs:421 `embed_pages`. */
  async embedPages(
    pages: readonly (readonly [string, string, string | undefined])[],
    instruction?: string,
  ): Promise<number[][]> {
    return this.embedBatch(pagesToInputs(pages, instruction));
  }

  /** multimodal/embedding_service.rs:512 `generate_summaries_batch_with_progress`. */
  async generateSummariesBatchWithProgress(
    pages: readonly (readonly [string, string, string | undefined])[],
    progress?: ProgressSink,
  ): Promise<string[]> {
    const total = pages.length;
    const completedCounter = { value: 0 };
    const results = new Array<string>(total).fill('');
    let nextIndex = 0;
    const concurrency = Math.max(1, this._config.summary_concurrency);
    this._logger?.info(
      '📝 DeepSeek-OCR 摘要服务：开始为 %d 个页面并行生成摘要（并发数: %d）',
      total, concurrency,
    );

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;
        const [base64, mediaType, existingText] = pages[index]!;
        if (existingText !== undefined && existingText !== '') {
          results[index] = existingText;
          this._logger?.info('  📖 页面 %d 复用已有 OCR（%d 字符），跳过 DeepSeek-OCR 调用', index + 1, existingText.length);
        } else {
          this._logger?.info(
            '  📄 开始生成页面 %d 摘要 (DeepSeek-OCR)... media_type: %s, base64长度: %d 字节',
            index + 1, mediaType, base64.length,
          );
          try {
            const result = await this._runtime.callOcrModelRawPrompt(
              'Convert the document to markdown.',
              [{ mime: mediaType, base64 }],
            );
            results[index] = result.assistantMessage;
            const content = result.assistantMessage;
            const preview = [...content].slice(0, 500).join('');
            const display = [...content].length > 500
              ? `${preview}...(共 ${content.length} 字符)`
              : content;
            this._logger?.info(
              '  ✅ 页面 %d OCR 成功，长度 %d 字符\n--- 摘要内容 ---\n%s\n--- 摘要结束 ---',
              index + 1, content.length, display,
            );
          } catch (error) {
            // Rust logs the failure and uses empty content so one page cannot abort the batch.
            this._logger?.warn(
              '  ⚠️ 页面 %d OCR 失败: %s，使用空内容',
              index + 1, error instanceof Error ? error.message : String(error),
            );
            results[index] = '';
          }
        }
        completedCounter.value += 1;
        progress?.({
          phase: 'summarizing',
          completed: completedCounter.value,
          total,
          current_page: index + 1,
          message: existingText !== undefined && existingText !== ''
            ? `复用已有 OCR: ${completedCounter.value}/${total} 页完成`
            : `DeepSeek-OCR: ${completedCounter.value}/${total} 页完成`,
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
    this._logger?.info('✅ DeepSeek-OCR 摘要服务：完成 %d 个页面的摘要生成', results.length);
    return results;
  }

  /** multimodal/embedding_service.rs:664 `embed_texts_with_progress`. */
  async embedTextsWithProgress(texts: readonly string[], progress?: ProgressSink): Promise<number[][]> {
    const total = texts.length;
    if (total === 0) return [];
    const source = [...texts];
    this._logger?.info('📊 文本嵌入服务：开始为 %d 个文本生成向量', total);
    progress?.({ phase: 'embedding', completed: 0, total, message: `开始文本嵌入: 0/${total} 个` });

    const config = await this._runtime.getEmbeddingModelConfig();
    const maxTokens = new EmbeddingTokenLimits(this._logger).getLimit(config.model);
    const chunker = new EmbeddingChunker(maxTokens, this._logger);
    const needsChunking = source.some(text => chunker.needsChunking(text));

    let embeddings: number[][];
    if (!needsChunking) {
      try {
        embeddings = await this._runtime.callEmbeddingApi(source, config.id);
      } catch (error) {
        throw AppError.internal(`文本嵌入失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this._logger?.info('📊 文本嵌入服务：检测到长文本，启用分块处理');
      const chunkResults = batchChunkTexts(source, chunker);
      const allChunks = chunkResults.flatMap(result => result.chunks);
      this._logger?.info('📊 文本嵌入服务：%d 个文本分为 %d 个块', texts.length, allChunks.length);
      let allEmbeddings: number[][];
      try {
        allEmbeddings = await this._runtime.callEmbeddingApi(allChunks, config.id);
      } catch (error) {
        throw AppError.internal(`文本嵌入失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (allEmbeddings.length !== allChunks.length) {
        throw AppError.internal(`嵌入 API 返回数量不匹配: 期望 ${allChunks.length} 块, 实际 ${allEmbeddings.length}`);
      }
      embeddings = aggregateTextEmbeddings(chunkResults, allEmbeddings, this._logger);
    }

    progress?.({ phase: 'embedding', completed: total, total, message: `文本嵌入完成: ${total}/${total} 个` });
    this._logger?.info('✅ 文本嵌入服务：完成 %d 个文本的向量生成', embeddings.length);
    return embeddings;
  }

  /** multimodal/embedding_service.rs:802 `embed_texts` (5 retry rounds, token limit halves). */
  async embedTexts(texts: readonly string[]): Promise<number[][]> {
    const total = texts.length;
    if (total === 0) return [];
    const source = [...texts];
    this._logger?.info('📊 文本嵌入服务：开始处理 %d 个文本', total);
    const config = await this._runtime.getEmbeddingModelConfig();
    const baseMaxTokens = new EmbeddingTokenLimits(this._logger).getLimit(config.model);
    let currentMaxTokens = baseMaxTokens;
    let lastErrorMsg = '';

    for (let round = 0; round < 5; round += 1) {
      const chunker = new EmbeddingChunker(currentMaxTokens, this._logger);
      const needsChunking = source.some(text => chunker.needsChunking(text));
      try {
        if (!needsChunking && round === 0) {
          const direct = await this._runtime.callEmbeddingApi(source, config.id);
          this._logger?.info(
            '✅ 文本嵌入服务：完成 %d 个文本的向量化，维度 %d',
            direct.length, direct[0]?.length ?? 0,
          );
          return direct;
        }
        if (round > 0) {
          this._logger?.warn(
            '📊 文本嵌入服务：第 %d 轮重试，使用更激进的分块（max_tokens=%d）',
            round + 1, currentMaxTokens,
          );
        } else {
          this._logger?.info('📊 文本嵌入服务：检测到长文本，启用分块处理');
        }
        const chunkResults = batchChunkTexts(source, chunker);
        const allChunks = chunkResults.flatMap(result => result.chunks);
        this._logger?.info(
          '📊 文本嵌入服务：%d 个文本分为 %d 个块（max_tokens=%d）',
          texts.length, allChunks.length, currentMaxTokens,
        );
        const allEmbeddings = await this._runtime.callEmbeddingApi(allChunks, config.id);
        if (allEmbeddings.length !== allChunks.length) {
          throw AppError.internal(`嵌入 API 返回数量不匹配: 期望 ${allChunks.length} 块, 实际 ${allEmbeddings.length}`);
        }
        const aggregated = aggregateTextEmbeddings(chunkResults, allEmbeddings, this._logger);
        this._logger?.info(
          '✅ 文本嵌入服务：完成 %d 个文本的向量化%s，维度 %d',
          aggregated.length,
          round > 0 ? `（第 ${round + 1} 轮重试成功）` : '',
          aggregated[0]?.length ?? 0,
        );
        return aggregated;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isTokenLimit = message.includes('413') || message.includes('Payload Too Large')
          || message.includes('too many tokens') || message.includes('8192 tokens') || message.includes('token limit');
        if (!isTokenLimit || round >= 4) {
          if (round >= 4) {
            this._logger?.error('❌ 文本嵌入服务：已达最大重试次数 %d，放弃: %s', 5, message);
          }
          throw error;
        }
        this._logger?.warn(
          '⚠️ 文本嵌入服务：token 超限错误，准备第 %d 轮重试（当前 max_tokens=%d）: %s',
          round + 2, currentMaxTokens, message,
        );
        currentMaxTokens = Math.max(256, Math.trunc(currentMaxTokens / 2));
        lastErrorMsg = message;
      }
    }
    throw AppError.internal(lastErrorMsg === '' ? '嵌入失败：未知错误' : lastErrorMsg);
  }

  /** multimodal/embedding_service.rs:990 `embed_pages_with_mode_and_progress`. */
  async embedPagesWithModeAndProgress(
    pages: readonly (readonly [string, string, string | undefined])[],
    mode: MultimodalIndexingMode,
    instruction?: string,
    progress?: ProgressSink,
  ): Promise<[number[][], (string | null)[]]> {
    if (pages.length === 0) return [[], []];

    let actualMode = mode;
    if (!await this.isModeAvailable(mode)) {
      if (await this.isModeAvailable('vl_embedding')) {
        if (mode !== 'vl_embedding') {
          this._logger?.warn('⚠️ 请求的模式 %s 不可用（或已弃用），回退到 VLEmbedding', modeDebugName(mode));
        }
        actualMode = 'vl_embedding';
      } else {
        throw AppError.configuration(
          '未配置 VL-Embedding 多模态嵌入模型。请在设置 → 维度管理中配置 VL-Embedding 模型。'
          + '（注：旧的“VL 摘要 + 文本嵌入”方案已弃用。）',
        );
      }
    }
    this._logger?.info('🔄 多模态嵌入服务：使用 %s 模式处理 %d 个页面', modeDebugName(actualMode), pages.length);

    if (actualMode === 'vl_embedding') {
      const embeddings = await this.embedPages(pages, instruction);
      return [embeddings, pages.map(([, , summary]) => summary ?? null)];
    }

    const summaries = await this.generateSummariesBatchWithProgress(pages, progress);
    const embeddings = await this.embedTextsWithProgress(summaries, progress);
    return [embeddings, summaries.map(summary => (summary === '' ? null : summary))];
  }

  /** multimodal/embedding_service.rs:1065 `is_mode_available`. */
  async isModeAvailable(mode: MultimodalIndexingMode): Promise<boolean> {
    if (mode === 'vl_embedding') return this.isVlEmbeddingAvailable();
    return false; // Rust keeps the deprecated VL-summary mode permanently unavailable.
  }
}

/** Rust `{:?}` of `MultimodalIndexingMode` (types.rs:234) prints the variant name, not the serde string. */
function modeDebugName(mode: MultimodalIndexingMode): string {
  return mode === 'vl_embedding' ? 'VLEmbedding' : 'VLSummaryThenTextEmbed';
}

function aggregateTextEmbeddings(
  chunkResults: readonly ChunkResult[],
  allEmbeddings: number[][],
  logger?: PluginLogger,
): number[][] {
  const result: number[][] = [];
  let embeddingIndex = 0;
  for (const chunkResult of chunkResults) {
    const chunkCount = chunkResult.chunks.length;
    if (chunkCount === 0) {
      result.push(new Array(allEmbeddings[0]?.length ?? 1024).fill(0));
    } else if (chunkCount === 1) {
      result.push(allEmbeddings[embeddingIndex]!);
    } else {
      logger?.debug('  文本 %d 聚合 %d 个块的嵌入向量', chunkResult.original_index, chunkCount);
      result.push(EmbeddingChunker.aggregateEmbeddings(
        allEmbeddings.slice(embeddingIndex, embeddingIndex + chunkCount),
        'MeanPooling',
        logger,
      ));
    }
    embeddingIndex += chunkCount;
  }
  return result;
}
