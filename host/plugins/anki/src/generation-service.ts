/**
 * Anki 生成主流程（`LLMManager::generate_anki_cards_from_document` +
 * `StreamingAnkiService::process_task_and_generate_cards_stream`）。
 *
 * 本模块只消费 L02 已发布的 `llm`（配置读取 / 解密）与 `llmStreaming`
 * （`singleShotCompletion`）服务；请求准备、鉴权、SSE 解析与取消由 L02 负责，
 * 本 lane 负责 prompt、协议、切卡、入库、事件、统计、critic 与收尾。
 *
 * Rust 对应：
 * - `dstu-llm/src/llm_manager/model2_pipeline.rs:9799-10095`
 * - `dstu-anki/src/streaming_anki_service.rs:662-1050,1276-1900,3294-3475`
 */
import type { AnkiCard, DocumentTask, TaskStatus } from '../../../../contracts/ipc/generated/_shared.ts';
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type {
  ApiConfig,
  LlmAnkiRouting,
  LLMManager,
  LlmRawPrompt,
  LlmStreamingService,
} from '../../llm/api.ts';
import {
  applyReasoningConfig,
  defaultSingleShotOptions,
  parseRoutingMode,
  planRouting,
  resolveQuirks,
} from '../../llm/api.ts';
import type { NativeRegex } from '../../../platform/native/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import {
  buildResponseFormat,
  decodeAnkiGenerationOptions,
  detectSchemaCapability,
  isProbablyStructuredOutputRejection,
  isStructuredProtocol,
  qaPassEnabled,
  resolveOutputProtocol,
  stripWrapperPrefix,
  structuredOutputOptionsFromOptionsJson,
  type OutputProtocol,
} from './anki-protocol.ts';
import type { AnkiLogger } from './logger.ts';
import {
  CANCELLED_BY_USER_MSG,
  QA_FLAGS_FIELD,
  UNREADABLE_FRAGMENT_MSG,
  buildPrompt,
  compactOutputBudget,
  defaultStreamStats,
  errorCardContent,
  extractCardFromBufferImpl,
  statsHasAnySignal,
  stripModelSpecialTokens,
  type PromptPayload,
  type StreamStats,
  type StreamingAnkiService,
} from './streaming-anki.ts';
import { extractOcclusionDraftFields, OCCLUSION_FIELD } from './image-occlusion.ts';
import { DocumentProcessingService } from './document-processing.ts';
import type { AnkiEventWindow } from './enhanced-service.ts';
import { cleanAnkiJsonResponse, parseAnkiCardsWithFallback } from './generation-cards-json.ts';
import {
  nonStreamCardError,
  nonStreamInterruptedError,
  streamingCardError,
  streamingInterruptedError,
} from './generation-errors.ts';
import { runGenerationCritic } from './generation-critic.ts';
import { DeltaQueue } from './delta-queue.ts';
import {
  completeTaskSuccessfully,
  emitErrorCard,
  emitGenerationStats,
  emitGenerationWarning,
  emitNewCard,
  updateTaskStatus,
} from './generation-events.ts';

export { cleanAnkiJsonResponse, parseAnkiCardsWithFallback } from './generation-cards-json.ts';

/** `prompt_contracts::LATEX_OUTPUT_BRIEF`。 */
const LATEX_OUTPUT_BRIEF =
  '数学/化学公式必须用 LaTeX 书写并以 $...$（行内）或 $$...$$（块级）包裹，分隔符成对闭合；禁止裸写公式（如 10^5、\\frac），禁止使用 \\(...\\) 或 \\[...\\]，禁止用代码块包裹公式。';

/** `get_fallback_prompt("anki_generation")`。 */
const ANKI_GENERATION_FALLBACK_PROMPT =
  '请根据以下学习内容，生成适合制作Anki卡片的问题和答案对。每张卡片应测试一个单一的概念。卡片内容（front/back/tags）的语言必须与学习材料一致：英文材料生成英文卡片，中文材料生成中文卡片，不要翻译。请以JSON数组格式返回结果，每个对象必须包含 "front" (字符串), "back" (字符串), "tags" (字符串数组) 三个字段。'
  + '\n\n'
  + LATEX_OUTPUT_BRIEF;

