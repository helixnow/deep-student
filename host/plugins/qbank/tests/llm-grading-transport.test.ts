import { describe, expect, it } from 'vitest';
import { AppError } from '../../../platform/errors/api.ts';
import type { ApiConfig, LLMManager, LlmStreamingService } from '../../llm/api.ts';
import type { Question } from '../api.ts';
import { GradingContext } from '../src/grading-context.ts';
import type { ImageAnswerSourceHost } from '../src/grading-images.ts';
import { GradingStreamState } from '../src/grading-stream.ts';
import { buildGradingRequestBody, runSingleShotGrading } from '../src/llm-completion.ts';
import { llmPracticeGrader } from '../src/llm-grader.ts';
import type { PracticeGradingRequest } from '../src/practice-grading-queue.ts';

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: 'cfg-test', model: 'test-reasoner', apiKey: 'enc-key', isMultimodal: true,
    isEmbedding: false, isReranker: false, enabled: true, maxOutputTokens: 128000,
    maxTokensLimit: 64000, maxCompletionTokens: null, temperature: 0.7,
    baseUrl: 'https://api.openai.com/v1', name: 'test', vendorId: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    isReasoning: false, isImageGeneration: false, modelAdapter: '', supportsTools: false,
    geminiApiVersion: '', isBuiltin: false, isReadOnly: false, reasoningEffort: null,
    reasoningMode: null, thinkingEnabled: false, thinkingBudget: null, includeThoughts: false,
    minP: null, topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: false,
    ...overrides,
  } as unknown as ApiConfig;
}

function fakeLlm(overrides: Partial<LLMManager> = {}): LLMManager {
  const controller = new AbortController();
  return {
    consumePendingCancel: async () => false,
    subscribeCancelStream: async () => controller.signal,
    clearCancelStream: async () => undefined,
    ...overrides,
  } as unknown as LLMManager;
}

function completion(content: string, overrides: Record<string, unknown> = {}) {
  return {
    content, reasoningBytes: 12, finishReason: 'stop', usage: { completion_tokens: 10 },
    mode: 'stream', attempts: 1, interrupted: null, aborted: false, ...overrides,
  } as unknown as Awaited<ReturnType<LlmStreamingService['singleShotCompletion']>>;
}

