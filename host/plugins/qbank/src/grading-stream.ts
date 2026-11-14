/**
 * 判分流状态：把传输完成状态与可用判分结果分开（qbank_grading/stream.rs）。
 *
 * 供应商错误、截断、取消和 EOF 都不能被正常的 [DONE] 覆盖；诊断状态与错误
 * 文案保留给失败草稿，正式成绩由调用方决定是否落库。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue, ProviderAdapter, StreamEvent } from '../../llm-providers/api.ts';

export type GradingCompletionStatus =
  | 'completed' | 'cancelled' | 'truncated' | 'provider_error'
  | 'transport_error' | 'incomplete' | 'invalid_result' | 'configuration_error'
  | 'persistence_error';

export interface GradingDiagnostics {
  status: GradingCompletionStatus;
  model: string;
  model_config_id: string;
  max_output_tokens: number;
  finish_reason: string | null;
  usage: unknown;
  response_chars: number;
  reasoning_chars: number;
  http_status: number | null;
  error_message: string | null;
}

export interface GradingStreamConfig {
  id?: string;
  model?: string;
  max_output_tokens?: number;
  max_tokens_limit?: number | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function pointer(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('/').slice(1)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else {
      const entry = object(current);
      if (entry === null || !Object.hasOwn(entry, part)) return undefined;
      current = entry[part];
    }
  }
  return current;
}

/**
 * `utils::sse_buffer::extract_stream_data_payload`：拼接同一 block 内所有 data 行；
 * 没有 data 行时接受裸 JSON / [DONE]（[DONE] 不是 JSON，调用方按"无 payload"处理）。
 */
function payloadOf(block: string): unknown {
  const data = block.split('\n')
    .map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter(line => line.startsWith('data:'))
    .map(line => {
      const value = line.slice(5);
      return value.startsWith(' ') ? value.slice(1) : value;
    });
  if (data.length > 0) {
    try {
      return JSON.parse(data.join('\n')) as unknown;
    } catch {
      return null;
    }
  }
  const bare = block.trim();
  if (bare === '' || bare === '[DONE]') return null;
  try {
    return JSON.parse(bare) as unknown;
  } catch {
    return null;
  }
}

function providerMessage(details: unknown): string {
  const candidates = ['/details/message', '/error/message', '/message', '/reason'];
  for (const path of candidates) {
    const value = pointer(details, path);
    if (typeof value === 'string' && value !== '') return value;
  }
  return '供应商拒绝或中断了批改请求';
}

const FINISH_PATHS = [
  '/choices/0/finish_reason', '/delta/stop_reason', '/stop_reason',
  '/response/incomplete_details/reason', '/incomplete_details/reason',
  '/candidates/0/finishReason',
];

const TRUNCATED_REASONS = ['length', 'max_tokens', 'max_output_tokens', 'model_context_window_exceeded'];
const COMPLETED_REASONS = ['stop', 'end_turn', 'stop_sequence', 'STOP', 'completed'];

export class GradingStreamState {
  readonly diagnostics: GradingDiagnostics;
  private done = false;
  private providerError: string | null = null;
  private providerStatus: GradingCompletionStatus = 'provider_error';

  constructor(config: GradingStreamConfig) {
    // ApiConfig serde 默认 max_output_tokens=8192；limit 为 Some 时直接 min（0 也不特判）。
    const maxOutput = config.max_output_tokens ?? 8192;
    const limit = config.max_tokens_limit ?? null;
    this.diagnostics = {
      status: 'incomplete',
      model: config.model ?? '',
      model_config_id: config.id ?? '',
      max_output_tokens: limit === null ? maxOutput : Math.min(maxOutput, limit),
      finish_reason: null,
      usage: null,
      response_chars: 0,
      reasoning_chars: 0,
      http_status: null,
      error_message: null,
    };
  }