const LOG_PREFIX = '[ANKI_GENERATION]';

export interface AnkiGenerationServiceDeps {
  db: DatabaseHandle;
  llm: Pick<LLMManager, 'getApiConfigs' | 'getModelAssignments' | 'decryptApiKey' | 'getModel2Config'>;
  streaming: LlmStreamingService;
  regex: Pick<NativeRegex, 'compile' | 'isMatch'>;
  logger: AnkiLogger;
  /** L02 `llmAnkiRouting`；缺失时保持旧单模型路径。 */
  routing?: LlmAnkiRouting | null;
  /** L02 `llmRawPrompt`（critic 的 `call_anki_routed_raw_prompt`）；缺失时 critic 降级为“模型调用失败”。 */
  rawPrompt?: LlmRawPrompt | null;
}

/** AppError 值或 Error 的 message（`e.message` 语义）。 */
export function generationErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 运行句柄是否已 abort（经函数读取，避免 TS 把 signal 状态错误收窄为常量）。 */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function errorIsCancellation(error: unknown): boolean {
  return generationErrorMessage(error).includes(CANCELLED_BY_USER_MSG);
}

/** Rust `effective_max_tokens`（`model2_pipeline.rs`）。 */
function effectiveMaxTokens(maxOutputTokens: number, maxTokensLimit: number | null): number {
  const requested = maxOutputTokens > 0 ? maxOutputTokens : 8192;
  return maxTokensLimit !== null && maxTokensLimit > 0
    ? Math.min(requested, maxTokensLimit)
    : requested;
}

interface StreamErrorState {
  fatal: unknown | null;
}

/** 生产生成服务。一个实例可处理多个任务；所有状态按任务隔离。 */
export class AnkiGenerationService {
  readonly db: DatabaseHandle;
  readonly llm: AnkiGenerationServiceDeps['llm'];
  readonly streaming: LlmStreamingService;
  readonly stream: StreamingAnkiService;
  readonly logger: AnkiLogger;
  readonly routing: LlmAnkiRouting | null;
  readonly rawPrompt: LlmRawPrompt | null;

  constructor(
    deps: AnkiGenerationServiceDeps,
    streamingAnki: StreamingAnkiService,
  ) {
    this.db = deps.db;
    this.llm = deps.llm;
    this.streaming = deps.streaming;
    this.stream = streamingAnki;
    this.logger = deps.logger;
    this.routing = deps.routing ?? null;
    this.rawPrompt = deps.rawPrompt ?? null;
  }

  // ------------------------------------------------------------------ 配置

  /**
   * `get_anki_model_config`（`llm_manager/mod.rs:7712-7731`）：
   * 非流式三命令使用；错误文案与 Rust 完全一致。
   */
  async getAnkiModelConfig(): Promise<ApiConfig> {
    let assignments;
    try {
      assignments = await this.llm.getModelAssignments();
    } catch (error) {
      throw AppError.configuration(`获取模型分配失败: ${generationErrorMessage(error)}`);
    }
    const ankiModelId = assignments.anki_card_model_config_id;
    if (ankiModelId === null || ankiModelId === undefined) {
      throw AppError.configuration('Anki制卡模型未配置');
    }
    const configs = await this.llm.getApiConfigs();
    const config = configs.find(
      (candidate) => candidate.id === ankiModelId
        && candidate.enabled
        && !candidate.isEmbedding
        && !candidate.isReranker,
    );
    if (config === undefined) {
      throw AppError.configuration('找不到已启用的有效 Anki 制卡模型配置');
    }
    return config;
  }

