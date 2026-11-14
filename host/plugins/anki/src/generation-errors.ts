/**
 * 把 L02 `singleShotCompletion` 的失败还原成 Rust 两条制卡路径的错误文案。
 *
 * Rust 制卡直接持有 reqwest 请求，文案与 `handle_task_error` 的"超时/截断"终态判据都依赖原文；
 * L02 则用调用方 label 拼接通用文本（`${label} 接口返回错误 …`、`${label} 流式读取中断: …`）。
 * - 流式：`streaming_anki_service.rs:1411-1471`（发送失败、状态码友好文案、180s 空闲、读流失败）；
 *   整体 600s 上限来自 `Client::builder().timeout(600s)`（`:646-647`），超时在读流阶段表现为读流失败。
 * - 非流式：`model2_pipeline.rs:9914-9942`（请求超时/无法连接/状态码 + 响应体/解析失败）。
 */
import { AppError } from '../../../platform/errors/api.ts';
import { statusLine } from '../../../platform/util/http-status.ts';

type TransportFailure =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'send'; detail: string }
  | { kind: 'header-timeout'; seconds: string; detail: string }
  | { kind: 'idle'; detail: string }
  | { kind: 'read'; detail: string }
  | { kind: 'invalid-json'; detail: string };

function errorMessage(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function httpFailure(error: unknown): TransportFailure | null {
  if (typeof error !== 'object' || error === null) return null;
  if ((error as { error_type?: unknown }).error_type !== 'LLM') return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const status = (details as { status?: unknown }).status;
  if (typeof status !== 'number') return null;
  const body = (details as { body?: unknown }).body;
  return { kind: 'http', status, body: typeof body === 'string' ? body : '' };
}

/** 按 `single_shot_stream.ts` / `streaming_service.ts` 的 `${label} …` 文本归类。 */
function classifyMessage(message: string, label: string): TransportFailure | null {
  const prefix = `${label} `;
  if (!message.startsWith(prefix)) return null;
  const rest = message.slice(prefix.length);
  const after = (head: string): string | null => (rest.startsWith(head) ? rest.slice(head.length) : null);
  const send = after('请求失败: ');
  if (send !== null) return { kind: 'send', detail: send };
  const header = /^等待响应头超时（(\d+(?:\.\d+)?)s）$/u.exec(rest);
  if (header !== null) return { kind: 'header-timeout', seconds: header[1]!, detail: rest };
  if (rest.startsWith('流式响应空闲超过') || rest === '读取响应超时') return { kind: 'idle', detail: rest };
  const streamRead = after('流式读取中断: ') ?? after('读取响应失败: ');
  if (streamRead !== null) return { kind: 'read', detail: streamRead };
  if (rest.startsWith('流式响应超过总时长上限')) return { kind: 'read', detail: rest };
  const invalidJson = after('响应不是有效 JSON: ');
  if (invalidJson !== null) return { kind: 'invalid-json', detail: invalidJson };
  return null;
}

function classify(error: unknown, label: string): TransportFailure | null {
  const http = httpFailure(error);
  if (http !== null) return http;
  const message = errorMessage(error);
  return message === null ? null : classifyMessage(message, label);
}

/** `streaming_anki_service.rs:1427-1433` 的状态码友好文案。 */
function streamingStatusMessage(status: number): string {
  if (status === 401) return 'API 认证失败，请检查 API 密钥配置';
  if (status === 403) return 'API 访问被拒绝，请检查账户权限';
  if (status === 429) return 'API 请求过于频繁，请稍后重试';
  if (status >= 500 && status <= 599) return 'AI 服务暂时不可用，请稍后重试';
  return 'AI API 请求失败，请检查网络连接或 API 配置';
}

function streamingFailureError(failure: TransportFailure): AppError | null {
  switch (failure.kind) {
    case 'http':
      return AppError.llm(`${streamingStatusMessage(failure.status)} (HTTP ${failure.status})`);
    case 'send':
      return AppError.network(`AI请求失败: ${failure.detail}`);
    case 'header-timeout':
      // Rust 只有 600s 整体超时，发送阶段超时走 `AI请求失败` 且不带"超时"，任务记 Failed。
      return AppError.network(`AI请求失败: 等待响应头超过 ${failure.seconds}s`);
    case 'idle':
      return AppError.network('AI响应超时');
    case 'read':
      return AppError.network(`读取AI响应流失败: ${failure.detail}`);
    case 'invalid-json':
      return null;
  }
}

/**
 * 流式制卡：`singleShotCompletion` 抛出的错误 → Rust 文案；未识别的错误原样返回。
 * HTTP 失败按 Rust 只把友好文案交给前端，脱敏后的响应体写日志（`[ANKI_API_ERROR]`）。
 */
export function streamingCardError(
  error: unknown,
  label: string,
  logError: (message: string) => void,
): unknown {
  const failure = classify(error, label);
  if (failure === null) return error;
  if (failure.kind === 'http') {
    logError(`[ANKI_API_ERROR] HTTP ${failure.status} - 详细错误: ${failure.body}`);
  }
  return streamingFailureError(failure) ?? error;
}

/** 流式制卡：已交付增量后中断（`completion.interrupted`）→ Rust 文案。 */
export function streamingInterruptedError(interrupted: string, label: string): Error | AppError {
  const failure = classifyMessage(interrupted, label);
  const mapped = failure === null ? null : streamingFailureError(failure);
  return mapped ?? new Error(interrupted);
}

function nonStreamFailureError(failure: TransportFailure): AppError {
  switch (failure.kind) {
    case 'http':
      return AppError.llm(`Anki制卡API请求失败: ${statusLine(failure.status)} - ${failure.body}`);
    case 'send':
      if (/timed out|timeout|超时/iu.test(failure.detail)) {
        return AppError.network(`Anki制卡API请求超时: ${failure.detail}`);
      }
      if (/connect/iu.test(failure.detail)) {
        return AppError.network(`无法连接到 Anki 制卡 API 服务器: ${failure.detail}`);
      }
      return AppError.network(`Anki制卡API请求失败: ${failure.detail}`);
    case 'header-timeout':
      return AppError.network(`Anki制卡API请求超时: ${failure.detail}`);
    case 'idle':
    case 'read':
    case 'invalid-json':
      return AppError.llm(`解析 Anki 制卡响应失败: ${failure.detail}`);
  }
}

/** 非流式制卡：`singleShotCompletion` 抛出的错误 → Rust 文案；未识别的错误原样返回。 */
export function nonStreamCardError(error: unknown, label: string): unknown {
  const failure = classify(error, label);
  return failure === null ? error : nonStreamFailureError(failure);
}

/** 非流式制卡：传输在交付部分内容后中断。Rust 一次读完整个响应体，读失败即解析失败。 */
export function nonStreamInterruptedError(interrupted: string, label: string): AppError {
  const failure = classifyMessage(interrupted, label);
  return failure === null
    ? AppError.llm(`Anki制卡API请求失败: ${interrupted}`)
    : nonStreamFailureError(failure);
}