  processBlock(adapter: ProviderAdapter, block: string,
    onChunk: (chunk: string) => void): boolean {
    const payload = payloadOf(block);
    if (payload !== null) {
      for (const path of FINISH_PATHS) {
        const reason = pointer(payload, path);
        if (typeof reason === 'string' && reason !== '') {
          this.diagnostics.finish_reason = reason;
          break;
        }
      }
    }
    this.processEvents(adapter.parseStream(block), onChunk);
    return this.done || this.providerError !== null;
  }

  finishAdapter(adapter: ProviderAdapter, onChunk: (chunk: string) => void): void {
    this.processEvents(adapter.finishStream(), onChunk);
  }

  /** L02 `singleShotCompletion` 正常返回等价于收到 `[DONE]`（但不覆盖 finish_reason）。 */
  markDone(): void {
    this.done = true;
  }

  httpError(status: number, body: string): void {
    this.diagnostics.http_status = status;
    let message: string;
    try {
      message = providerMessage(JSON.parse(body) as unknown);
    } catch {
      // A non-JSON body is already the most useful message.
      message = body.slice(0, 2048);
    }
    this.providerError = `HTTP ${status}: ${message}`;
  }

  private processEvents(events: StreamEvent[], onChunk: (chunk: string) => void): void {
    for (const event of events) {
      switch (event.type) {
        case 'ContentChunk': {
          this.diagnostics.response_chars += Array.from(String(event.value)).length;
          onChunk(String(event.value));
          break;
        }
        case 'ReasoningChunk': {
          this.diagnostics.reasoning_chars += Array.from(String(event.value)).length;
          onChunk('');
          break;
        }
        case 'Usage': {
          const previous = object(this.diagnostics.usage);
          const incoming = object(event.value);
          if (previous !== null && incoming !== null) {
            this.diagnostics.usage = { ...previous, ...incoming };
          } else {
            this.diagnostics.usage = event.value;
          }
          break;
        }
        case 'SafetyBlocked': {
          const details = event.value as Record<string, unknown>;
          const kind = typeof details.reason === 'string' ? details.reason : '';
          this.providerStatus = kind === 'response.incomplete' ? 'incomplete' : 'provider_error';
          if (typeof details.reason === 'string' && this.diagnostics.finish_reason === null) {
            this.diagnostics.finish_reason = details.reason;
          }
          this.providerError = providerMessage(details);
          break;
        }
        case 'ToolCall':
          this.providerError = '批改模型返回了意外的工具调用';
          break;
        case 'Done':
          this.done = true;
          break;
        default:
          break;
      }
    }
  }

  complete(cancelled: boolean, transportError: AppError | null): AppError | null {
    const reason = this.diagnostics.finish_reason ?? '';
    let status: GradingCompletionStatus;
    let error: AppError | null = null;
    if (cancelled) {
      status = 'cancelled';
      error = AppError.llm('AI 批改已取消，正式成绩未更新');
    } else if (TRUNCATED_REASONS.includes(reason.toLowerCase())) {
      status = 'truncated';
      error = AppError.llm(
        `AI 批改输出被截断（finish_reason=${reason}，输出上限 ${this.diagnostics.max_output_tokens} token），`
        + '已保留反馈草稿，仍待批改');
    } else if (this.providerError !== null) {
      status = this.providerStatus;
      error = AppError.llm(`批改供应商错误：${this.providerError}；正式成绩未更新`);
      this.providerError = null;
    } else if (transportError !== null) {
      status = transportError.error_type === 'Configuration' || transportError.error_type === 'Validation'
        ? 'configuration_error' : 'transport_error';
      error = transportError;
    } else if (reason !== '' && !COMPLETED_REASONS.includes(reason)) {
      status = 'provider_error';
      error = AppError.llm(`批改供应商异常结束（finish_reason=${reason}），正式成绩未更新`);
    } else if (this.done || COMPLETED_REASONS.includes(reason)) {
      status = 'completed';
    } else {
      status = 'incomplete';
      error = AppError.llm('AI 批改响应异常中断，已保留反馈草稿，仍待批改');
    }
    this.diagnostics.status = status;
    this.diagnostics.error_message = error === null ? null : error.message;
    return error;
  }
}

export type { JsonValue };
