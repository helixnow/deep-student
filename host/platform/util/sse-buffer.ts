/**
 * `dstu-util/src/utf8_stream.rs` + `dstu-util/src/utils/sse_buffer.rs` 的单一共享实现。
 *
 * 这是 L01/L02 流式管线应共同消费的平台实现：
 * - `Utf8StreamDecoder`：跨 chunk 保留不完整 UTF-8 序列，真正非法字节替换为 U+FFFD；
 * - `SseLineBuffer`：按行拆分字符串 chunk，默认上限 10 MiB（Rust `DEFAULT_MAX_BUFFER_SIZE`）；
 * - `SseEventBuffer`：按字节输入、保留 `event:` 元数据、`scan_from` 线性续扫，默认上限 10 MiB；
 * - `extractStreamDataPayload`：SSE `data:` 或多行裸 JSON / `[DONE]` 载荷提取。
 *
 * 日志：Rust 的 `warn!`/`error!` 通过 {@link setSseBufferLogger} 注入 Cordis logger，
 * 只记录长度类元数据，绝不记录 chunk/用户文本内容。
 */
import { rustTrim } from './text.ts';
import { decodeUtf8Lossy, utf8ByteLength, validUtf8Prefix } from './utf8.ts';

/** Rust `DEFAULT_MAX_BUFFER_SIZE`：10 MB。 */
export const DEFAULT_SSE_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export type SseBufferLogLevel = 'warn' | 'error';
export type SseBufferLogger = (level: SseBufferLogLevel, message: string) => void;
/** 解除绑定；仅当当前 logger 仍是本次设置的那个时才清空。 */
export type SseBufferLoggerDisposer = () => void;

let sseBufferLogger: SseBufferLogger | null = null;

/**
 * 注入平台 logger（生产由 `dstu.platform.log` 插件在 apply 时调用）。
 *
 * 与 Rust `tracing` 全局 subscriber 同范围：一个 Host 进程一个 logger。返回的 disposer
 * 带身份校验，只清空自己设置的绑定；多个 Host/测试宿主先后绑定、其中一个卸载时，
 * 不会误清另一个消费者。
 */
export function setSseBufferLogger(logger: SseBufferLogger | null): SseBufferLoggerDisposer {
  sseBufferLogger = logger;
  return () => {
    if (sseBufferLogger === logger) sseBufferLogger = null;
  };
}

function log(level: SseBufferLogLevel, message: string): void {
  sseBufferLogger?.(level, message);
}

