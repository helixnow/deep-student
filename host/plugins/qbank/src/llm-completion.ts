/**
 * L02 `llmStreaming.singleShotCompletion` 驱动的 qbank 评判传输。
 *
 * 与 Rust `qbank_grading/pipeline.rs::stream_grade` 对齐的部分：
 * - 请求体（system/user、图片清单与 image_url、temperature 0.3、max_tokens、stream）
 * - 用 `GradingStreamState` 记录 finish_reason/usage/字符数/HTTP 错误并决定终态
 * - 取消通过 `request_cancel_stream` 的订阅信号传入传输层
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { AppError as AppErrorValue, JsonValue } from '../../../platform/errors/api.ts';
import {
  applyReasoningConfig, defaultSingleShotOptions,
  type ApiConfig, type LLMManager, type LlmStreamingService,
} from '../../llm/api.ts';
import { GradingStreamState } from './grading-stream.ts';

export interface StreamingGradeImage {
  base64: string;
  mime: string;
  label: string;
}

export interface StreamingGradeInput {
  config: ApiConfig;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  eventName: string;
  images: readonly StreamingGradeImage[];
  stream: GradingStreamState;
  onChunk: (chunk: string) => void;
}

export interface StreamingGradeResult {
  content: string;
  error: AppErrorValue | null;
}

/** Rust `effective_max_tokens`。 */
function effectiveMaxTokens(maxOutputTokens: number, maxTokensLimit: number | null): number {
  const requested = maxOutputTokens > 0 ? maxOutputTokens : 8192;
  return maxTokensLimit !== null && maxTokensLimit > 0
    ? Math.min(requested, maxTokensLimit) : requested;
}

function gradingMessages(systemPrompt: string, userPrompt: string,
  images: readonly StreamingGradeImage[], multimodal: boolean): JsonValue {
  if (!multimodal || images.length === 0) {
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }
  const manifest = images
    .map((image, index) => `图${index + 1}：${image.label}`)
    .join('\n');
  const parts: JsonValue[] = [{
    type: 'text',
    text: '【附图】以下图片按顺序提供（题干配图/共享材料配图/学生作答图）：\n'
      + `${manifest}\n请先阅读与题目、材料相关的图片；若含学生手写作答，先逐条誊写识别内容再评判。`,
  }];
  for (const image of images) {
    const mime = image.mime.trim() === '' ? 'image/jpeg' : image.mime;
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${image.base64}` } });
  }
  parts.push({ type: 'text', text: userPrompt });
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts },
  ];
}

export function buildGradingRequestBody(input: {
  config: ApiConfig; systemPrompt: string; userPrompt: string;
  images: readonly StreamingGradeImage[];
}): { [key: string]: JsonValue } {
  const body: { [key: string]: JsonValue } = {
    model: input.config.model,
    messages: gradingMessages(input.systemPrompt, input.userPrompt, input.images,
      input.config.isMultimodal),
    temperature: 0.3,
    max_tokens: effectiveMaxTokens(input.config.maxOutputTokens, input.config.maxTokensLimit),
    stream: true,
  };
  applyReasoningConfig(body, input.config, null);
  return body;
}

function detailsOf(error: AppErrorValue): Record<string, unknown> | null {
  return error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown> : null;
}

function asAppError(error: unknown): AppErrorValue {
  // L02 的 CommandError 包装了真实 AppError；按 21a99cc47 的做法解包，避免把
  // 配置/Database 错误降级成 LLM 错误。
  if (error instanceof CommandError) return error.value as AppErrorValue;
  if (error !== null && typeof error === 'object' && 'error_type' in error) {
    return error as AppErrorValue;
  }
  return AppError.llm(error instanceof Error ? error.message : String(error));
}

export async function runSingleShotGrading(llm: LLMManager, streaming: LlmStreamingService,
  input: StreamingGradeInput): Promise<StreamingGradeResult> {
  const body = buildGradingRequestBody(input);
  let content = '';
  let cancel: AbortSignal | null = null;
  try {
    if (await llm.consumePendingCancel(input.eventName)) {
      // Rust stream_grade 把取消失败作为 Err 传播；不能当作成功让调用方落正式成绩。
      return { content, error: input.stream.complete(true, null) };
    }
    cancel = await llm.subscribeCancelStream(input.eventName);
    const completion = await streaming.singleShotCompletion(
      input.config, body, input.apiKey, input.eventName, '评判请求构建失败',
      { ...defaultSingleShotOptions(`AI评判(${input.config.model})`),
        // Rust qbank stream_grade：建连/首包 120 秒、空闲 120 秒，没有整条流的总时限。
        headerTimeoutMs: 120_000, idleTimeoutMs: 120_000,
        // L02 的 20 分钟总时限会截断 Rust 允许的持续输出；用 24 小时表达“无总时限”
        // 同时避免 Node 定时器 32 位溢出。
        totalTimeoutMs: 24 * 60 * 60_000,
        // Rust qbank stream_grade 每次点击只发一次请求；L02 默认 maxRetries=2 会重复计费/重复投递。
        maxRetries: 0, cancel },
      delta => {
        content += delta;
        input.onChunk(delta);
        return true;
      });
    if (completion.aborted) {
      // `onDelta` 返回 false 只停止投递；已收到的完整 verdict 仍不能越过取消失败落库。
      return { content, error: input.stream.complete(true, null) };
    }
    if (completion.mode === 'nonStream') {
      // Rust stream_grade 只解析 SSE；L02 会在供应商拒绝 stream 时自动回退非流式。
      // 这条回退会把整段 JSON 当成成功内容，Rust 却会因没有 delta/终态而报
      // “响应异常中断”。不把回退结果当正式成绩。
      return { content, error: input.stream.complete(false, null) };
    }
    input.stream.diagnostics.finish_reason = completion.finishReason;
    input.stream.diagnostics.usage = completion.usage;
    input.stream.diagnostics.http_status = 200;
    input.stream.diagnostics.response_chars = Array.from(completion.content).length;
    // L02 `SingleShotCompletion` 只发布 UTF-8 字节数，没有推理文本或字符数；
    // Rust 的 reasoning_chars 是字符数。单位不可换算前保留 0，缺口登记在 BLOCKERS。
    input.stream.diagnostics.reasoning_chars = 0;
    if (completion.interrupted !== null) {
      return { content, error: input.stream.complete(false, AppError.llm(completion.interrupted)) };
    }
    // L02 正常返回等价于收到 [DONE]；finish_reason 可能为空。
    input.stream.markDone();
    return { content, error: input.stream.complete(false, null) };
  } catch (error) {
    const appError = asAppError(error);
    if (cancel?.aborted === true || await llm.consumePendingCancel(input.eventName)) {
      // 同上：取消状态必须带非空 error 返回，交由 practice-grading-queue 记录失败草稿。
      return { content, error: input.stream.complete(true, null) };
    }
    const details = detailsOf(appError);
    const status = details?.status;
    if (typeof status === 'number') {
      const responseBody = typeof details?.body === 'string' ? details.body : appError.message;
      input.stream.httpError(status, responseBody);
      return { content, error: input.stream.complete(false, null) };
    }
    return { content, error: input.stream.complete(false, appError) };
  } finally {
    if (cancel !== null) await llm.clearCancelStream(input.eventName);
  }
}