describe('qbank_grading/pipeline.rs stream transport', () => {
  it('builds_multimodal_request_with_manifest_and_configured_budget', () => {
    const body = buildGradingRequestBody({
      config: config(),
      systemPrompt: 'judge',
      userPrompt: 'question text',
      images: [
        { base64: 'AAAA', mime: 'image/png', label: '题干配图' },
        { base64: 'BBBB', mime: 'image/jpeg', label: '学生作答图 1' },
      ],
    });
    expect(body.model).toBe('test-reasoner');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(64000);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.role).toBe('system');
    const parts = messages[1]!.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(4);
    expect((parts[0]!.text as string)).toContain('图1：题干配图');
    expect((parts[0]!.text as string)).toContain('图2：学生作答图 1');
    expect(parts[1]!.image_url).toEqual({ url: 'data:image/png;base64,AAAA' });
    expect(parts[2]!.image_url).toEqual({ url: 'data:image/jpeg;base64,BBBB' });
    expect(parts[3]!.text).toBe('question text');
  });

  it('maps_single_shot_completion_into_grading_diagnostics', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedOptions: Record<string, unknown> | null = null;
    const streaming = {
      async singleShotCompletion(_config: ApiConfig, body: Record<string, unknown>,
        _apiKey: string | null, _session: string | null, _context: string,
        opts: Record<string, unknown>, onDelta?: (delta: string) => boolean) {
        capturedBody = body;
        capturedOptions = opts;
        onDelta?.('Draft <verdict>');
        onDelta?.('correct</verdict>');
        return completion('Draft <verdict>correct</verdict>');
      },
    } as unknown as LlmStreamingService;
    const stream = new GradingStreamState({ id: 'cfg-test', model: 'test-reasoner',
      max_output_tokens: 128000, max_tokens_limit: 64000 });
    const chunks: string[] = [];
    const result = await runSingleShotGrading(fakeLlm(), streaming, {
      config: config(), apiKey: 'key', systemPrompt: 'judge', userPrompt: 'q',
      eventName: 'qbank_grading_stream_s1', images: [], stream,
      onChunk: chunk => chunks.push(chunk),
    });
    expect(result.error).toBeNull();
    expect(result.content).toBe('Draft <verdict>correct</verdict>');
    expect(chunks).toEqual(['Draft <verdict>', 'correct</verdict>']);
    expect(capturedBody).toMatchObject({ model: 'test-reasoner', max_tokens: 64000, stream: true });
    // Rust qbank stream_grade 单次请求；L02 的默认 maxRetries=2 不能带入。
    expect(capturedOptions).toMatchObject({ maxRetries: 0 });
    // Rust 只有 120 秒 header/idle 上限，没有 20 分钟总时限。
    expect(capturedOptions).toMatchObject({ headerTimeoutMs: 120_000, idleTimeoutMs: 120_000 });
    expect(capturedOptions!.totalTimeoutMs).toBeGreaterThan(20 * 60_000);
    // L02 只提供 reasoningBytes，不能把它当 reasoning_chars；字符数缺口登记在 BLOCKERS。
    expect(stream.diagnostics).toMatchObject({
      status: 'completed', finish_reason: 'stop', usage: { completion_tokens: 10 },
      response_chars: 32, reasoning_chars: 0, http_status: 200, error_message: null,
    });
  });

  it('non_stream_fallback_is_not_accepted_as_a_grading_result', async () => {
    const streaming = {
      async singleShotCompletion(_config: ApiConfig, _body: Record<string, unknown>,
        _apiKey: string | null, _session: string | null, _context: string,
        _opts: unknown, onDelta?: (delta: string) => boolean) {
        onDelta?.('Feedback <verdict>correct</verdict> <score value="100" />');
        return completion('Feedback <verdict>correct</verdict> <score value="100" />',
          { mode: 'nonStream' });
      },
    } as unknown as LlmStreamingService;
    const stream = new GradingStreamState({ id: 'cfg-test', model: 'test-reasoner',
      max_output_tokens: 128000, max_tokens_limit: 64000 });
    const result = await runSingleShotGrading(fakeLlm(), streaming, {
      config: config(), apiKey: 'key', systemPrompt: 'judge', userPrompt: 'q',
      eventName: 'qbank_grading_stream_nonstream', images: [], stream,
      onChunk: () => undefined,
    });
    // Rust 只解析 SSE；L02 的非流式回退不能被当成正式判分。
    expect(result.content).toContain('<verdict>correct</verdict>');
    expect(result.error).not.toBeNull();
    expect(stream.diagnostics.status).toBe('incomplete');
  });

  it('unwraps_command_error_from_llm_layers', async () => {
    const { CommandError } = await import('../../../kernel/api.ts');
    const streaming = {
      async singleShotCompletion() {
        throw new CommandError(AppError.configuration('模型未配置'));
      },
    } as unknown as LlmStreamingService;
    const stream = new GradingStreamState({ id: 'cfg-test', model: 'test-reasoner' });
    const result = await runSingleShotGrading(fakeLlm(), streaming, {
      config: config(), apiKey: 'key', systemPrompt: 'judge', userPrompt: 'q',
      eventName: 'qbank_grading_stream_command_error', images: [], stream,
      onChunk: () => undefined,
    });
    expect(result.error).toMatchObject({ error_type: 'Configuration', message: '模型未配置' });
    expect(stream.diagnostics.status).toBe('configuration_error');
  });

  it('reports_cancelled_stream_as_failure_not_success', async () => {
    const controller = new AbortController();
    controller.abort();
    const streaming = {
      async singleShotCompletion() {
        throw AppError.llm('AI评判(test-reasoner) 请求已取消');
      },
    } as unknown as LlmStreamingService;
    const stream = new GradingStreamState({ id: 'cfg-test', model: 'test-reasoner',
      max_output_tokens: 128000, max_tokens_limit: 64000 });
    const result = await runSingleShotGrading(fakeLlm({
      subscribeCancelStream: async () => controller.signal,
    }), streaming, {
      config: config(), apiKey: 'key', systemPrompt: 'judge', userPrompt: 'q',
      eventName: 'qbank_grading_stream_s2', images: [], stream, onChunk: () => undefined,
    });
    // Rust stream.rs:151-155 的取消失败必须传播；否则调用方会把 error:null 当成功落正式成绩。
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain('AI 批改已取消');
    expect(stream.diagnostics.status).toBe('cancelled');
  });

  it('complete_verdict_followed_by_cancel_is_reported_as_failure', async () => {
    const controller = new AbortController();
    const streaming = {
      async singleShotCompletion(_config: ApiConfig, _body: Record<string, unknown>,
        _apiKey: string | null, _session: string | null, _context: string,
        _opts: unknown, onDelta?: (delta: string) => boolean) {
        onDelta?.('Feedback <verdict>correct</verdict> <score value="100" />');
        controller.abort();
        throw AppError.llm('AI评判(test-reasoner) 请求已取消');
      },
    } as unknown as LlmStreamingService;
    const stream = new GradingStreamState({ id: 'cfg-test', model: 'test-reasoner',
      max_output_tokens: 128000, max_tokens_limit: 64000 });
    const result = await runSingleShotGrading(fakeLlm({
      subscribeCancelStream: async () => controller.signal,
    }), streaming, {
      config: config(), apiKey: 'key', systemPrompt: 'judge', userPrompt: 'q',
      eventName: 'qbank_grading_stream_cancel_after_verdict', images: [], stream,
      onChunk: () => undefined,
    });
    // 已经有完整 verdict，但取消仍必须让调用方看到非空 error，practice-grading-queue 只记录失败草稿。
    expect(result.content).toContain('<verdict>correct</verdict>');
    expect(result.error).not.toBeNull();
    expect(stream.diagnostics.status).toBe('cancelled');
  });

  it('maps_http_failures_to_provider_error', async () => {
    const streaming = {
      async singleShotCompletion() {
        throw AppError.with_details('LLM', '评判接口返回错误 500', {
          status: 500, body: '{"error":{"message":"boom"}}',
        });
      },
    } as unknown as LlmStreamingService;
    const stream = new GradingStreamState({ id: 'cfg-test', model: 'test-reasoner',
      max_output_tokens: 128000, max_tokens_limit: 64000 });
    const result = await runSingleShotGrading(fakeLlm(), streaming, {
      config: config(), apiKey: 'key', systemPrompt: 'judge', userPrompt: 'q',
      eventName: 'qbank_grading_stream_s3', images: [], stream, onChunk: () => undefined,
    });
    expect(result.error).not.toBeNull();
    expect(stream.diagnostics).toMatchObject({
      status: 'provider_error', http_status: 500, finish_reason: null,
    });
    expect(stream.diagnostics.error_message).toContain('HTTP 500: boom');
  });

  it('practice_grader_unwraps_command_error_from_model_config_lookup', async () => {
    const { CommandError } = await import('../../../kernel/api.ts');
    const llm = {
      ...fakeLlm(),
      getModelAssignments: async () => ({ qbank_ai_grading_model_config_id: null }),
      getModel2Config: async () => { throw new CommandError(AppError.configuration('题库评判模型未配置')); },
    } as unknown as LLMManager;
    const question = {
      id: 'q1', exam_id: 'e1', content: '简答', question_type: 'short_answer',
      question_label: null, options: null, structured_data: null, answer: '答案',
      explanation: null, images: [], materials: [],
    } as unknown as Question;
    const context = GradingContext.fromQuestion(question);
    context.materials = [];
    const grader = llmPracticeGrader({
      llm: () => llm,
      streaming: () => ({}) as unknown as LlmStreamingService,
      images: () => undefined,
    });
    await expect(grader.grade({
      jobId: 'job1', attemptId: 'a1', question, answer: '我的答案', context, imageAnswer: null,
    })).rejects.toMatchObject({
      appError: { error_type: 'Configuration', message: '题库评判模型未配置' },
    });
  });

  it('practice_grader_reads_question_images_and_sends_them_to_the_model', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const streaming = {
      async singleShotCompletion(_config: ApiConfig, body: Record<string, unknown>,
        _apiKey: string | null, _session: string | null, _context: string,
        _opts: unknown, onDelta?: (delta: string) => boolean) {
        capturedBody = body;
        onDelta?.('Feedback <verdict>correct</verdict> <score value="100" />');
        return completion('Feedback <verdict>correct</verdict> <score value="100" />');
      },
    } as unknown as LlmStreamingService;
    const llm = {
      ...fakeLlm(),
      getModelAssignments: async () => ({ qbank_ai_grading_model_config_id: null }),
      getModel2Config: async () => config(),
      decryptApiKey: async (key: string) => key,
    } as unknown as LLMManager;
    const question = {
      id: 'q1', exam_id: 'e1', content: '看图作答', question_type: 'short_answer',
      question_label: null, options: null, structured_data: null, answer: '答案',
      explanation: null, images: [
        { id: 'img1', name: 'one.png', mime: 'image/png', role: 'question' },
        { id: 'img2', name: 'two.jpg', mime: 'image/jpeg', role: 'question' },
      ], materials: [],
    } as unknown as Question;
    const context = GradingContext.fromQuestion(question);
    context.materials = [];
    const request: PracticeGradingRequest = {
      jobId: 'job1', attemptId: 'a1', question, answer: '我的答案', context, imageAnswer: null,
    };
    const contents: Record<string, string> = { img1: 'PNGDATA', img2: 'JPGDATA' };
    const reviewed: string[] = [];
    const host = {
      db: {}, blobsDir: '/tmp/blobs',
      vfsRepo: {
        attachments: {
          getContentBounded(_db: unknown, _dir: string, id: string) {
            reviewed.push(id);
            return contents[id] ?? null;
          },
        },
      },
    } as unknown as ImageAnswerSourceHost;
    const grader = llmPracticeGrader({
      llm: () => llm,
      streaming: () => streaming,
      images: () => host,
    });
    const response = await grader.grade(request);
    expect(response).toMatchObject({ verdict: 'correct', score: 100 });
    expect(reviewed).toEqual(['img1', 'img2']);
    const parts = ((capturedBody!.messages as Array<{ content: unknown }>)[1]!.content) as Array<Record<string, unknown>>;
    expect((parts[0]!.text as string)).toContain('题干配图');
    expect(parts.filter(part => part.type === 'image_url')).toHaveLength(2);
  });
});