function byteLength(value: string): number {
  return utf8ByteLength(value);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * Rust `str::lines()`：按 `\n` 分割、去掉每行末尾 `\r`，末尾换行不产生空行。
 */
function rustLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** 跨 chunk 增量 UTF-8 解码器（Rust `Utf8StreamDecoder`）。 */
export class Utf8StreamDecoder {
  private pending = new Uint8Array(0);

  /** 解码一个字节 chunk；末尾不完整序列保留到下一次调用。 */
  decode(chunk: Uint8Array): string {
    const pendingLenBefore = this.pending.length;
    const bytes = concatBytes(this.pending, chunk);
    this.pending = new Uint8Array(0);

    let out = '';
    let pos = 0;
    for (;;) {
      const slice = bytes.subarray(pos);
      const invalid = validUtf8Prefix(slice);
      if (invalid === null) {
        out += decodeUtf8Lossy(slice);
        break;
      }
      const valid = invalid.validUpTo;
      out += decodeUtf8Lossy(slice.subarray(0, valid));
      if (invalid.errorLength === null) {
        this.pending = Uint8Array.from(slice.subarray(valid));
        break;
      }
      log(
        'warn',
        `[utf8_stream][issue#122 探针] 遇到非法 UTF-8 字节序列，已替换为 U+FFFD：invalid_len=${invalid.errorLength}, valid_up_to=${valid}, pos=${pos}, pending_len_before=${pendingLenBefore}, chunk_len=${chunk.length}`,
      );
      out += '\uFFFD';
      pos += valid + invalid.errorLength;
    }
    return out;
  }

  /** 流结束后冲刷残留；不完整序列按 lossy 语义返回一个 U+FFFD。 */
  flush(): string {
    if (this.pending.length === 0) return '';
    log(
      'warn',
      `[utf8_stream][issue#122 探针] flush 时仍有不完整多字节序列，按 lossy 语义替换为 U+FFFD：pending_len=${this.pending.length}`,
    );
    this.pending = new Uint8Array(0);
    return '\uFFFD';
  }

  /** 是否有未消费的残留字节。 */
  hasPending(): boolean {
    return this.pending.length > 0;
  }
}

/** SSE 行缓冲（Rust `SseLineBuffer`）。 */
export class SseLineBuffer {
  private buffer = '';
  private readonly maxBufferSize: number;

  constructor(maxBufferSize = DEFAULT_SSE_MAX_BUFFER_SIZE) {
    this.maxBufferSize = maxBufferSize;
  }

  /** 处理新到达的字符串 chunk，返回完整行。 */
  processChunk(chunk: string): string[] {
    if (byteLength(this.buffer) + byteLength(chunk) > this.maxBufferSize) {
      log(
        'error',
        `SSE缓冲区超过大小上限，丢弃数据以防OOM：buffer_len=${byteLength(this.buffer)}, chunk_len=${byteLength(chunk)}, max=${this.maxBufferSize}`,
      );
      this.buffer = '';
      return [];
    }

    this.buffer += chunk;
    const lines = rustLines(this.buffer);
    if (lines.length === 0) return [];

    if (this.buffer.endsWith('\n')) {
      this.buffer = '';
      return lines;
    }

    if (lines.length > 1) {
      this.buffer = lines[lines.length - 1]!;
      return lines.slice(0, -1);
    }
    return [];
  }

  /** 检查缓冲区是否有剩余数据。 */
  hasRemaining(): boolean {
    return this.buffer !== '';
  }

  /** 获取剩余的不完整行（用于最终处理）。 */
  flush(): string | null {
    if (this.buffer === '') return null;
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }

  /** 检查是否遇到结束标记（兼容 `data:[DONE]`）。 */
  static checkDoneMarker(line: string): boolean {
    const trimmed = rustTrim(line);
    return trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]';
  }

  /** 清空缓冲区。 */
  clear(): void {
    this.buffer = '';
  }
}

/** 字节级 SSE 事件缓冲（Rust `SseEventBuffer`）。 */
export class SseEventBuffer {
  private readonly decoder = new Utf8StreamDecoder();
  private textBuffer = '';
  private textBufferBytes = 0;
  private scanFrom = 0;
  private pendingLines: string[] = [];
  private pendingSize = 0;
  private readonly maxBufferSize: number;

  constructor(maxBufferSize = DEFAULT_SSE_MAX_BUFFER_SIZE) {
    this.maxBufferSize = maxBufferSize;
  }

  /** 输入任意网络字节 chunk，返回完整 SSE 事件块。 */
  processBytes(chunk: Uint8Array): string[] {
    if (this.textBufferBytes + this.pendingSize + chunk.length > this.maxBufferSize) {
      log(
        'error',
        `SSE event buffer exceeded size limit; dropping buffered data：text_buffer_len=${this.textBufferBytes}, pending_size=${this.pendingSize}, chunk_len=${chunk.length}, max=${this.maxBufferSize}`,
      );
      this.clear();
      return [];
    }

    const oldLength = this.textBuffer.length;
    const decoded = this.decoder.decode(chunk);
    this.textBuffer += decoded;
    this.textBufferBytes += byteLength(decoded);
    this.scanFrom = Math.min(this.scanFrom, oldLength);
    if (this.scanFrom === oldLength && !decoded.includes('\n')) {
      this.scanFrom = this.textBuffer.length;
      return [];
    }

    const events: string[] = [];
    let handled = 0;
    for (;;) {
      const newline = this.textBuffer.indexOf('\n', this.scanFrom);
      if (newline < 0) {
        this.scanFrom = this.textBuffer.length;
        break;
      }
      let line = this.textBuffer.slice(handled, newline);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.pushLine(line, events);
      this.scanFrom = newline + 1;
      handled = newline + 1;
    }

    if (handled > 0) {
      this.textBufferBytes -= byteLength(this.textBuffer.slice(0, handled));
      this.textBuffer = this.textBuffer.slice(handled);
      this.scanFrom = Math.max(0, this.scanFrom - handled);
    }
    return events;
  }