  /**
   * `StreamingAnkiService::get_configurations`（`streaming_anki_service.rs:975-1027`）。
   *
   * 先经 L02 `llmAnkiRouting` 探测槽位并计算完整路由计划，取 Generator 角色；
   * 槽位/配置不可用时回退 Rust 旧单模型路径，保持原始错误语义。
   */
  async getStreamingConfig(optionsJson: string): Promise<ApiConfig> {
    if (this.routing !== null) {
      try {
        const slots = await this.routing.probeAnkiRoutingSlots();
        const plan = planRouting(parseRoutingMode(optionsJson), slots);
        if (plan !== null) {
          const generator = plan.generator;
          try {
            const configs = await this.llm.getApiConfigs();
            const routed = configs.find(
              (candidate) => candidate.id === generator.configId && candidate.enabled,
            );
            if (routed !== undefined) {
              this.logger.debug(
                `[ANKI_ROUTING] Generator 角色选定模型: id=${generator.configId} `
                + `model=${generator.model} slot=${generator.slot} degraded=${generator.degraded}`,
              );
              return routed;
            }
            this.logger.debug(
              `[ANKI_ROUTING] Generator 槽位配置 ${generator.configId} 已不可用，回退旧单模型路径`,
            );
          } catch (error) {
            this.logger.debug(
              `[ANKI_ROUTING] 读取 API 配置失败，回退旧单模型路径: ${generationErrorMessage(error)}`,
            );
          }
        } else {
          this.logger.debug('[ANKI_ROUTING] 无可用路由槽位，回退旧单模型路径');
        }
      } catch (error) {
        this.logger.debug(
          `[ANKI_ROUTING] 路由探测失败，回退旧单模型路径: ${generationErrorMessage(error)}`,
        );
      }
    }

    let assignments;
    try {
      assignments = await this.llm.getModelAssignments();
    } catch (error) {
      throw AppError.configuration(`获取模型分配失败: ${generationErrorMessage(error)}`);
    }
    const ankiModelId = assignments.anki_card_model_config_id;
    if (ankiModelId === null || ankiModelId === undefined) {
      throw AppError.configuration(
        'Anki制卡模型在模型分配中未配置 (anki_card_model_config_id is None)',
      );
    }
    let configs: ApiConfig[];
    try {
      configs = await this.llm.getApiConfigs();
    } catch (error) {
      throw AppError.configuration(`获取API配置失败: ${generationErrorMessage(error)}`);
    }
    const config = configs.find((candidate) => candidate.id === ankiModelId && candidate.enabled);
    if (config === undefined) {
      throw AppError.configuration(
        `找不到有效的Anki制卡模型配置. Tried to find ID: ${ankiModelId} in ${configs.length} available configs.`,
      );
    }
    return config;
  }

  // ------------------------------------------------------------------ 非流式

  /** `LLMManager::generate_anki_cards_from_document`（`model2_pipeline.rs:9799-9810`）。 */
  async generateAnkiCardsFromDocument(
    documentContent: string,
    subjectName: string,
    options: AnkiGenerationOptions | null,
  ): Promise<AnkiCard[]> {
    this.logger.info(
      `开始生成 Anki 卡片: 科目=${subjectName}, 文档长度=${utf8ByteLength(documentContent)}`,
    );
    const config = await this.getAnkiModelConfig();
    const quirks = resolveQuirks(config);
    const subjectPrompt = ANKI_GENERATION_FALLBACK_PROMPT;
    const finalPrompt = `${subjectPrompt}\n\n文档内容：\n${documentContent}`;

    const configuredMaxTokens = effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit);
    const requestedMaxTokens = options?.max_tokens;
    const maxTokens = requestedMaxTokens !== null && requestedMaxTokens !== undefined
      ? Math.min(
        effectiveMaxTokens(requestedMaxTokens, config.maxTokensLimit),
        configuredMaxTokens,
      )
      : configuredMaxTokens;
    const temperature = options?.temperature ?? 0.3;

