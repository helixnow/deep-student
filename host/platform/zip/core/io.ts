/**
 * ZIP 核心与存储、压缩实现之间的接口，以及内存版实现。只用 Web Streams 与 `Uint8Array`。
 *
 * - 读取需要随机访问（先读文件尾的 EOCD，再按偏移读条目）：`ZipByteSource`；
 * - 写入需要随机访问（条目写完后回填本地头的 CRC 与大小，`zip 0.6.6` 不用数据描述符）：`ZipByteSink`；
 * - 压缩与 CRC：`ZipCodec`，默认用 `CompressionStream` / `DecompressionStream('deflate-raw')`
 *   与纯 JS CRC-32；桌面适配层注入 zlib 实现（可指定压缩级别、原生 CRC）。
 */
import { crc32Update, ZipFormatError } from './format.ts';

export interface ZipByteSource {
  /** 总字节数（打开时确定）。 */
  readonly size: number;
  /** 从 `position` 起读取至多 `length` 字节；只有读到末尾时才返回更短的结果。 */
  read(position: number, length: number): Promise<Uint8Array>;
}

export interface ZipByteSink {
  /** 把 `data` 全部写到 `position`。 */
  write(data: Uint8Array, position: number): Promise<void>;
}

/** 可读可写的一对流（`TransformStream`、`CompressionStream` 等）。 */
export interface ZipTransform {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface ZipCodec {
  /** raw deflate（无 zlib 头）；`level` 省略时为 zlib 默认级别 6（与 `FileOptions::default()` 一致）。 */
  deflateRaw(level?: number): ZipTransform;
  inflateRaw(): ZipTransform;
  /** 增量 CRC-32（IEEE）。 */
  crc32(data: Uint8Array, previous: number): number;
}

/** 标准 Web API 实现：浏览器、WebView、Worker 与 Node 都可用。 */
export const webZipCodec: ZipCodec = {
  deflateRaw(level) {
    if (level !== undefined && level !== 6) {
      throw new RangeError(`CompressionStream cannot set a deflate level (requested ${level}); inject a codec that supports levels`);
    }
    return new CompressionStream('deflate-raw') as ZipTransform;
  },
  inflateRaw() {
    return new DecompressionStream('deflate-raw') as ZipTransform;
  },
  crc32: crc32Update,
};

export type ZipChunkSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

function isReadableStream(source: ZipChunkSource): source is ReadableStream<Uint8Array> {
  return typeof (source as ReadableStream<Uint8Array>).getReader === 'function';
}

/** 把异步/同步可迭代对象（含 Node `Readable`）包成 `ReadableStream`；取消时调用迭代器的 `return`。 */
export function toReadableStream(source: ZipChunkSource): ReadableStream<Uint8Array> {
  if (isReadableStream(source)) return source;
  const iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array> = Symbol.asyncIterator in source
    ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    : (source as Iterable<Uint8Array>)[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  }, { highWaterMark: 0 });
}

/*
 * 以下两个组合子代替 `pipeThrough`/`pipeTo`：Node（实测 v26.5）取消管道链时，即使管道
 * promise 已处理，内部仍会抛出未处理的拒绝，桌面主进程里提前中止解压就会触发。这里只用
 * reader/writer，出错或取消时显式向上游取消、向下游 abort。
 */

/** 逐块观察流：`chunk` 在块交给下游前调用，`end` 在上游结束时调用；任一抛错即取消上游。 */
export function observeStream(
  readable: ReadableStream<Uint8Array>,
  hooks: { chunk?: (chunk: Uint8Array) => void; end?: () => void },
): ReadableStream<Uint8Array> {
  const input = readable.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await input.read();
      try {
        if (done) {
          hooks.end?.();
          controller.close();
        } else {
          hooks.chunk?.(value);
          controller.enqueue(value);
        }
      } catch (error) {
        await input.cancel(error).catch(() => undefined);
        throw error;
      }
    },
    async cancel(reason) {
      await input.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/** 把 `readable` 送入 `transform`（压缩/解压）并返回其输出。 */
export function throughTransform(readable: ReadableStream<Uint8Array>, transform: ZipTransform): ReadableStream<Uint8Array> {
  const input = readable.getReader();
  const writer = transform.writable.getWriter();
  const output = transform.readable.getReader();
  let feeding: Promise<void> | undefined;
  const feed = async (): Promise<void> => {
    try {
      for (;;) {
        const { value, done } = await input.read();
        if (done) {
          await writer.close();
          return;
        }
        await writer.write(value);
      }
    } catch (error) {
      await Promise.allSettled([writer.abort(error), input.cancel(error)]);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      feeding ??= feed();
      const { value, done } = await output.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await Promise.allSettled([output.cancel(reason), writer.abort(reason), input.cancel(reason)]);
    },
  }, { highWaterMark: 0 });
}

/** 读完整个流并拼接（只用于小数据）。 */
export async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 精确读取 `length` 字节；提前到末尾抛 `failed to fill whole buffer`（`read_exact`）。 */
export async function readExactly(source: ZipByteSource, position: number, length: number): Promise<Uint8Array> {
  const bytes = await source.read(position, length);
  if (bytes.length !== length) throw new ZipFormatError('Io', 'failed to fill whole buffer');
  return bytes;
}

/** 区间读取流：每次拉取至多 `chunkSize` 字节；`length` 省略时读到末尾，给定时不足即报错。 */
export function sourceRangeStream(source: ZipByteSource, start: number, length: number | undefined, chunkSize: number): ReadableStream<Uint8Array> {
  let position = start;
  const end = length === undefined ? Number.POSITIVE_INFINITY : start + length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const wanted = Math.min(chunkSize, end - position);
      if (wanted <= 0) {
        controller.close();
        return;
      }
      const bytes = await source.read(position, wanted);
      if (bytes.length === 0) {
        if (length === undefined) controller.close();
        else controller.error(new ZipFormatError('Io', 'failed to fill whole buffer'));
        return;
      }
      position += bytes.length;
      controller.enqueue(bytes);
    },
  }, { highWaterMark: 0 });
}

/** 内存中的 ZIP 源（移动端小归档、测试）。 */
export function memoryZipSource(bytes: Uint8Array): ZipByteSource {
  return {
    size: bytes.length,
    async read(position, length) {
      return bytes.subarray(Math.min(position, bytes.length), Math.min(position + length, bytes.length));
    },
  };
}

/** 内存中的 ZIP 目标：按需扩容；`bytes()` 返回已写出的内容。 */
export class MemoryZipSink implements ZipByteSink {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;

  async write(data: Uint8Array, position: number): Promise<void> {
    const end = position + data.length;
    if (end > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < end) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(data, position);
    if (end > this.length) this.length = end;
  }

  /** 已写出的字节（拷贝）。 */
  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}