  /** 流结束但无尾部空行时冲刷剩余事件。 */
  flush(): string[] {
    const tail = this.decoder.flush();
    if (tail !== '') {
      log(
        'warn',
        `[sse_buffer][issue#122 探针] 流结束时残留不完整 UTF-8 序列，已按 lossy 语义补 U+FFFD：tail_len=${tail.length}, text_buffer_len=${byteLength(this.textBuffer)}, pending_lines=${this.pendingLines.length}`,
      );
    }
    this.textBuffer += tail;
    const events: string[] = [];
    if (this.textBuffer !== '') {
      let line = this.textBuffer;
      this.textBuffer = '';
      this.textBufferBytes = 0;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.pushLine(line, events);
    }
    this.flushPending(events);
    return events;
  }

  /** 事件块中是否含 `[DONE]` / `data: [DONE]` / `data:[DONE]`。 */
  static checkDoneMarker(block: string): boolean {
    return block.split('\n').some(line => {
      const trimmed = rustTrim(line);
      return trimmed === '[DONE]' || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]';
    });
  }

  /** 清空所有缓冲。 */
  clear(): void {
    this.decoder.flush();
    this.textBuffer = '';
    this.textBufferBytes = 0;
    this.scanFrom = 0;
    this.pendingLines = [];
    this.pendingSize = 0;
  }

  private pushLine(line: string, events: string[]): void {
    if (line === '') {
      this.flushPending(events);
      return;
    }

    // 保留旧 JSONL/NDJSON 行为：非 SSE 字段的裸 JSON 行不能与后续行合并。
    if (this.pendingLines.length === 0 && !line.includes(':') && rustTrim(line) === '[DONE]') {
      events.push(line);
      return;
    }
    if (this.pendingLines.length === 0) {
      const firstField = line.includes(':') ? line.slice(0, line.indexOf(':')) : null;
      if (!['event', 'data', 'id', 'retry'].includes(firstField ?? '')) {
        try {
          JSON.parse(rustTrim(line));
          events.push(line);
          return;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }

    // 非规范上游漏掉空行时，新的 event: 行也开启新事件。
    if (line.startsWith('event:') && this.pendingLines.length > 0) this.flushPending(events);
    this.pendingLines.push(line);
    this.pendingSize += byteLength(line) + 1;
    if (this.pendingDataIsComplete()) this.flushPending(events);
  }

  private pendingDataIsComplete(): boolean {
    const data = this.pendingLines
      .filter(line => line.startsWith('data:'))
      .map(line => {
        const value = line.slice(5);
        return value.startsWith(' ') ? value.slice(1) : value;
      });
    if (data.length === 0) return false;
    const payload = data.join('\n');
    if (rustTrim(payload) === '[DONE]') return true;
    try {
      JSON.parse(payload);
      return true;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }

  private flushPending(events: string[]): void {
    if (this.pendingLines.length === 0) return;
    events.push(this.pendingLines.join('\n'));
    this.pendingLines = [];
    this.pendingSize = 0;
  }
}

/**
 * 从 SSE 事件块或裸 JSON/NDJSON 记录中提取载荷。
 * 裸 fallback 仅限合法 JSON 与 `[DONE]`，不会把 SSE 元数据/注释/keep-alive 当数据。
 */
export function extractStreamDataPayload(block: string): string | null {
  const data = block
    .split('\n')
    // Rust `str::lines()` + `trim_end_matches('\r')`：删除行尾全部 CR，不是只删一个。
    .map(line => line.replace(/\r+$/, ''))
    .filter(line => line.startsWith('data:'))
    .map(line => {
      const value = line.slice(5);
      return value.startsWith(' ') ? value.slice(1) : value;
    });
  if (data.length > 0) return data.join('\n');

  const bare = rustTrim(block);
  if (bare === '[DONE]') return bare;
  try {
    JSON.parse(bare);
    return bare;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