    const body: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: 'user', content: finalPrompt }],
      temperature,
    };
    const tokenField = quirks.legacy_max_tokens_field;
    body[tokenField] = maxTokens;
    applyReasoningConfig(body as never, config, null);
    if (quirks.force_json_response_format) {
      body.response_format = { type: 'json_object' };
    }

    const apiKey = await this.llm.decryptApiKey(config.apiKey);
    const label = `Anki 制卡(${config.model})`;
    let completion;
    try {
      completion = await this.streaming.singleShotCompletion(
        config,
        body as never,
        apiKey,
        null,
        'Anki 制卡请求构建失败',
        // model2_pipeline.rs 只发一次请求。
        { ...defaultSingleShotOptions(label), maxRetries: 0 },
      );
    } catch (error) {
      throw nonStreamCardError(error, label);
    }
    if (completion.interrupted !== null) {
      throw nonStreamInterruptedError(completion.interrupted, label);
    }
    this.logger.debug(`Anki 制卡响应长度: ${utf8ByteLength(completion.content)} 字符`);

    const cleaned = cleanAnkiJsonResponse(completion.content);
    this.logger.debug(`清理后的JSON长度: ${utf8ByteLength(cleaned)} 字符`);
    const cards = parseAnkiCardsWithFallback(cleaned, completion.content);
    this.logger.info(`成功生成 ${cards.length} 张ANKI卡片`);
    return cards;
  }

  // ------------------------------------------------------------------ 流式主流程

  /** `process_task_and_generate_cards_stream`（`streaming_anki_service.rs:662-960`）。 */
  async processTaskAndGenerateCardsStream(
    task: DocumentTask,
    window: AnkiEventWindow,
    runSignal?: AbortSignal,
    onReady?: () => void,
  ): Promise<void> {
    const taskId = task.id;
    // Rust 在 `tokio::spawn` 的任务里更新 Processing；让出一次微任务，
    // 保证 trigger 命令返回前不会把任务状态改掉，防重入仍由运行句柄命中。
    await Promise.resolve();
    if (signalAborted(runSignal)) return;
    const processor = new DocumentProcessingService(this.db);
    updateTaskStatus(this.logger, processor, taskId, 'Processing', null, task.segment_index, task.document_id, window);

    let apiConfig: ApiConfig;
    try {
      apiConfig = await this.getStreamingConfig(task.anki_generation_options_json);
    } catch (error) {
      // Rust `JoinHandle::abort` 后配置 future 不会再恢复执行：删除/暂停已 abort
      // 运行句柄时，这里不能补写 Failed/Truncated 或发 TaskProcessingError。
      if (signalAborted(runSignal)) return;
      await this.handleTaskError(processor, taskId, error, window, task.segment_index, task.document_id);
      return;
    }
    // 运行句柄可能在配置 await 期间被删除/暂停路径 abort（Rust JoinHandle::abort）。
    if (signalAborted(runSignal)) return;

    let options: AnkiGenerationOptions;
    try {
      options = decodeAnkiGenerationOptions(task.anki_generation_options_json);
    } catch (error) {
      await this.handleTaskError(
        processor,
        taskId,
        AppError.validation(`解析生成选项失败: ${generationErrorMessage(error)}`),
        window,
        task.segment_index,
        task.document_id,
      );
      return;
    }

    const structuredOptions = structuredOutputOptionsFromOptionsJson(task.anki_generation_options_json);
    const capability = detectSchemaCapability(
      apiConfig.modelAdapter,
      apiConfig.apiProtocol,
      apiConfig.providerType,
      apiConfig.baseUrl,
    );
    const [resolvedProtocol] = resolveOutputProtocol(structuredOptions.output_protocol, capability);
    let protocol: OutputProtocol = resolvedProtocol;

    if ((options.max_cards_total ?? 0) > 0 && options.max_cards_per_mistake <= 0) {
      updateTaskStatus(this.logger, 
        processor,
        taskId,
        'Completed',
        'segment_skipped:no_card_budget',
        task.segment_index,
        task.document_id,
        window,
      );
      return;
    }

    let promptPayload: PromptPayload;
    try {
      promptPayload = buildPrompt(task.content_segment, options, protocol);
    } catch (error) {
      await this.handleTaskError(processor, taskId, error, window, task.segment_index, task.document_id);
      return;
    }

    const configuredMaxTokens = effectiveMaxTokens(apiConfig.maxOutputTokens, apiConfig.maxTokensLimit);
    const maxTokens = options.max_output_tokens_override !== null
      && options.max_output_tokens_override !== undefined
      ? compactOutputBudget(
        options.max_output_tokens_override,
        task.content_segment,
        apiConfig.supportsReasoning,
        configuredMaxTokens,
      )
      : options.max_tokens ?? apiConfig.maxOutputTokens;
    const temperature = options.temperature_override
      ?? options.temperature
      ?? apiConfig.temperature;

    if (signalAborted(runSignal)) return;
    updateTaskStatus(this.logger, processor, taskId, 'Streaming', null, task.segment_index, task.document_id, window);
    const signal = this.stream.registerCancellation(taskId, runSignal);
    // Rust `ready_signal`：取消通道注册完成后回执调度层。
    onReady?.();
    if (signal.aborted) return;
    const stats = defaultStreamStats();

    let result: { error: unknown | null };
    try {
      result = await this.runStreamAttempt({
        task,
        apiConfig,
        promptPayload,
        maxTokens,
        temperature,
        protocol,
        options,
        qaPassEnabled: qaPassEnabled(structuredOptions),
        signal,
        stats,
        window,
      });

      if (
        result.error !== null
        && isStructuredProtocol(protocol)
        && !errorIsCancellation(result.error)
        && isStructuredRejection(result.error)
      ) {
        this.logger.warn(
          `[ANKI_PROTOCOL] 结构化输出请求被拒绝（${generationErrorMessage(result.error)}），回退 delimiter 协议重试一次`,
        );
        protocol = 'delimiter';
        try {
          const fallbackPrompt = buildPrompt(task.content_segment, options, protocol);
          resetStreamStats(stats);
          result = await this.runStreamAttempt({
            task,
            apiConfig,
            promptPayload: fallbackPrompt,
            maxTokens,
            temperature,
            protocol,
            options,
            qaPassEnabled: qaPassEnabled(structuredOptions),
            signal,
            stats,
            window,
          });
        } catch (error) {
          this.logger.warn(
            `[ANKI_PROTOCOL] 回退 delimiter 时重建 prompt 失败，保留原始错误: ${generationErrorMessage(error)}`,
          );
        }
      }
    } finally {
      await this.stream.clearCancelSender(taskId);
    }

    if (result.error === null) {
      emitGenerationStats(this.logger, taskId, task.document_id, stats, window);
      await runGenerationCritic(this, task, stats, window);
      completeTaskSuccessfully(this.logger, processor, taskId, stats, task.document_id, window);
      return;
    }

    if (errorIsCancellation(result.error) || signal.aborted) {
      // 暂停/取消由调度层写 Paused，不要在生成层再写失败终态。
      this.logger.info(`${LOG_PREFIX} 🛑 任务被用户取消，保持暂停态由调度层处理: ${taskId}`);
      return;
    }

    if (statsHasAnySignal(stats)) {
      emitGenerationStats(this.logger, taskId, task.document_id, stats, window);
    }
    await this.handleTaskError(processor, taskId, result.error, window, task.segment_index, task.document_id);
  }

  private async runStreamAttempt(input: {
    task: DocumentTask;
    apiConfig: ApiConfig;
    promptPayload: PromptPayload;
    maxTokens: number;
    temperature: number;
    protocol: OutputProtocol;
    options: AnkiGenerationOptions;
    qaPassEnabled: boolean;
    signal: AbortSignal;
    stats: StreamStats;
    window: AnkiEventWindow;
  }): Promise<{ error: unknown | null }> {
    const body: Record<string, unknown> = {
      model: input.apiConfig.model,
      messages: buildMessages(input.promptPayload),
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      stream: true,
    };
    const responseFormat = buildResponseFormat(input.protocol, input.options);
    if (responseFormat !== null) body.response_format = responseFormat;

    let apiKey: string;
    try {
      apiKey = await this.llm.decryptApiKey(input.apiConfig.apiKey);
    } catch (error) {
      return { error };
    }
    const label = `Anki 流式制卡(${input.apiConfig.model})`;
    const queue = new DeltaQueue();
    const buffer = { text: '' };
    const errorState: StreamErrorState = { fatal: null };
    let reachedCardLimit = false;
    let pendingOcclusionFields = extractOcclusionDraftFields(input.task.content_segment);
    const limit = input.options.max_cards_per_mistake;

    const consume = async (): Promise<void> => {
      for await (const delta of queue) {
        if (input.signal.aborted) return;
        buffer.text += delta;
        if (isStructuredProtocol(input.protocol)) stripWrapperPrefix(buffer);

        for (;;) {
          if (limit > 0 && input.stats.card_count >= limit) {
            reachedCardLimit = true;
            return;
          }
          const extracted = extractCardFromBufferImpl(buffer, this.logger);
          if (extracted === null) break;
          if (!extracted.ok) {
            input.stats.failed_cards += 1;
            try {
              const errorCard = await this.stream.createErrorCard(extracted.truncated, input.task.id);
              emitErrorCard(this.logger, errorCard, input.task.document_id, input.window);
            } catch (error) {
              this.logger.error(`${LOG_PREFIX} 创建错误卡片失败: ${generationErrorMessage(error)}`);
            }
            continue;
          }
          const keepGoing = await this.handleCardPayload(
            extracted.card,
            input,
            () => { pendingOcclusionFields = null; },
            pendingOcclusionFields,
          );
          if (!keepGoing) {
            reachedCardLimit = true;
            return;
          }
        }
      }
    };

    const consumer = consume().catch((error: unknown) => {
      errorState.fatal = error;
      queue.close();
    });

    let completion;
    try {
      completion = await this.streaming.singleShotCompletion(
        input.apiConfig,
        body as never,
        apiKey,
        input.task.id,
        'Anki 流式请求构建失败',
        {
          // streaming_anki_service.rs 只发一次请求；600s 客户端超时同时约束等待响应头。
          ...defaultSingleShotOptions(label),
          headerTimeoutMs: 600_000,
          idleTimeoutMs: 180_000,
          totalTimeoutMs: 600_000,
          maxRetries: 0,
          cancel: input.signal,
        },
        (delta) => {
          if (input.signal.aborted || errorState.fatal !== null || reachedCardLimit) return false;
          queue.push(delta);
          return true;
        },
      );
    } catch (error) {
      queue.close();
      await consumer;
      if (input.signal.aborted || errorIsCancellation(error)) {
        return { error: new Error(CANCELLED_BY_USER_MSG) };
      }
      return { error: streamingCardError(error, label, (message) => this.logger.error(message)) };
    }
    queue.close();
    await consumer;

    if (errorState.fatal !== null) return { error: errorState.fatal };
    if (completion.interrupted !== null) return { error: streamingInterruptedError(completion.interrupted, label) };
    if (input.signal.aborted) return { error: new Error(CANCELLED_BY_USER_MSG) };

    if (!reachedCardLimit) {
      await this.processResidual(
        buffer,
        input,
        pendingOcclusionFields,
        () => { pendingOcclusionFields = null; },
      );
    }
    return { error: null };
  }

  private handleCardPayload(
    cardJson: string,
    input: Parameters<AnkiGenerationService['runStreamAttempt']>[0],
    clearOcclusion: () => void,
    pendingOcclusionFields: ReturnType<typeof extractOcclusionDraftFields>,
  ): Promise<boolean> {
    return this.parseAndSave(cardJson, input, clearOcclusion, pendingOcclusionFields);
  }

  private async parseAndSave(
    cardJson: string,
    input: Parameters<AnkiGenerationService['runStreamAttempt']>[0],
    clearOcclusion: () => void,
    pendingOcclusionFields: ReturnType<typeof extractOcclusionDraftFields>,
    phase: 'stream' | 'residual' = 'stream',
  ): Promise<boolean> {
    try {
      const card = await this.stream.parseAndSaveCard(
        cardJson,
        input.task.id,
        input.task.document_id,
        input.options,
        input.qaPassEnabled,
        pendingOcclusionFields,
      );
      if (card === null) {
        input.stats.duplicate_cards += 1;
        this.logger.debug(`${LOG_PREFIX} 卡片被跳过（重复或不需要保存）`);
        return true;
      }
      if (pendingOcclusionFields !== null && Object.hasOwn(card.extra_fields, OCCLUSION_FIELD)) {
        clearOcclusion();
      }
      input.stats.card_count += 1;
      if (Object.hasOwn(card.extra_fields, QA_FLAGS_FIELD)) input.stats.flagged_cards += 1;
      this.logger.debug(
        `${LOG_PREFIX} 已生成第${input.stats.card_count}张卡片 (上限: ${input.options.max_cards_per_mistake}张)`,
      );
      emitNewCard(this.logger, card, input.task.document_id, input.window);
      return true;
    } catch (error) {
      const message = generationErrorMessage(error);
      if (message.includes(UNREADABLE_FRAGMENT_MSG)) {
        input.stats.dropped_fragments += 1;
        this.logger.warn(
          phase === 'residual'
            ? `[ANKI_CARD_DEBUG] 丢弃流收尾的不可读残片（${Array.from(cardJson).length} 字符）`
            : `[ANKI_CARD_DEBUG] 丢弃不可读残片（${Array.from(cardJson).length} 字符）: ${message}`,
        );
        emitGenerationWarning(this.logger, 
          input.task.id,
          input.task.document_id,
          'unreadable_fragment_dropped',
          cardJson,
          input.window,
        );
        return true;
      }
      if (phase === 'residual') {
        this.logger.debug(`[ANKI_CARD_DEBUG] 流收尾残留缓冲解析失败: ${message}`);
        return false;
      }
      input.stats.failed_cards += 1;
      this.logger.error(`${LOG_PREFIX} 解析卡片失败: ${message} - 原始JSON: ${cardJson}`);
      try {
        const errorCard = await this.stream.createErrorCard(
          errorCardContent(message, cardJson),
          input.task.id,
        );
        emitErrorCard(this.logger, errorCard, input.task.document_id, input.window);
      } catch (createError) {
        this.logger.error(`${LOG_PREFIX} 解析卡片失败且无法创建错误卡: ${generationErrorMessage(createError)}`);
      }
      return true;
    }
  }

  private async processResidual(
    buffer: { text: string },
    input: Parameters<AnkiGenerationService['runStreamAttempt']>[0],
    pendingOcclusionFields: ReturnType<typeof extractOcclusionDraftFields>,
    clearOcclusion: () => void,
  ): Promise<void> {
    const residualRaw = rustTrim(buffer.text);
    const residual = rustTrim(stripModelSpecialTokens(residualRaw));
    if (residual === '' && residualRaw !== '') {
      this.logger.info(
        `${LOG_PREFIX} 流收尾残留仅含模型特殊token，已丢弃（${Array.from(residualRaw).length} 字符）`,
      );
    }
    if (residual === '') return;

    const payloads = this.stream.expandWrapperPayloads(residual);
    for (const payload of payloads) {
      if (payload.truncated) {
        input.stats.failed_cards += 1;
        this.logger.warn(
          `[ANKI_CARD_DEBUG] 流收尾 wrapper 的最后一张卡在字符串中途截断，降级为错误卡（${Array.from(payload.json).length} 字符）`,
        );
        try {
          const errorCard = await this.stream.createErrorCard(
            `卡片在流结束时于字符串中途被截断，内容不完整: ${payload.json}`,
            input.task.id,
          );
          emitErrorCard(this.logger, errorCard, input.task.document_id, input.window);
        } catch {
          // Rust :1721-1738 uses if let Ok: insertion failure stays best-effort.
          continue;
        }
        continue;
      }

      const withinLimit = input.options.max_cards_per_mistake <= 0
        || input.stats.card_count < input.options.max_cards_per_mistake;
      const looksLikeCard = payload.json.includes('{');
      let handled = false;
      if (withinLimit && looksLikeCard) {
        const before = input.stats.failed_cards + input.stats.duplicate_cards
          + input.stats.dropped_fragments + input.stats.card_count;
        handled = await this.parseAndSave(
          payload.json,
          input,
          () => {
            pendingOcclusionFields = null;
            clearOcclusion();
          },
          pendingOcclusionFields,
          'residual',
        );
        const saved = input.stats.failed_cards + input.stats.duplicate_cards
          + input.stats.dropped_fragments + input.stats.card_count;
        handled = handled && saved !== before;
      }
      if (!handled) {
        if (looksLikeCard) {
          input.stats.failed_cards += 1;
          try {
            const errorCard = await this.stream.createErrorCard(payload.json, input.task.id);
            emitErrorCard(this.logger, errorCard, input.task.document_id, input.window);
          } catch {
            // Rust :1804-1806 silently ignores a failed residual error-card insert.
            continue;
          }
        } else {
          this.logger.info(
            `${LOG_PREFIX} 丢弃流收尾的非卡片残留内容（${Array.from(payload.json).length} 字符）`,
          );
        }
      }
    }
  }

  private async handleTaskError(
    processor: DocumentProcessingService,
    taskId: string,
    error: unknown,
    window: AnkiEventWindow,
    segmentIndex: number | null,
    documentId: string | null,
  ): Promise<void> {
    const message = generationErrorMessage(error);
    const status: TaskStatus = message.includes('超时') || message.includes('截断')
      ? 'Truncated' : 'Failed';
    try {
      updateTaskStatus(this.logger, processor, taskId, status, message, segmentIndex, documentId, window);
    } catch (dbError) {
      this.logger.error(
        `写入任务失败状态到数据库失败（仍将派发错误事件）: task=${taskId}, db_err=${generationErrorMessage(dbError)}`,
      );
    }
    try {
      window.emit('anki_generation_event', {
        TaskProcessingError: {
          task_id: taskId,
          error_message: message,
          document_id: documentId,
        },
      });
    } catch (emitError) {
      this.logger.error(`发送任务错误事件失败: ${generationErrorMessage(emitError)}`);
    }
  }
}

function buildMessages(prompt: PromptPayload): unknown[] {
  const messages: unknown[] = [];
  if (prompt.system !== null) messages.push({ role: 'system', content: prompt.system });
  messages.push({ role: 'user', content: prompt.user });
  return messages;
}

function resetStreamStats(stats: StreamStats): void {
  stats.card_count = 0;
  stats.failed_cards = 0;
  stats.duplicate_cards = 0;
  stats.dropped_fragments = 0;
  stats.flagged_cards = 0;
}

/** Rust 判定：错误文本带 `(HTTP 400/404/422)`；L02 同时保留 `details.status`。 */
function isStructuredRejection(error: unknown): boolean {
  if (isProbablyStructuredOutputRejection(generationErrorMessage(error))) return true;
  if (typeof error === 'object' && error !== null && 'details' in error) {
    const details = (error as { details?: unknown }).details;
    if (typeof details === 'object' && details !== null && 'status' in details) {
      const status = (details as { status?: unknown }).status;
      return status === 400 || status === 404 || status === 422;
    }
  }
  return false;
}
